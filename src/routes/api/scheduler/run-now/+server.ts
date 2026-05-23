import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runNow, getTask } from '$lib/scheduler/index.js';

/** POST /api/scheduler/run-now — fire a registered task immediately.
 *
 *  Body: { taskId: string }
 *
 *  Goes through the same `recordRun` wrapper as cron-driven runs, so
 *  the result lands in `scheduler_runs` as a normal entry (the
 *  trigger column will read 'manual' if we extend recordRun later;
 *  for now scheduledFor is the runNow time).
 *
 *  Response: { ok, status, durationMs, output?, error? }
 *
 *  Phase 3 utility — used to verify the project-hygiene migration
 *  end-to-end. Authorization piggybacks the existing same-origin /
 *  Bearer pattern enforced by hooks.server.ts on /api/files. */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Body must be JSON.' }, { status: 400 });
	}
	if (typeof body !== 'object' || body === null) {
		return json({ error: 'Body must be an object.' }, { status: 400 });
	}
	const taskId = (body as { taskId?: unknown }).taskId;
	if (typeof taskId !== 'string' || taskId.length === 0) {
		return json({ error: 'taskId is required (non-empty string).' }, { status: 400 });
	}
	if (!getTask(taskId)) {
		return json({ error: `Unknown task: ${taskId}` }, { status: 404 });
	}

	const result = await runNow(taskId);
	return json({ ok: result.status === 'success', ...result });
};
