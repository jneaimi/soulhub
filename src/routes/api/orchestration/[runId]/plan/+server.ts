import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, saveRun, savePlan } from '$lib/orchestration/board.js';
import { generatePlan, approveAndStart } from '$lib/orchestration/conductor.js';
import type { OrchestrationPlan } from '$lib/orchestration/types.js';
import { getRunEmitter } from '$lib/orchestration/events.js';

/** POST /api/orchestration/[runId]/plan — set the plan */
export const POST: RequestHandler = async ({ params, request }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (run.status !== 'planning') {
		return json({ error: `Cannot set plan when status is ${run.status}` }, { status: 400 });
	}

	const body = await request.json();
	const plan = body.plan as OrchestrationPlan;

	if (!plan || !plan.tasks || plan.tasks.length === 0) {
		return json({ error: 'Plan must have at least one task' }, { status: 400 });
	}

	run.plan = plan;
	await saveRun(run);
	await savePlan(run);

	return json({ ok: true, run });
};

/** PATCH /api/orchestration/[runId]/plan — spawn PM session for plan generation */
export const PATCH: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	// Allow PM spawn in planning (normal) and running/failed (advisor mode)
	if (!['planning', 'running', 'failed'].includes(run.status)) {
		return json({ error: `Cannot spawn PM when status is ${run.status}` }, { status: 400 });
	}

	try {
		const { sessionId } = await generatePlan(params.runId);
		return json({ ok: true, sessionId });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Plan generation failed';
		return json({ error: message }, { status: 500 });
	}
};

/** PUT /api/orchestration/[runId]/plan — approve and start (SSE stream) */
export const PUT: RequestHandler = async ({ params, request }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (run.status !== 'planning') {
		return json({ error: `Cannot approve plan when status is ${run.status}` }, { status: 400 });
	}

	if (!run.plan.tasks || run.plan.tasks.length === 0) {
		return json({ error: 'No plan to approve — set a plan first' }, { status: 400 });
	}

	// Get the emitter BEFORE approveAndStart runs so we don't miss early events
	const emitter = getRunEmitter(params.runId);
	const enc = new TextEncoder();
	const tasksCount = run.plan.tasks.length;

	const stream = new ReadableStream({
		start(controller) {
			let closed = false;

			function safeEnqueue(chunk: Uint8Array) {
				if (!closed) {
					try { controller.enqueue(chunk); } catch { /* already closed */ }
				}
			}

			function safeClose() {
				if (!closed) {
					closed = true;
					clearInterval(heartbeat);
					emitter.removeListener('worker_dispatched', onDispatched);
					emitter.removeListener('worker_output', onOutput);
					emitter.removeListener('worker_exit', onExit);
					emitter.removeListener('run_status', onStatus);
					try { controller.close(); } catch { /* already closed */ }
				}
			}

			function send(event: string, data: unknown) {
				safeEnqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			}

			// Send initial approved event
			send('approved', { runId: params.runId, tasksCount });

			const heartbeat = setInterval(() => {
				safeEnqueue(enc.encode(': heartbeat\n\n'));
			}, 15_000);

			function onDispatched(data: { taskId: string; workerId: string }) {
				send('worker_dispatched', data);
			}

			function onOutput(data: { taskId: string; data: string }) {
				send('worker_output', data);
			}

			function onExit(data: { taskId: string; exitCode: number }) {
				send('worker_exit', data);
			}

			function onStatus(data: { status: string }) {
				send('run_status', data);
				if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
					safeEnqueue(enc.encode('data: [DONE]\n\n'));
					safeClose();
				}
			}

			emitter.on('worker_dispatched', onDispatched);
			emitter.on('worker_output', onOutput);
			emitter.on('worker_exit', onExit);
			emitter.on('run_status', onStatus);

			request.signal.addEventListener('abort', () => {
				closed = true;
				clearInterval(heartbeat);
				emitter.removeListener('worker_dispatched', onDispatched);
				emitter.removeListener('worker_output', onOutput);
				emitter.removeListener('worker_exit', onExit);
				emitter.removeListener('run_status', onStatus);
			});

			// Kick off real worker dispatch. Fires events into the emitter as
			// workers spawn, produce output, and exit.
			approveAndStart(params.runId).catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				send('run_status', { status: 'failed', error: message });
				safeEnqueue(enc.encode('data: [DONE]\n\n'));
				safeClose();
			});
		},
		cancel() {
			// Run stays alive — client can reconnect by polling GET
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		},
	});
};
