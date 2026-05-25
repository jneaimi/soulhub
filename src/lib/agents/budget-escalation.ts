/**
 * ADR-006 Phase 2 — budget-approval escalation + resume.
 *
 * When a *pausable* (background) dispatch hits its hard ceiling, the PTY backend
 * returns `status: 'awaiting-budget-approval'` instead of killing the run — the
 * Claude session is preserved on disk. `dispatch/index.ts` calls
 * `escalateBudgetApproval()` here, which:
 *
 *   1. persists the resume context in the shared `pending_callbacks` table
 *      (kind `budget-approval`, 6h TTL) so a PM2 reload between send + tap
 *      doesn't orphan it, then
 *   2. sends the operator a Telegram message with fixed-bump buttons
 *      (`+$2 / +$5 / +10 turns / 🛑 Stop`) and an optional "⚙️ More options"
 *      deep-link to the dashboard.
 *
 * On a bump tap the callback handler (`channels/telegram/callback.ts`) calls
 * `resumeWithRaisedBudget()`, which re-dispatches the SAME agent with
 * `resume_session_id` (→ `claude --resume`) and a raised ceiling. The resumed
 * run flows back through `dispatchAgent`, so if it blows the new ceiling too it
 * re-escalates automatically. On Stop the run is flipped to `budget-exceeded`.
 *
 * Resume is fire-and-forget: the Telegram callback must answer within ~10s, so
 * we kick the (minutes-long) dispatch into the background and let the next
 * pause/finish surface itself.
 */

import { createHash } from 'node:crypto';

import { makePendingStore } from '../channels/telegram/pending-callbacks.js';
import { sendText } from '../channels/telegram/outbound.js';
import type { InlineKeyboardMarkup } from '../channels/telegram/types.js';
import { config as soulHubConfig } from '../config.js';
import { setRunStatus } from './runs.js';

/** Fixed bump amounts offered in the Telegram keyboard (ADR-006 — the operator
 *  picked "fixed-bump buttons"). Each raises the corresponding HARD ceiling. */
export const BUDGET_BUMPS = {
	'bgt-u2': { addUsd: 2 },
	'bgt-u5': { addUsd: 5 },
	'bgt-t10': { addTurns: 10 },
} as const;
export type BudgetBumpVerb = keyof typeof BUDGET_BUMPS;

/** 6h — matches the abandonment sweep in `runs.ts`. Long enough for the
 *  operator to action across a workday; short enough that a forgotten grant
 *  doesn't sit forever. */
