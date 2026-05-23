/**
 * Edge-triggered Telegram alerts for the Layer 2 filter worker.
 *
 * Mirrors the per-account sync notifications pattern (notifications.ts) but
 * keys on a single 'filter-worker' identifier — there's only one worker.
 *
 * Strategy:
 *   - Failure: notify the FIRST time the worker enters a failed state.
 *     Subsequent failures of the same class are silent until recovery.
 *   - Recovery: notify the FIRST successful tick after a prior failure
 *     alert. Paired with the failure alert → exactly two messages per
 *     outage incident.
 *
 * Best-effort: Telegram errors log a warning, never throw. State is in-memory,
 * so a PM2 restart re-arms the alert (correct — the operator should be
 * re-alerted if the issue is still active after restart).
 *
 * See ADR §D-Alerts.
 */

import { send as sendTelegram } from '../channels/telegram/index.js';

export type FilterFailureClass = 'auth' | 'rate-limit' | 'persistent' | 'binary-missing';

let alerted = false;

export function markFilterFailed(classification: FilterFailureClass, reason: string): void {
	if (alerted) return;
	alerted = true;

	const text = [
		`🔴 *Inbox Layer 2 filter failed*`,
		`*Class:* \`${classification}\``,
		``,
		`${truncate(reason, 240)}`,
		``,
		classification === 'auth'
			? '_Fix: run `claude` interactively once on the PM2 host to authenticate. The worker will keep running rules-only._'
			: classification === 'binary-missing'
				? '_Fix: install Claude Code (`npm i -g @anthropic-ai/claude-code`) or point `paths.claudeBinary` at the right binary._'
				: classification === 'rate-limit'
					? '_Auto-recovery: backing off. Will retry as quota frees up._'
					: '_Auto-recovery on next successful classification._',
	].join('\n');

	void sendBestEffort(text, 'failed');
}

export function markFilterRecovered(): void {
	if (!alerted) return;
	alerted = false;

	const text = '🟢 *Inbox Layer 2 filter recovered.* Classifier is back online.';
	void sendBestEffort(text, 'recovered');
}

/** Diagnostic — returns the current alert state. Used by /api/inbox/filter/stats. */
export function isFilterAlerted(): boolean {
	return alerted;
}

async function sendBestEffort(text: string, label: 'failed' | 'recovered'): Promise<void> {
	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(`[inbox-filter-notify] telegram send failed (${label}): ${result.error}`);
		}
	} catch (err) {
		console.warn(`[inbox-filter-notify] telegram send threw (${label}): ${(err as Error).message}`);
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
