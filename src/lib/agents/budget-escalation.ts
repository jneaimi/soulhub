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
import { setRunStatus, cumulativeAdrSpend } from './runs.js';
import { resolveAdrBudget } from './dispatch/resolve-adr-budget.js';
import { getVaultEngine } from '../vault/index.js';
import { locateTranscript } from '../sessions/run-record.js';
import { streamEvents } from '../sessions/parser.js';
import { extractRecentTurns, type RecentTurn } from '../sessions/recent-turns.js';
import { classifyVelocity, type VelocityNote } from './budget-velocity.js';

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
	/** Bug fix 2026-05-29 — preserve the vault artifact path across the pause
	 *  so resume can reach the per-ADR worktree (ADR-022) and ADR-022 D3 can
	 *  see the resumed run as in-flight. Without this, the resumed PTY ran in
	 *  `cwd=vault` with no worktree, and concurrent dispatches against the
	 *  same ADR sailed through D3 (witnessed in run 0f885fb0 → df910cef race
	 *  against `projects/projects-graph/adr-025-...`). */
	subjectPath?: string;
	/** Bug fix 2026-05-29 — preserve the resolved repo so resume picks the
	 *  same worktree even when the project's `repo:` binding shifts after the
	 *  pause. Null for legacy non-repo agents. */
	repo?: string;
}

const pendingApprovals = makePendingStore<BudgetApprovalRow>('budget-approval', APPROVAL_TTL_MS);

/** ADR-006 Phase 3 — velocity-warning pending rows. Short TTL: a warning only
 *  matters while the dispatch is still running (minutes); a stale tap finds no
 *  live run to raise. */
const VELOCITY_TTL_MS = 30 * 60 * 1000;

