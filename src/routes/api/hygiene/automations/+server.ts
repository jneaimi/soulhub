import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runHistory, type RunStatus } from '$lib/scheduler/db.js';
import { HEALTH_AUTOMATIONS } from '$lib/vault-hygiene/automation-registry.js';

/** GET /api/hygiene/automations — per-automation health for the ADR-004
 *  dashboard. For each curated health automation, joins the registry metadata
 *  against `scheduler_runs` history.
 *
 *  Phase 1 reports last-fired, last-status, recent run statuses, and an anomaly
 *  rate. The `falsifier` field is null on every row — ADR-003 P1 falsifier
 *  reporting is not instrumented until ADR-004 Phase 3, and the dashboard renders
 *  it as "not yet instrumented" rather than implying a green/blind signal that
 *  doesn't exist. */

const WINDOW = 20; // recent runs considered for status/anomaly rate

/** ADR-004 P3 falsifier status: did the automation run within its window? */
type FalsifierStatus = 'ok' | 'stale' | 'unknown';

interface AutomationHealth {
	taskId: string;
	label: string;
	category: string;
	purpose: string;
	lastFiredAt: string | null;
	lastStatus: RunStatus | null;
	/** Most-recent-first run statuses, capped at 8 for a compact strip. */
	recentStatuses: RunStatus[];
	/** Fraction of the last WINDOW runs that errored or skipped (0..1). */
	anomalyRate: number;
	runsInWindow: number;
	/** ADR-004 P3 falsifier: 'ok' ran within its window, 'stale' silently
	 *  stopped (blind — the ADR-002 failure class), 'unknown' never ran. */
	falsifier: FalsifierStatus;
	/** The staleness window used, for dashboard tooltip context. */
	expectedMaxStaleHours: number;
}

export const GET: RequestHandler = async () => {
	const automations: AutomationHealth[] = HEALTH_AUTOMATIONS.map((a) => {
		const history = runHistory(a.taskId, WINDOW); // most-recent-first
		const last = history[0];
		const bad = history.filter((r) => r.status === 'error' || r.status === 'overlap-skipped').length;
		// Falsifier: has it RUN within its expected window? A stale automation has
		// silently stopped — the blindness ADR-002 caught by hand.
		let falsifier: FalsifierStatus;
		if (!last) {
			falsifier = 'unknown';
		} else {
			const ageHours = (Date.now() - new Date(last.startedAt).getTime()) / 3_600_000;
			falsifier = ageHours > a.expectedMaxStaleHours ? 'stale' : 'ok';
		}
		return {
			taskId: a.taskId,
			label: a.label,
			category: a.category,
			purpose: a.purpose,
			lastFiredAt: last?.startedAt ?? null,
			lastStatus: last?.status ?? null,
			recentStatuses: history.slice(0, 8).map((r) => r.status),
			anomalyRate: history.length > 0 ? bad / history.length : 0,
			runsInWindow: history.length,
			falsifier,
			expectedMaxStaleHours: a.expectedMaxStaleHours,
		};
	});

	return json({
		generatedAt: new Date().toISOString(),
		window: WINDOW,
		falsifierInstrumented: true, // ADR-004 Phase 3 — cadence-staleness falsifier live
		automations,
	});
};
