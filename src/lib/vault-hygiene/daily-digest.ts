/** Daily hygiene digest (soul-hub-hygiene ADR-005 P1).
 *
 *  ONE batched message instead of per-item escalation spam: a daily summary
 *  of everything the operator still needs to triage, with a deep-link to the
 *  `/hygiene` dashboard (the action surface from ADR-005 P2) and a one-tap
 *  "fix all broken links" button (the existing `vh-fix-all` keeper flow).
 *
 *  Sent daily, only if there is something to act on — clean days are silent.
 *  Reuses the proven aggregate-digest pattern already used by the broken-links
 *  bucket in `vault-escalator.ts`; this generalises it across buckets and onto
 *  a single daily cadence.
 *
 *  This is additive — it does not yet retire the existing escalators; the
 *  vault escalator dedups and the project-hygiene path stays per-row until its
 *  dashboard disposition lands (ADR-005 "2b"). */

import { notifyOperator } from '../channels/_shared/notify-operator.js';
import { buildFixBatchKeyboard, rememberFixBatch } from '../channels/telegram/callback.js';
import type { InlineKeyboardMarkup, TelegramDeliveryConfig } from '../channels/telegram/types.js';
import { getHygieneReport } from './report.js';
import { getProjectHygieneRows } from './inline-escalator.js';
import { getVaultEngine } from '../vault/index.js';
import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';
import { config as soulHubConfig } from '../config.js';

