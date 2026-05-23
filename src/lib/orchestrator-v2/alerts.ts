/**
 * ADR-009 Phase 6 — Telegram alerts for the 14-day A/B observation window.
 *
 * Two alert paths:
 *   - `notifyWrongDispatch` — fires when the user `/wrong`-flags a dispatch.
 *     The branch responsible has triggered the falsifier (any wrong dispatch
 *     in 14 days kills the branch). Telegram message is the user's signal
 *     to either retire the branch (set `BRANCH_COST_CAP_USD=0` for that
 *     branch via env override or just ignore future picks) or accept the
 *     trade-off.
 *   - `notifyBudgetExceeded` — fires the first time a branch crosses the
 *     `BRANCH_COST_CAP_USD` threshold. Idempotent: subsequent over-budget
 *     turns don't re-fire. Tracking state lives in-memory (resets on
 *     restart, which is acceptable — over-budget branches stay flagged
 *     by the SQLite cost table; only the alert is rate-limited).
 *
 * Both alerts are best-effort: if Telegram isn't configured or the API call
 * fails, we log and move on. The A/B observation is more important than
 * any single notification.
 */

import { send as sendTelegram } from '../channels/telegram/index.js';

const budgetAlertedBranches = new Set<string>();

/** Fire a Telegram alert when a wrong-dispatch is flagged. Always fires —
 *  the user expects to see EVERY wrong dispatch in the 14-day window. */
export async function notifyWrongDispatch(input: {
	branchName: string;
	agentId: string;
	conversationKey: string;
	task: string;
}): Promise<void> {
	const text = [
		`🚨 *Wrong-dispatch flagged* (ADR-009 falsifier triggered)`,
		``,
		`*Branch:* \`${input.branchName}\``,
		`*Agent:* \`${input.agentId}\``,
		`*Conversation:* \`${input.conversationKey}\``,
		``,
		`*Task:*`,
		`> ${input.task.slice(0, 240)}${input.task.length > 240 ? '…' : ''}`,
		``,
		`Per the falsifier, this branch should be considered for retirement.`,
	].join('\n');
	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(
				`[orchestrator-v2/alerts] notifyWrongDispatch: telegram send failed (${result.error})`,
			);
		}
	} catch (err) {
		console.warn(
			`[orchestrator-v2/alerts] notifyWrongDispatch threw: ${(err as Error).message}`,
		);
	}
}

/** Fire a Telegram alert the FIRST time a branch crosses the cost cap.
 *  Subsequent calls within the same process are no-ops. PM2 restart
 *  resets the in-memory de-dup, which means the alert may re-fire after
 *  a restart — acceptable for a 14-day observation window. */
export async function notifyBudgetExceeded(input: {
	branchName: string;
	costUsd: number;
	capUsd: number;
}): Promise<void> {
	if (budgetAlertedBranches.has(input.branchName)) return;
	budgetAlertedBranches.add(input.branchName);
	const text = [
		`💸 *Branch budget exceeded* (ADR-009 cost falsifier)`,
		``,
		`*Branch:* \`${input.branchName}\``,
		`*14-day spend:* $${input.costUsd.toFixed(2)} (cap $${input.capUsd.toFixed(2)})`,
		``,
		`New conversation keys will skip this branch for the rest of the window.`,
		`Existing sticky assignments are unchanged.`,
	].join('\n');
	try {
		const result = await sendTelegram(text);
		if (!result.ok) {
			console.warn(
				`[orchestrator-v2/alerts] notifyBudgetExceeded: telegram send failed (${result.error})`,
			);
		}
	} catch (err) {
		console.warn(
			`[orchestrator-v2/alerts] notifyBudgetExceeded threw: ${(err as Error).message}`,
		);
	}
}

/** Test-only — reset the in-memory de-dup set. */
export function _resetBudgetAlertState(): void {
	budgetAlertedBranches.clear();
}
