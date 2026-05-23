/** Scheduler handler: audit-nudge-telegram (project-phases ADR-008 S4).
 *
 *  Watches the assumption_audits table for fresh high-score audits and
 *  pings the operator via Telegram when N-in-T threshold is crossed.
 *  Dedup via `nudged_at` column (v15 migration) — each audit is
 *  surfaced at most once.
 *
 *  Default thresholds (configurable via task params):
 *    - minHighScoreCount: 3   — fire only when ≥N unnudged high-score
 *      audits exist in the lookback window. Avoids single-row noise.
 *    - lookbackHours:     24  — window for "recent" audits
 *    - maxRowsInMessage:  8   — cap how many audits the message lists
 *
 *  Settings shape:
 *    {
 *      id: 'audit-assumption-rate-nudge',
 *      type: 'audit-nudge-telegram',
 *      cron: '30 8,14,20 * * *',
 *      timezone: 'Asia/Dubai',
 *      params: { minHighScoreCount?, lookbackHours?, maxRowsInMessage? }
 *    }
 */

import { config as soulHubConfig } from '../../config.js';
import { sendText } from '../../channels/telegram/outbound.js';
import { getHeartbeatDb } from '../../channels/whatsapp/heartbeat-state.js';
import type { TaskFn } from '../task-types.js';

/** Same fallback chain as the other heartbeat-driven nudges
 *  (vault-escalator, inbox-anomaly): prefer the configured
 *  `channels.telegram.access.allowFrom` first entry; fall back to the
 *  legacy `TELEGRAM_CHAT_ID` env var. */
function resolveTelegramChatId(): string | null {
	const allow = soulHubConfig.channels?.telegram?.access?.allowFrom;
	if (Array.isArray(allow) && allow.length > 0 && typeof allow[0] === 'string') {
		return allow[0];
	}
	const env = process.env.TELEGRAM_CHAT_ID;
	return env && env.trim() ? env.trim() : null;
}

interface AuditNudgeParams {
	minHighScoreCount?: number;
	lookbackHours?: number;
	maxRowsInMessage?: number;
}

interface NudgeCandidate {
	id: number;
	session_id: string;
	score: number;
	deterministic_score: number;
	llm_score: number | null;
	audited_at: number;
	linked_projects: string;
}

export interface AuditNudgeSummary {
	candidates: number;
	fired: boolean;
	sent: number;
	skipped_below_threshold: boolean;
	failed: boolean;
	error?: string;
	took_ms: number;
}

function shortSession(id: string): string {
	return id.slice(0, 8);
}

function buildNudgeMessage(
	candidates: NudgeCandidate[],
	totalCandidates: number,
	dashboardUrl: string | null
): string {
	const lines: string[] = [];
	const header =
		totalCandidates === 1
			? '⚠️ 1 new high-score assumption audit'
			: `⚠️ ${totalCandidates} new high-score assumption audits`;
	lines.push(header);
	lines.push('');

	for (const c of candidates) {
		const projects = (() => {
			try {
				return JSON.parse(c.linked_projects) as string[];
			} catch {
				return [] as string[];
			}
		})();
		const projTag = projects.length > 0 ? `[${projects.slice(0, 2).join(', ')}]` : '';
		const llmTag = c.llm_score !== null ? `det:${c.deterministic_score} llm:${c.llm_score}` : 'det only';
		lines.push(`• ${c.score} (${llmTag}) ${shortSession(c.session_id)} ${projTag}`);
	}

	if (totalCandidates > candidates.length) {
		lines.push(`…and ${totalCandidates - candidates.length} more`);
	}

	lines.push('');
	if (dashboardUrl) {
		lines.push(`Review: ${dashboardUrl}`);
	} else {
		lines.push('Review at /projects/<slug> under any project linked above.');
	}

	return lines.join('\n');
}

function resolveDashboardUrl(): string | null {
	const base = soulHubConfig.host;
	if (!base) return null;
	return `${base.replace(/\/$/, '')}/projects`;
}

export function auditNudgeTelegramFactory(rawParams: unknown): TaskFn {
	const params: AuditNudgeParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as AuditNudgeParams)
			: {};
	const minHighScoreCount = params.minHighScoreCount ?? 3;
	const lookbackHours = params.lookbackHours ?? 24;
	const maxRowsInMessage = params.maxRowsInMessage ?? 8;

	return async (): Promise<AuditNudgeSummary> => {
		const startedAt = Date.now();
		const since = startedAt - lookbackHours * 60 * 60 * 1000;

		const db = getHeartbeatDb();
		const candidates = db
			.prepare(
				`SELECT id, session_id, score, deterministic_score, llm_score, audited_at, linked_projects
				 FROM assumption_audits
				 WHERE score > 70
				   AND dismissed_at IS NULL
				   AND nudged_at IS NULL
				   AND audited_at >= @since
				 ORDER BY score DESC, audited_at DESC`
			)
			.all({ since }) as NudgeCandidate[];

		const summary: AuditNudgeSummary = {
			candidates: candidates.length,
			fired: false,
			sent: 0,
			skipped_below_threshold: false,
			failed: false,
			took_ms: 0
		};

		if (candidates.length < minHighScoreCount) {
			summary.skipped_below_threshold = true;
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const chatId = resolveTelegramChatId();
		if (!chatId) {
			summary.failed = true;
			summary.error = 'no-telegram-chat-id';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const delivery = soulHubConfig.channels?.telegram?.delivery;
		if (!delivery) {
			summary.failed = true;
			summary.error = 'no-telegram-delivery-config';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const surfaced = candidates.slice(0, maxRowsInMessage);
		const message = buildNudgeMessage(surfaced, candidates.length, resolveDashboardUrl());

		const result = await sendText(chatId, message, delivery);
		if (!result.ok || result.messageIds.length === 0) {
			summary.failed = true;
			summary.error = result.error ?? 'send-failed';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		// Mark surfaced audits as nudged so the next tick doesn't re-fire.
		// Use a transaction so a mid-update crash doesn't leave the table in
		// a split state.
		const nudged_at = Date.now();
		const updateStmt = db.prepare(
			'UPDATE assumption_audits SET nudged_at = ? WHERE id = ?'
		);
		db.transaction((rows: NudgeCandidate[]) => {
			for (const r of rows) updateStmt.run(nudged_at, r.id);
		})(surfaced);

		summary.fired = true;
		summary.sent = surfaced.length;
		summary.took_ms = Date.now() - startedAt;
		return summary;
	};
}
