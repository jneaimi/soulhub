import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadMeta, readLogTail, deleteSession } from '$lib/pty/store.js';
import { isAlive } from '$lib/pty/manager.js';

/** GET /api/sessions/{id} — get session detail + log tail */
export const GET: RequestHandler = async ({ params, url }) => {
	const meta = loadMeta(params.id);
	if (!meta) {
		return json({ error: 'Session not found' }, { status: 404 });
	}

	const logBytes = Number(url.searchParams.get('logBytes') || '32768');
	const log = readLogTail(params.id, logBytes);
	const alive = isAlive(params.id);

	// If meta says running but process is dead, fix the status
	if (meta.status === 'running' && !alive) {
		meta.status = 'exited';
		meta.endedAt = meta.endedAt || new Date().toISOString();
	}

	return json({ ...meta, alive, log });
};

/** DELETE /api/sessions/{id} — delete a session's data */
export const DELETE: RequestHandler = async ({ params }) => {
	const deleted = deleteSession(params.id);
	if (!deleted) {
		return json({ error: 'Session not found' }, { status: 404 });
	}
	return json({ ok: true });
};
