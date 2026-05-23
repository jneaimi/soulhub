/**
 * GET /api/orchestrator/metrics?days=30
 *
 * Returns the WhatsApp ADR-005 falsifier metrics for the dashboard.
 * Days clamped to [1, 365]. Default 30.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getOrchestratorMetrics } from '$lib/orchestrator/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('days');
	const parsed = raw ? Number(raw) : 30;
	const days = Number.isFinite(parsed) ? Math.max(1, Math.min(365, Math.round(parsed))) : 30;
	return json(getOrchestratorMetrics(days));
};
