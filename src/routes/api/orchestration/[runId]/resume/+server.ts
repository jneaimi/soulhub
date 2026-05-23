import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun } from '$lib/orchestration/board.js';
import { resumeRun } from '$lib/orchestration/conductor.js';
import { getRunEmitter } from '$lib/orchestration/events.js';

/** POST /api/orchestration/[runId]/resume — resume an interrupted run (SSE) */
export const POST: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (run.status !== 'failed') {
		return json(
			{ error: `Cannot resume run in status: ${run.status}` },
			{ status: 400 },
		);
	}

	const hasInterrupted = Object.entries(run.workers).some(
		([id, w]) => id !== '_pm' && w.status === 'interrupted',
	);

	if (!hasInterrupted) {
		return json({ error: 'No interrupted workers to resume' }, { status: 400 });
	}

	const emitter = getRunEmitter(params.runId);

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send(event: string, data: unknown): void {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			}

			const onDispatched = (d: unknown) => send('worker_dispatched', d);
			const onOutput = (d: unknown) => send('worker_output', d);
			const onExit = (d: unknown) => send('worker_exit', d);
			const onStatus = (d: unknown) => {
				send('run_status', d);
				const status = (d as { status: string }).status;
				if (status === 'done' || status === 'failed' || status === 'cancelled') {
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					cleanup();
					controller.close();
				}
			};

			emitter.on('worker_dispatched', onDispatched);
			emitter.on('worker_output', onOutput);
			emitter.on('worker_exit', onExit);
			emitter.on('run_status', onStatus);

			function cleanup(): void {
				emitter.off('worker_dispatched', onDispatched);
				emitter.off('worker_output', onOutput);
				emitter.off('worker_exit', onExit);
				emitter.off('run_status', onStatus);
			}

			send('resumed', { runId: params.runId });

			resumeRun(params.runId).catch((err) => {
				send('error', { message: (err as Error).message });
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				cleanup();
				controller.close();
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};