const DASHBOARD_URL =
	(process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400') + '/orchestration/hygiene';

/** ADR-004 P4 P1b — fold the assumption-audit nudge into this one operator
 *  digest (it was a separate 3×/day Telegram sender). Audit findings are a
 *  count-nudge with no per-item interaction, so they merge cleanly; inbox stays
 *  its own rich actionable surface (ADR-044) and is NOT merged. */
const AUDIT_LOOKBACK_HOURS = 24;

interface OutstandingAudit {
	id: number;
	session_id: string;
	score: number;
}

/** Outstanding high-score, un-nudged, un-dismissed audits in the lookback —
 *  the same predicate the retired `audit-nudge-telegram` used. */
function getOutstandingAudits(): OutstandingAudit[] {
	const since = Date.now() - AUDIT_LOOKBACK_HOURS * 3_600_000;
	return getHeartbeatDb()
		.prepare(
			`SELECT id, session_id, score FROM assumption_audits
			 WHERE score > 70 AND dismissed_at IS NULL AND nudged_at IS NULL AND audited_at >= ?
			 ORDER BY score DESC, audited_at DESC`,
		)
		.all(since) as OutstandingAudit[];
}

/** Mark surfaced audits nudged so the next digest doesn't re-fire them.
 *  Transactional (mirrors the retired nudge handler). Called only after the
 *  digest is delivered. */
function markAuditsNudged(ids: number[]): void {
	if (ids.length === 0) return;
	const db = getHeartbeatDb();
	const stmt = db.prepare('UPDATE assumption_audits SET nudged_at = ? WHERE id = ?');
	const now = Date.now();
	db.transaction((rows: number[]) => {
		for (const id of rows) stmt.run(now, id);
	})(ids);
}

function shortSession(id: string): string {
	return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

export interface DailyDigestResult {
	ok: boolean;
	sent?: boolean;
	reason?: string;
	error?: string;
	total?: number;
}

function resolveTelegramChatId(): string | null {
	// `channels.telegram.access` is loosely typed (`{}`) in the config shape;
	// the runtime value carries `allowFrom`. Narrow locally rather than propagate
	// the codebase-wide config-typing gap the sibling escalators tolerate.
	const allow = (soulHubConfig.channels?.telegram?.access as { allowFrom?: unknown } | undefined)
		?.allowFrom;
	if (Array.isArray(allow) && allow.length > 0 && typeof allow[0] === 'string') {
		return allow[0];
	}
	const env = process.env.TELEGRAM_CHAT_ID;
	return env && env.trim() ? env.trim() : null;
}

export async function emitDailyHygieneDigest(): Promise<DailyDigestResult> {
	const report = await getHygieneReport();
	const t = report.totals;

	// Project-hygiene anomalies live in the weekly inbox digest, not the vault
	// report — fold their count in so the digest is the single notification
	// surface (ADR-005 2b). Best-effort: a missing digest yields 0.
	let projectCount = 0;
	try {
		projectCount = (await getProjectHygieneRows()).length;
	} catch {
		/* no digest yet — ignore */
	}

	// Actionable buckets only — `indexed` is informational, not a to-do.
	const total =
		t.unresolved +
		t.orphans +
		t.staleInbox +
		t.statusContradictions +
		t.governanceViolations +
		t.misplacedNotes +
		t.inboxDecisions +
		projectCount;

	// Audit findings fold into this one digest (ADR-004 P1b — retires the
	// separate audit-nudge sender). Computed before the silent-check so a
	// hygiene-clean day with outstanding audits still sends.
	const audits = getOutstandingAudits();

	// Silent only when BOTH sources are empty — clean days stay quiet.
	if (total === 0 && audits.length === 0) return { ok: true, sent: false, reason: 'clean', total: 0 };

	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery as TelegramDeliveryConfig | undefined;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const lines: string[] = [];

	// Hygiene section (only when there's hygiene work — else skip the header).
	if (total > 0) {
		lines.push(`🧹 *Vault health* — ${total} item${total === 1 ? '' : 's'} need your call`, '');
		const bucketLines: [number, string][] = [
			[t.unresolved, 'Broken links'],
			[t.statusContradictions, 'Status contradictions'],
			[t.governanceViolations, 'Governance violations'],
			[t.orphans, 'Orphans'],
			[t.staleInbox, 'Stale inbox'],
			[t.misplacedNotes, 'Misplaced notes'],
			[t.inboxDecisions, 'Inbox decisions'],
			[projectCount, 'Project anomalies'],
		];
		for (const [n, label] of bucketLines) if (n > 0) lines.push(`• ${label}: *${n}*`);
		lines.push('', `Health score: ${report.healthScore}/100`);
	}

	// Assumption-audit section (folded — ADR-004 P1b).
	if (audits.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push(`⚠️ *Assumption audits* — ${audits.length} high-score finding${audits.length === 1 ? '' : 's'}`);
		for (const a of audits.slice(0, 5)) lines.push(`• ${a.score} — ${shortSession(a.session_id)}`);
		if (audits.length > 5) lines.push(`…and ${audits.length - 5} more`);
	}

	lines.push('', `Review + act → ${DASHBOARD_URL}`);
	const text = lines.join('\n');

	// Keyboard: open the dashboard (URL button), plus the one-tap bulk
	// broken-link fix if any exist (mirrors the vault escalator's filter).
	const keyboard: InlineKeyboardMarkup = {
		inline_keyboard: [[{ text: '📊 Open /hygiene', url: DASHBOARD_URL }]],
	};

	const engine = getVaultEngine();
	let batch: { source: string; raw: string }[] = [];
	if (engine && t.unresolved > 0) {
		batch = engine
			.getUnresolved()
			.filter((u) => {
				const zone = u.source.split('/')[0];
				return zone !== 'archive' && zone !== 'inbox' && !u.source.startsWith('operations/hygiene/');
			})
			.map((u) => ({ source: u.source, raw: u.raw }));
		if (batch.length > 0) keyboard.inline_keyboard.push(...buildFixBatchKeyboard(batch).inline_keyboard);
	}

	// ADR-004 P4 — the hygiene digest is the first consumer of the unified
	// `notifyOperator` substrate (both-channel-capable, ADR-021 proactive-turn,
	// dedup + budget ledger). Behaviour-preserving on Telegram; the fix-batch
	// button still wires off the returned message id.
	const result = await notifyOperator({ source: 'operator-digest', tier: 'digest', text, keyboard });
	if (!result.ok) {
		return { ok: false, error: result.error ?? 'send-failed' };
	}
	// Mark surfaced audits nudged once delivered (sent OR deduped — a dedup means
	// a byte-identical digest carrying these same audit ids was already delivered
	// today). Erring toward "delivered" prevents re-firing; the worst case is a
	// benign one-time re-surface, never a drop.
	markAuditsNudged(audits.map((a) => a.id));
	const msgIds = result.telegramMessageIds ?? [];
	if (batch.length > 0 && msgIds.length > 0) {
		rememberFixBatch({ batch, digestText: text, chatJid: String(chatId), messageId: msgIds[0] });
	}
	return { ok: true, sent: true, total };
}
