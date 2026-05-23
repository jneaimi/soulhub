/**
 * Edge-triggered Telegram notifications for inbox sync health.
 *
 * Wraps `updateAccountStatus` / `updateAccountLastSync` so the notification
 * decision lives next to the state transition that causes it.
 *
 * Strategy:
 *   - Failure: notify the FIRST time an account enters error state. Subsequent
 *     errors are silent until the account recovers. Prevents notification
 *     storms during a flaky-network reconnect loop (cf. the 2026-05-10
 *     reconnect-storm cascade, where the issue was undetected for 7 days
 *     because nobody was looking at the inbox UI).
 *   - Recovery: notify the FIRST time an account transitions back to
 *     connected after we previously alerted on it. Paired with the failure
 *     alert — each "outage incident" produces exactly two messages.
 *
 * Best-effort: Telegram failures log a warning and do nothing else. Sync
 * worker availability is more important than any single notification.
 *
 * State lives in memory: a PM2 restart wipes the alerted set, which is the
 * right behavior — operator should be re-alerted on restart if the issue
 * is still active.
 */

import { send as sendTelegram } from '../channels/telegram/index.js';
import { updateAccountStatus, updateAccountLastSync } from './db.js';
import type { InboxAccount } from './types.js';

const alertedAccounts = new Set<string>();

export function markAccountFailed(account: InboxAccount, error: string): void {
	updateAccountStatus(account.id, 'error', error);
	void notifyAccountFailure(account, error);
}

export function markAccountRecovered(account: InboxAccount): void {
	updateAccountLastSync(account.id);
	if (alertedAccounts.has(account.id)) {
		alertedAccounts.delete(account.id);
		void notifyAccountRecovered(account);
	}
}

/** Drop tracking state for a removed account — prevents the in-memory Set
 *  from growing unboundedly as accounts are added and removed over time. */
export function clearAccountAlert(accountId: string): void {
	alertedAccounts.delete(accountId);
}

async function notifyAccountFailure(account: InboxAccount, error: string): Promise<void> {
	if (alertedAccounts.has(account.id)) return;
	alertedAccounts.add(account.id);

	const lines = [
		`🔴 *Inbox sync failed* — ${account.label}`,
		`\`${account.email}\` (${account.provider})`,
		``,
		`*Error:* ${truncate(error, 200)}`,
		``,
	];

	if (isOAuthRefreshFailure(error)) {
		// Personal Gmail accounts authenticated via an OAuth app in Testing
		// publishing status get their refresh token revoked by Google after
		// 7 days. The fix is a fresh consent flow, which the operator can
		// kick off in one tap from this notification.
		// See: projects/soul-hub-oauth-trust/adr-001-oauth-refresh-resilience.md
		const base = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
		const reauthUrl = `${base}/api/inbox/oauth?account=${encodeURIComponent(account.id)}`;
		lines.push(`[Tap to re-authorise →](${reauthUrl})`);
	} else {
		lines.push(`Open the inbox UI to Reset password or Reauthorize.`);
	}

	const text = lines.join('\n');

	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(`[inbox-notify] telegram send failed for ${account.id}: ${result.error}`);
		}
	} catch (err) {
		console.warn(`[inbox-notify] telegram send threw for ${account.id}: ${(err as Error).message}`);
	}
}

async function notifyAccountRecovered(account: InboxAccount): Promise<void> {
	const text = [
		`🟢 *Inbox sync recovered* — ${account.label}`,
		`\`${account.email}\` (${account.provider})`,
	].join('\n');

	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(`[inbox-notify] telegram send failed for ${account.id}: ${result.error}`);
		}
	} catch (err) {
		console.warn(`[inbox-notify] telegram send threw for ${account.id}: ${(err as Error).message}`);
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isOAuthRefreshFailure(error: string): boolean {
	return /OAuth2? refresh/i.test(error) || /invalid_grant/i.test(error);
}
