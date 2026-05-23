/**
 * POST /api/agents/[id]/test — chat-to-test runner.
 *
 * Streams NDJSON of `DispatchEvent`s. Each line is one JSON object terminated
 * by `\n`. The final event is `{ type: 'done', result: DispatchResult }`.
 *
 * Default `mode: 'test'` — applies hard caps per ADR-001 §6 (max $0.10, 5
 * turns, 60s) so a curious user can't burn through real spend by hammering
 * the chat panel.
 *
 * Pass `?mode=production` to dispatch against the agent's real budget —
 * routes through the same path as a chat-triggered dispatch and respects
 * `goal_condition` on PTY-backed agents (ADR-031). This replaced the
 * temporary `/api/debug/dispatch` endpoint — the operator UI now provides
 * the mode toggle visibly instead of forcing curl-with-a-token.
 */

import { error, type RequestHandler } from '@sveltejs/kit';
import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import type { DispatchMode } from '$lib/agents/dispatch/types.js';
import { getAgent } from '$lib/agents/store.js';

export const POST: RequestHandler = async ({ params, request, url }) => {
	const id = params.id;
	if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw error(400, 'invalid agent id');
	}

	const agent = getAgent(id);
	if (!agent) throw error(404, `agent '${id}' not found`);

	const body = (await request.json().catch(() => ({}))) as { task?: unknown; subject?: unknown };
	const task = typeof body.task === 'string' ? body.task.trim() : '';
	if (!task) throw error(400, 'task is required (non-empty string)');
	if (task.length > 4000) throw error(400, 'task too long (max 4000 chars)');
	// projects-graph ADR-018 S2b — optional vault artifact this run works on.
	const subjectPath =
		typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : undefined;

	const modeParam = url.searchParams.get('mode');
	const mode: DispatchMode =
		modeParam === 'production' ? 'production' : 'test';

	const ac = new AbortController();
	request.signal.addEventListener('abort', () => ac.abort());

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (line: string) => {
				try {
					controller.enqueue(encoder.encode(line + '\n'));
				} catch {
					/* downstream closed */
				}
			};

			try {
				const gen = dispatchAgent(id, task, { mode, signal: ac.signal, subjectPath });
				while (true) {
					const next = await gen.next();
					if (next.done) {
						send(JSON.stringify({ type: 'done', result: next.value, ts: Date.now() }));
						break;
					}
					send(JSON.stringify(next.value));
				}
			} catch (err) {
				send(
					JSON.stringify({
						type: 'error',
						message: (err as Error).message ?? 'dispatch failed',
						ts: Date.now(),
					}),
				);
			} finally {
				controller.close();
			}
		},
		cancel() {
			ac.abort();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Accel-Buffering': 'no',
		},
	});
};