const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface BudgetApprovalRow {
	runId: string;
	agentId: string;
	/** Claude session UUID — `claude --resume <sessionUuid>` continues it. */
	sessionUuid: string;
	/** Original task text — re-sent on resume (Claude Code needs a turn input). */
	task: string;
	/** The hard ceilings in force when it paused; a bump raises from these. */
	ceilingUsd: number;
	ceilingTurns: number;
	reason: 'max_usd' | 'max_turns';
	spentUsd: number;
	turns: number;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

const pendingApprovals = makePendingStore<BudgetApprovalRow>('budget-approval', APPROVAL_TTL_MS);

/** Stable short_id for a paused run — keeps callback_data inside Telegram's
 *  64-byte cap (`bgt-u2:` + 16 chars). Same run → same id across restarts. */
export function budgetApprovalIdFor(runId: string, sessionUuid: string): string {
	return createHash('sha1').update(`${runId}\0${sessionUuid}`).digest('base64url').slice(0, 16);
}

export function getBudgetApproval(id: string): BudgetApprovalRow | undefined {
	return pendingApprovals.get(id);
}

export function deleteBudgetApproval(id: string): void {
	pendingApprovals.delete(id);
}

/** Optional dashboard deep-link base. A Telegram URL button must point at a
 *  reachable host, so we only render "More options" when an explicit public URL
 *  is configured (loopback would be dead on a phone). */
function dashboardOrchestrationUrl(): string | null {
	const base = process.env.SOUL_HUB_PUBLIC_URL?.replace(/\/$/, '');
	if (!base || !/^https?:\/\//.test(base)) return null;
	return `${base}/orchestration`;
}

function buildApprovalKeyboard(id: string): InlineKeyboardMarkup {
	const rows: InlineKeyboardMarkup['inline_keyboard'] = [
		[
			{ text: '➕ $2', callback_data: `bgt-u2:${id}` },
			{ text: '➕ $5', callback_data: `bgt-u5:${id}` },
		],
		[
			{ text: '➕ 10 turns', callback_data: `bgt-t10:${id}` },
			{ text: '🛑 Stop', callback_data: `bgt-stop:${id}` },
		],
	];
	const url = dashboardOrchestrationUrl();
	if (url) rows.push([{ text: '⚙️ More options', url }]);
	return { inline_keyboard: rows };
}

function resolveTelegramChatId(): string | null {
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

export interface EscalateInput {
	runId: string;
	agentId: string;
	sessionUuid: string;
	task: string;
	ceilingUsd: number;
	ceilingTurns: number;
	reason: 'max_usd' | 'max_turns';
	spentUsd: number;
	turns: number;
}

function formatApprovalMessage(input: EscalateInput): string {
	const hit =
		input.reason === 'max_usd'
			? `spent *$${input.spentUsd.toFixed(2)}* (ceiling $${input.ceilingUsd})`
			: `ran *${input.turns} turns* (ceiling ${input.ceilingTurns})`;
	return [
		`⏸ *${input.agentId}* hit its budget ceiling and paused — not finished.`,
		'',
		`It ${hit}. Grant more to resume (\`claude --resume\`), or stop and keep the partial result.`,
		'',
		`_run \`${input.runId}\` · ${input.turns} turns · $${input.spentUsd.toFixed(2)}_`,
	].join('\n');
}

/** Persist + send the budget-approval escalation. Best-effort: returns the
 *  outcome but never throws into the dispatch path. */
export async function escalateBudgetApproval(
	input: EscalateInput,
): Promise<{ ok: boolean; error?: string }> {
	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const id = budgetApprovalIdFor(input.runId, input.sessionUuid);
	const result = await sendText(chatId, formatApprovalMessage(input), delivery, {
		replyMarkup: buildApprovalKeyboard(id),
	});
	if (!result.ok || result.messageIds.length === 0) {
		return { ok: false, error: result.error ?? 'send-failed' };
	}

	pendingApprovals.set(id, {
		runId: input.runId,
		agentId: input.agentId,
		sessionUuid: input.sessionUuid,
		task: input.task,
		ceilingUsd: input.ceilingUsd,
		ceilingTurns: input.ceilingTurns,
		reason: input.reason,
		spentUsd: input.spentUsd,
		turns: input.turns,
		chatJid: String(chatId),
		messageId: result.messageIds[0],
		createdAt: Date.now(),
	});
	return { ok: true };
}

/** Resume a paused run with a raised ceiling. Fire-and-forget — the dispatch
 *  runs in the background (it can take minutes) and re-surfaces via the normal
 *  finish/escalation path. Returns the raised ceilings for the ack message. */
export function resumeWithRaisedBudget(
	row: BudgetApprovalRow,
	bump: { addUsd?: number; addTurns?: number },
): { ceilingUsd: number; ceilingTurns: number } {
	const ceilingUsd = row.ceilingUsd + (bump.addUsd ?? 0);
	const ceilingTurns = row.ceilingTurns + (bump.addTurns ?? 0);

	// Detached: do NOT await — the Telegram callback must answer fast. Dynamic
	// import breaks the dispatch/index ↔ budget-escalation static cycle.
	void (async () => {
		try {
			const { dispatchAgent } = await import('./dispatch/index.js');
			const gen = dispatchAgent(row.agentId, row.task, {
				mode: 'production',
				resumeSessionId: row.sessionUuid,
				pausableOnCeiling: true,
				budget_override: { ceiling_usd: ceilingUsd, ceiling_turns: ceilingTurns },
			});
			// Drain to completion; the finish hook in index.ts handles re-escalation
			// or the terminal record.
			while (!(await gen.next()).done) {
				/* drain events — index.ts persists + escalates on the return value */
			}
		} catch (err) {
			console.error(
				`[agents/budget] resume failed for run ${row.runId}: ${(err as Error).message}`,
			);
		}
	})();

	return { ceilingUsd, ceilingTurns };
}

/** Operator chose Stop — flip the paused run to a terminal `budget-exceeded`
 *  and forget the pending approval. The partial result already lives in the
 *  run record's `result_excerpt`. */
export function stopBudgetApproval(row: BudgetApprovalRow): void {
	try {
		setRunStatus(row.runId, 'budget-exceeded', {
			errorMessage: 'stopped by operator at budget ceiling',
		});
	} catch (err) {
		console.error(`[agents/budget] stop failed for run ${row.runId}: ${(err as Error).message}`);
	}
	deleteBudgetApproval(budgetApprovalIdFor(row.runId, row.sessionUuid));
}
