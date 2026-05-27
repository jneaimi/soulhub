/** Heartbeat-driven hygiene tick — deterministic janitor pass (ADR-008).
 *
 *  Called from `src/lib/channels/whatsapp/heartbeat.ts` every 30 min
 *  (also schedulable directly via `scheduler/handlers/vault-hygiene.ts`).
 *  Independent of the LLM heartbeat path — we run regardless of active
 *  hours / mute, because janitor auto-fixes and escalations are silent
 *  unless something is actually wrong.
 *
 *  Flow (ADR-008 replacement):
 *    1. Build report via getHygieneReport()
 *    2. Compare totals to threshold; if not actionable → return 'clean'
 *    3. Time-based cooldown; if still within window → return 'cooldown'
 *    4. Run deterministic janitor pass (Job A — no LLM, no agent):
 *          orphans → add to nearest index.md
 *          stale-inbox (valid type) → move to canonical zone
 *          derivable governance fields → backfill
 *    5. Update in-memory state with new timestamp
 *
 *  Job B (dead-link retarget, ambiguous-misplaced, flip-vs-tick) is
 *  handled by the PTY `hygiene-fixer` agent (ADR-007) on demand.
 *  Job C (escalate / daily digest) is already deterministic and stays.
 *
 *  In-memory state resets on PM2 restart. That's acceptable: a restart
 *  re-running the janitor once on the same issue is safe and $0.
 */

import { getHygieneReport } from './report.js';
import { runJanitorPass } from './janitor.js';
import type { JanitorResult } from './janitor.js';
import { DEFAULT_HYGIENE_THRESHOLD } from './types.js';
import type { HygieneReport, HygieneThreshold } from './types.js';

/** Time-based cooldown only. One janitor pass per cooldown window regardless
 *  of which issues drift in or out. 30 min matches the heartbeat cadence so
 *  we run roughly once per tick when there's actionable work. */
const COOLDOWN_MS = 30 * 60 * 1000;

interface DispatchState {
	lastDispatchAt: number;
}

let state: DispatchState | null = null;

/** In-flight guard. Without this, two concurrent ticks (e.g. heartbeat
 *  fires at 30:00 while a manual `/api/vault/hygiene/tick` is still
 *  running) would both dispatch — the cooldown state isn't set until the
 *  first run returns. */
let inFlight: Promise<HygieneTickResult> | null = null;

export interface HygieneTickResult {
	status: 'no-engine' | 'clean' | 'cooldown' | 'janitor-ran' | 'error';
	report?: HygieneReport;
	janitorResult?: JanitorResult;
	error?: string;
}

export async function tickVaultHygiene(
	threshold: HygieneThreshold = DEFAULT_HYGIENE_THRESHOLD,
): Promise<HygieneTickResult> {
	if (inFlight) {
		console.log('[vault-hygiene/tick] already running — coalescing to in-flight call');
		return inFlight;
	}
	inFlight = runTick(threshold).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runTick(threshold: HygieneThreshold): Promise<HygieneTickResult> {
	let report: HygieneReport;
	try {
		report = await getHygieneReport();
	} catch (err) {
		const msg = (err as Error).message;
		console.warn(`[vault-hygiene/tick] report failed: ${msg}`);
		return { status: msg.includes('not initialized') ? 'no-engine' : 'error', error: msg };
	}

	if (!isActionable(report, threshold)) {
		return { status: 'clean', report };
	}

	if (state && Date.now() - state.lastDispatchAt < COOLDOWN_MS) {
		const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - state.lastDispatchAt)) / 60_000);
		console.log(`[vault-hygiene/tick] cooldown ${remainingMin}m — last janitor pass was recent`);
		return { status: 'cooldown', report };
	}

	// ADR-008 step 2 — deterministic janitor replaces keeper agent dispatch.
	// Runs synchronously (no generator drain) since it's pure code, not an LLM.
	try {
		const janitorResult = await runJanitorPass(report);
		state = { lastDispatchAt: Date.now() };
		console.log(`[vault-hygiene/tick] janitor ran: ${janitorResult.summary}`);
		// ADR-005 P1 cutover — per-tick Telegram escalation is retired.
		// Notification rides the once-daily `hygiene-digest` scheduler task.
		// The janitor only auto-fixes; escalation is the digest's job.
		return { status: 'janitor-ran', report, janitorResult };
	} catch (err) {
		const msg = (err as Error).message;
		console.warn(`[vault-hygiene/tick] janitor failed: ${msg}`);
		return { status: 'error', error: msg, report };
	}
}

function isActionable(report: HygieneReport, threshold: HygieneThreshold): boolean {
	const t = report.totals;
	if (t.orphans + t.statusContradictions >= threshold.orphansPlusContradictions) return true;
	if (t.staleInbox >= threshold.staleInbox) return true;
	if (t.governanceViolations >= threshold.governanceViolations) return true;
	// Misplaced notes — fire whenever even one HIGH-confidence misplacement
	// is present. Deterministic janitor's job here is fast (just `mv` + reindex),
	// so we don't want to let clutter build up across multiple ticks.
	if (t.misplacedNotes >= 1 && report.misplacedNotes.some(n => n.confidence === 'high')) return true;
	// Inbox decisions — fire when there are aging queued personal mails or
	// stuck-unknown transactional rows. The daily digest surfaces the list to
	// Telegram so the operator can decide (save / archive / reply / mark processed).
	if (t.inboxDecisions >= 1) return true;
	// ADR-009 — implementation drift: code shipped but ADR status stale.
	// Any hit is worth surfacing immediately (detect-only, one-click fix).
	if (t.adrImplementationDrift >= 1) return true;
	return false;
}

/** Test-only — reset the in-memory cooldown state. */
export function _resetHygieneTickState(): void {
	state = null;
	inFlight = null;
}
