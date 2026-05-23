import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { killRun, getTask } from '$lib/scheduler/index.js';

/** POST /api/scheduler/cancel — abort an in-flight run.
 *
 *  Body: { taskId: string }
 *
 *  Aborts the task's AbortSignal. Handlers that wired the signal
 *  (shell-script, vault-scout) bail immediately; handlers that ignore
 *  it complete naturally but `recordRun` flags the row as cancelled.
 *
 *  Response: { ok, cancelled }  — cancelled=false when no run is active
 *  for that task (already finished, never started, or wrong id).
 */
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

	const cancelled = killRun(taskId);
	return json({ ok: true, cancelled });
};