export interface BudgetVelocityRow {
	runId: string;
	agentId: string;
	sessionUuid: string;
	/** Hard ceilings in force when the warning fired — the live-grant base. */
	ceilingUsd: number;
	ceilingTurns: number;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

const pendingVelocity = makePendingStore<BudgetVelocityRow>('budget-velocity', VELOCITY_TTL_MS);

export function getVelocityApproval(id: string): BudgetVelocityRow | undefined {
	return pendingVelocity.get(id);
}
export function deleteVelocityApproval(id: string): void {
	pendingVelocity.delete(id);
}

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

/** Deep-link into the workbench's approval surface for this specific run (D3).
 *  Same SOUL_HUB_PUBLIC_URL guard as `dashboardOrchestrationUrl` — returns
 *  null on loopback-only installs, in which case the "🔍 Investigate" button
 *  is omitted from the keyboard. */
function runApproveUrl(runId: string): string | null {
	const base = process.env.SOUL_HUB_PUBLIC_URL?.replace(/\/$/, '');
	if (!base || !/^https?:\/\//.test(base)) return null;
	return `${base}/orchestration/runs/${encodeURIComponent(runId)}/approve`;
}

function buildApprovalKeyboard(id: string, runId: string): InlineKeyboardMarkup {
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
	const investigateUrl = runApproveUrl(runId);
	if (investigateUrl) {
		rows.push([{ text: '🔍 Investigate in workbench', url: investigateUrl }]);
	}
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
	/** Bug fix 2026-05-29 — capture the run's subjectPath at pause time so the
	 *  resume path can wire it back into `dispatchAgent` (otherwise resumed
	 *  rows have subject_path=NULL and ADR-022 D3 misses concurrent dispatches). */
	subjectPath?: string;
	/** Same: preserve the resolved repo so resume reuses the per-ADR worktree. */
	repo?: string;
}

/** ADR-cumulative spend suffix for budget Telegram messages (2026-05-30).
 *  Returns a single italic line like `_ADR cumulative: $8.06 / $25 cap_` when
 *  the run's subject path resolves to an ADR with `dispatch_budget_usd:` set,
 *  or `_ADR cumulative: $8.06_` when no cap is set, or `''` when there's no
 *  subject path or vault is offline. Reading the cap is best-effort; failure
 *  just yields the cumulative-only form. Keeps callers branch-free. */
function formatAdrBudgetSuffix(subjectPath: string | undefined | null): string {
	if (!subjectPath) return '';
	let cumulative = 0;
	try {
		cumulative = cumulativeAdrSpend(subjectPath);
	} catch {
		return '';
	}
	if (cumulative <= 0) return '';
	let cap: number | undefined;
	try {
		const engine = getVaultEngine();
		if (engine) cap = resolveAdrBudget(subjectPath, (p) => engine.getNote(p));
	} catch {
		/* ignore — render cumulative-only */
	}
	const capStr =
		cap !== undefined
			? ` / $${cap.toFixed(0)} cap (${((cumulative / cap) * 100).toFixed(0)}%)`
			: '';
	return `\n_ADR cumulative: $${cumulative.toFixed(2)}${capStr}_`;
}

/** Render a recent-turn excerpt as Telegram-safe markdown. The role labels
 *  are bolded; body text is fenced as a code block so any stray `*`/`_` in
 *  the agent's output doesn't trip MarkdownV2 parsing. */
function formatTranscriptExcerpt(turns: RecentTurn[]): string {
	if (turns.length === 0) return '';
	const blocks = turns.map((t) => {
		const label = t.role === 'user' ? '👤 you' : '🤖 agent';
		return `*${label}*\n\`\`\`\n${t.text}\n\`\`\``;
	});
	return ['', '*— last turns —*', ...blocks].join('\n');
}

/** Build the full approval-message body. Pure; transcript + velocity are
 *  passed in so the I/O lives at the caller (escalateBudgetApproval). */
export function formatApprovalMessage(
	input: EscalateInput,
	extras: { transcript?: RecentTurn[]; velocity?: VelocityNote } = {},
): string {
	const hit =
		input.reason === 'max_usd'
			? `spent *$${input.spentUsd.toFixed(2)}* (ceiling $${input.ceilingUsd})`
			: `ran *${input.turns} turns* (ceiling ${input.ceilingTurns})`;
	const lines: string[] = [
		`⏸ *${input.agentId}* hit its budget ceiling and paused — not finished.`,
		'',
		`It ${hit}. Grant more to resume, tap *Stop* to keep the partial result, or *Investigate* to open the workbench.`,
	];
	if (extras.velocity) {
		lines.push('', `_${extras.velocity.text}_`);
	}
	if (extras.transcript && extras.transcript.length > 0) {
		lines.push(formatTranscriptExcerpt(extras.transcript));
	}
	lines.push(
		'',
		`_run \`${input.runId}\` · ${input.turns} turns · $${input.spentUsd.toFixed(2)}_${formatAdrBudgetSuffix(input.subjectPath)}`,
	);
	return lines.join('\n');
}

/** Best-effort transcript loader for the Smart Telegram (O3 D2) excerpt.
 *  Soft-fails: a missing transcript / parse error just yields an empty array,
 *  so the message degrades to the legacy "header + velocity" shape. */
async function loadTranscriptForApproval(sessionUuid: string): Promise<RecentTurn[]> {
	try {
		const path = locateTranscript(sessionUuid);
		if (!path) return [];
		const events = [];
		for await (const e of streamEvents(path)) {
			events.push(e);
		}
		return extractRecentTurns(events, { limit: 3, perTurnMaxChars: 600 });
	} catch {
		return [];
	}
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

	// O3 D2 — smart-dynamic enrichment: transcript excerpt + velocity note.
	// Both are best-effort; failures degrade the message gracefully (header
	// only) rather than blocking the escalation.
	const transcript = await loadTranscriptForApproval(input.sessionUuid);
	const velocity = classifyVelocity({
		spentUsd: input.spentUsd,
		ceilingUsd: input.ceilingUsd,
		turns: input.turns,
		ceilingTurns: input.ceilingTurns,
	});

	const id = budgetApprovalIdFor(input.runId, input.sessionUuid);
	const result = await sendText(
		chatId,
		formatApprovalMessage(input, { transcript, velocity }),
		delivery,
		{
			replyMarkup: buildApprovalKeyboard(id, input.runId),
		},
	);
	if (!result.ok || result.messageIds.length === 0) {
		return { ok: false, error: result.error ?? 'send-failed' };
	}

	pendingApprovals.set(id, buildApprovalRow(input, String(chatId), result.messageIds[0]));
	return { ok: true };
}

/** Pure mapping from `EscalateInput` to the persisted `BudgetApprovalRow`.
 *  Extracted from `escalateBudgetApproval` so the field-preservation contract
 *  (especially `subjectPath` + `repo`, fixed 2026-05-29) is unit-testable
 *  without the Telegram + config side-effects.  Production callers should keep
 *  using `escalateBudgetApproval`; this is the inner shape-only mapping. */
export function buildApprovalRow(
	input: EscalateInput,
	chatJid: string,
	messageId: number,
	now: number = Date.now(),
): BudgetApprovalRow {
	return {
		runId: input.runId,
		agentId: input.agentId,
		sessionUuid: input.sessionUuid,
		task: input.task,
		ceilingUsd: input.ceilingUsd,
		ceilingTurns: input.ceilingTurns,
		reason: input.reason,
		spentUsd: input.spentUsd,
		turns: input.turns,
		chatJid,
		messageId,
		createdAt: now,
		// Bug fix 2026-05-29 — forward the captured artifact context so resume
		// can wire it back into dispatchAgent. Undefined for legacy non-artifact
		// runs (orchestrator background jobs, ad-hoc tests) — same legacy path.
		subjectPath: input.subjectPath,
		repo: input.repo,
	};
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
				// Bug fix 2026-05-29 — forward the captured subjectPath so the
				// resumed dispatcher (a) writes the start row's subject_path
				// (closing the ADR-022 D3 leak that let duplicate dispatches
				// through), (b) resolves effectiveRepo via the project binding,
				// and (c) routes worktree provisioning to ADR-022's per-ADR
				// `claude-soul/<adrKey>` path instead of running in cwd=vault.
				// Without this the resumed PTY was a zombie — alive but blind
				// to prior commits. Witnessed in run 0f885fb0 (2026-05-29).
				subjectPath: row.subjectPath,
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

// ─── Phase 3 — velocity warning (in-flight, pre-emptive) ───────────────────

function buildVelocityKeyboard(id: string): InlineKeyboardMarkup {
	const rows: InlineKeyboardMarkup['inline_keyboard'] = [
		[
			{ text: '➕ $2', callback_data: `bgv-u2:${id}` },
			{ text: '➕ $5', callback_data: `bgv-u5:${id}` },
			{ text: '➕ 10 turns', callback_data: `bgv-t10:${id}` },
		],
	];
	const url = dashboardOrchestrationUrl();
	if (url) rows.push([{ text: '⚙️ More options', url }]);
	return { inline_keyboard: rows };
}

export interface VelocityWarningInput {
	runId: string;
	agentId: string;
	sessionUuid: string;
	ceilingUsd: number;
	ceilingTurns: number;
	reason: 'max_usd' | 'max_turns';
	spentUsd: number;
	turns: number;
	/** 2026-05-30 — forwarded so the message can render ADR cumulative spend
	 *  (`cumulativeAdrSpend` + `resolveAdrBudget`). Undefined for non-artifact
	 *  runs; the message just drops the cumulative line. */
	subjectPath?: string;
}

function formatVelocityMessage(input: VelocityWarningInput): string {
	const at =
		input.reason === 'max_usd'
			? `*$${input.spentUsd.toFixed(2)}* of its $${input.ceilingUsd} ceiling`
			: `*${input.turns}* of its ${input.ceilingTurns}-turn ceiling`;
	return [
		`⚡ *${input.agentId}* is burning fast — at ${at}, projecting to hit the wall in a few turns.`,
		'',
		`Pre-approve now to raise the ceiling *in-flight* — the run keeps going with no restart. Ignore it and it'll pause at the ceiling instead (you can grant or stop then).`,
		'',
		`_run \`${input.runId}\` · ${input.turns} turns · $${input.spentUsd.toFixed(2)}_${formatAdrBudgetSuffix(input.subjectPath)}`,
	].join('\n');
}

/** Send the early velocity warning + persist its pending row so a bump tap can
 *  resolve back to the live session. Best-effort; never throws into dispatch. */
export async function escalateVelocityWarning(
	input: VelocityWarningInput,
): Promise<{ ok: boolean; error?: string }> {
	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const id = budgetApprovalIdFor(input.runId, input.sessionUuid);
	const result = await sendText(chatId, formatVelocityMessage(input), delivery, {
		replyMarkup: buildVelocityKeyboard(id),
	});
	if (!result.ok || result.messageIds.length === 0) {
		return { ok: false, error: result.error ?? 'send-failed' };
	}

	pendingVelocity.set(id, {
		runId: input.runId,
		agentId: input.agentId,
		sessionUuid: input.sessionUuid,
		ceilingUsd: input.ceilingUsd,
		ceilingTurns: input.ceilingTurns,
		chatJid: String(chatId),
		messageId: result.messageIds[0],
		createdAt: Date.now(),
	});
	return { ok: true };
}

// ─── ADR-026 P2 — operator-input escalation ────────────────────────────────

export interface OperatorInputEscalateInput {
	runId: string;
	agentId: string;
	question: string;
}

function formatOperatorInputMessage(input: OperatorInputEscalateInput): string {
	return [
		`🟡 *${input.agentId}* is waiting on you: ${input.question}`,
		'',
		`Resume with your answer via \`--resume\` — the answer rides in as the task.`,
		'',
		`_run \`${input.runId}\`_`,
	].join('\n');
}

/** Notify the operator that an agent emitted an `ask_operator` sentinel.
 *  Sends the question to Telegram. No keyboard or persistence is needed —
 *  the operator answers by resuming the session; the answer rides back in as
 *  the `task` text on `--resume`. Best-effort; never throws into dispatch. */
export async function escalateOperatorInput(
	input: OperatorInputEscalateInput,
): Promise<{ ok: boolean; error?: string }> {
	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const result = await sendText(chatId, formatOperatorInputMessage(input), delivery);
	if (!result.ok || result.messageIds.length === 0) {
		return { ok: false, error: result.error ?? 'send-failed' };
	}
	return { ok: true };
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
