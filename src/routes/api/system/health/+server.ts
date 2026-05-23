import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSystemHealth, buildDigestMessage } from '$lib/system/index.js';

/**
 * GET /api/system/health — get last health report + active notification count.
 * Includes a `digestPreview` showing the would-be Telegram message body for
 * the last report, or null when the digest would be silent.
 */
export const GET: RequestHandler = async () => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	const report = health.getLastReport();
	const previous = health.getPreviousReport();
	return json({
		report,
		activeNotifications: health.notifications.activeCount,
		digestPreview: report ? buildDigestMessage(report, previous) : null,
	});
};

/**
 * POST /api/system/health — force a health check now
 */
export const POST: RequestHandler = async () => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	const report = await health.forceCheck();
	const previous = health.getPreviousReport();
	return json({
		report,
		activeNotifications: health.notifications.activeCount,
		digestPreview: buildDigestMessage(report, previous),
	});
};
