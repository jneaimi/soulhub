/**
 * GET /api/recipes/runs/[run_id]/events — Server-Sent Events stream for a
 * recipe run (ADR-018 v1).
 *
 * Lifecycle:
 *   1. Subscriber connects.
 *   2. Server emits `event: meta` with `{ schema_version, runId, replay: <count> }`.
 *   3. Server replays any buffered events for live runs (ring buffer, last 200).
 *   4. Server forwards new events as they fire.
 *   5. For finished/cleared runs, server synthesises terminal events from
 *      `naseej_runs` (the persistent index from ADR-021) so a late connect
 *      still gets a coherent end-of-stream.
 *   6. Server closes on client abort or after a terminal event (+ 1s flush).
 *
 * Heartbeats every 30s keep proxies from timing out (mirrors
 * /api/vault/events).
 */
import type { RequestHandler } from './$types';
import { getRunByRunId, type NaseejRunRow } from '$lib/naseej/audit.js';
import {
	subscribe,
	NASEEJ_EVENT_SCHEMA_VERSION,
	type NaseejEvent,
} from '$lib/naseej/events.js';

const TERMINAL_TYPES = new Set([
	'recipe_complete',
	'recipe_failed',
	'recipe_cancelled',
]);

/** Construct synthetic events from a finished run's persisted row so that
 *  late SSE subscribers (after the in-memory bus cleared) can still get a
 *  coherent stream that terminates correctly. */
function synthesiseFromRow(row: NaseejRunRow): NaseejEvent[] {
	const out: NaseejEvent[] = [];
	out.push({
		type: 'recipe_start',
		runId: row.runId,
		recipe: row.recipe,
		recipeVersion: row.recipeVersion,
		project: row.project,
		mode: row.mode,
		source: row.source,
		ts: row.startedAt,
	});
	if (row.stepsJson) {
		try {
			const steps = JSON.parse(row.stepsJson) as Array<{
				id: string;
				kind: 'component' | 'agent';
				exit_code: number;
				duration_ms: number;
				error?: string;
			}>;
			for (const s of steps) {
				out.push({ type: 'step_start', runId: row.runId, stepId: s.id, stepKind: s.kind, ts: row.startedAt });
				if (s.exit_code === 0) {
					out.push({
						type: 'step_complete',
						runId: row.runId,
						stepId: s.id,
						exitCode: s.exit_code,
						durationMs: s.duration_ms,
						ts: row.startedAt,
					});
				} else {
					out.push({
						type: 'step_failed',
						runId: row.runId,
						stepId: s.id,
						exitCode: s.exit_code,
						durationMs: s.duration_ms,
						...(s.error ? { error: s.error } : {}),
						ts: row.startedAt,
					});
				}
			}
		} catch {
			// steps_json malformed — emit only the run-level terminal.
		}
	}
	const finishedAt = row.finishedAt ?? row.startedAt;
	const durationMs = row.durationMs ?? 0;
	if (row.status === 'cancelled') {
		out.push({ type: 'recipe_cancelled', runId: row.runId, durationMs, ...(row.failedStep ? { failedStep: row.failedStep } : {}), ts: finishedAt });
	} else if (row.status === 'failed') {
		out.push({
			type: 'recipe_failed',
			runId: row.runId,
			durationMs,
			...(row.failedStep ? { failedStep: row.failedStep } : {}),
			...(row.error ? { error: row.error } : {}),
			ts: finishedAt,
		});
	} else if (row.status === 'success') {
		out.push({ type: 'recipe_complete', runId: row.runId, durationMs, ts: finishedAt });
	}
	return out;
}

export const GET: RequestHandler = async ({ params, request }) => {
	const runId = params.run_id;
	if (!runId) {
		return new Response('runId required', { status: 400 });
	}

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const send = (eventName: string, payload: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`),
					);
				} catch {
					closed = true;
				}
			};

			// Subscribe FIRST so we don't miss an event that fires between
			// the meta send and the buffer replay.
			const sub = subscribe(runId, (event) => {
				send(event.type, event);
				if (TERMINAL_TYPES.has(event.type)) {
					// Drain + close shortly after terminal so the client gets
					// the final frame before the connection drops.
					setTimeout(() => {
						if (!closed) {
							closed = true;
							try { controller.close(); } catch { /* */ }
						}
					}, 1000);
				}
			});

			send('meta', {
				schema_version: NASEEJ_EVENT_SCHEMA_VERSION,
				runId,
				replay: sub.replay.length,
				terminated: sub.terminated,
			});

			// Replay buffered events first (ordering preserved).
			for (const event of sub.replay) {
				send(event.type, event);
			}

			// If the bus has no record (either never lived, or already cleared),
			// fall back to the persisted row from naseej_runs.
			if (sub.replay.length === 0 && !sub.terminated) {
				const row = getRunByRunId(runId);
				if (row) {
					const synthetic = synthesiseFromRow(row);
					for (const event of synthetic) {
						send(event.type, event);
					}
					setTimeout(() => {
						if (!closed) {
							closed = true;
							try { controller.close(); } catch { /* */ }
						}
					}, 1000);
				}
			}

			const heartbeat = setInterval(() => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { closed = true; }
			}, 30_000);

			request.signal.addEventListener('abort', () => {
				closed = true;
				clearInterval(heartbeat);
				sub.unsubscribe();
				try { controller.close(); } catch { /* */ }
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
};
