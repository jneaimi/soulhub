import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSystemHealth } from '$lib/system/index.js';

/**
 * GET /api/system/notifications — list notifications
 *   ?active=true  — only active (default)
 *   ?all=true     — include dismissed/resolved
 *   ?limit=50     — max results
 */
export const GET: RequestHandler = async ({ url }) => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	const showAll = url.searchParams.get('all') === 'true';
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);

	const notifications = showAll
		? health.notifications.getAll(limit)
		: health.notifications.getActive();

	return json({ notifications, activeCount: health.notifications.activeCount });
};

/**
 * PATCH /api/system/notifications — dismiss or resolve a notification
 *   { id, action: "dismiss" }
 *   { id, action: "resolve", actionId, result }
 */
export const PATCH: RequestHandler = async ({ request }) => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { id, action, actionId, result } = body as {
		id?: string;
		action?: string;
		actionId?: string;
		result?: string;
	};

	if (!id || typeof id !== 'string') {
		return json({ error: 'id is required' }, { status: 400 });
	}

	const notification = health.notifications.get(id);
	if (!notification) {
		return json({ error: `Notification "${id}" not found` }, { status: 404 });
	}

	if (action === 'dismiss') {
		health.notifications.dismiss(id);
		await health.notifications.save();
		return json({ ok: true, notification: health.notifications.get(id) });
	}

	if (action === 'resolve') {
		if (!actionId || !result) {
			return json({ error: 'actionId and result are required for resolve' }, { status: 400 });
		}
		health.notifications.resolve(id, actionId, result);
		await health.notifications.save();
		return json({ ok: true, notification: health.notifications.get(id) });
	}

	return json({ error: 'action must be "dismiss" or "resolve"' }, { status: 400 });
};
