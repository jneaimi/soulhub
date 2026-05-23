/** Layer 3 Stage 3a — real-time anomaly push.
 *
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D4.1.
 *
 *  Each heartbeat tick:
 *    1. listAnomalyPushCandidates({lookbackHours, limit}) — rows in
 *       inbox.db that are extracted, transactional/personal, NOT already
 *       anomaly-pushed (agent_actions exclusion clause).
 *    2. evaluateAnomalyGate(msg, extract, cfg, crmHit) — decide push
 *       vs defer. Returns {push, reason} so the audit row records WHY.
 *    3. formatAnomalyMessage(...) — server-side deterministic text. No
 *       LLM in the push path; anomalies must be reliable, not generated.
 *
 *  Deduplication: the inbox-anomaly-push tool name in agent_actions is
 *  the source of truth. Even if the heartbeat misses 12 ticks and runs
 *  with a 6-hour lookback window, the NOT EXISTS clause keeps things
 *  idempotent. */

import { getInboxDb } from './db.js';
import { rowToMessage } from './db.js';
import type { InboxMessage } from './types.js';
import type { TransactionalExtract } from './extractor.js';

export interface AnomalyConfig {
	enabled: boolean;
	thresholdAmount: number;
	thresholdCurrency: string;
	lookbackHours: number;
	perTickCap: number;
}

export interface ListAnomalyCandidatesOptions {
	lookbackHours: number;
	limit: number;
}

/** Fetch rows that are eligible for anomaly evaluation this tick.
 *  Filters by category + extraction-done + within lookback window +
 *  not-yet-pushed. The gate decision happens in evaluateAnomalyGate —
 *  this query is intentionally permissive so the gate can re-decide
 *  with current thresholds (operator may have changed them since the
 *  row was synced). */
export function listAnomalyPushCandidates(
	opts: ListAnomalyCandidatesOptions,
): InboxMessage[] {
	const db = getInboxDb();
	const sinceMs = Date.now() - opts.lookbackHours * 3600 * 1000;
	const rows = db
		.prepare(
			`SELECT m.* FROM messages m
			 WHERE m.category IN ('transactional', 'personal')
			   AND m.extracted_data IS NOT NULL
			   AND m.date_received > ?
			   AND NOT EXISTS (
				 SELECT 1 FROM agent_actions a
				 WHERE a.message_id = m.id
				   AND a.tool = 'inbox-anomaly-push'
			   )
			 ORDER BY m.date_received ASC
			 LIMIT ?`,
		)
		.all(sinceMs, opts.limit) as Record<string, unknown>[];
	return rows.map(rowToMessage);
}

export type AnomalyReason =
	| 'personal'           // category=personal always pushes
	| 'anomalyHint'        // extractor flagged unusual language
	| 'threshold'          // amount > thresholdAmount in matching currency
	| 'crm-sender'         // sender exists in CRM contact_emails
	| 'no-match';          // defer to daily digest (S3b)

export interface AnomalyDecision {
	push: boolean;
	reason: AnomalyReason;
}

/** Apply the anomaly gate per ADR §D4.1. Returns {push, reason} so the
 *  caller can record the reason in agent_actions for tuning later.
 *
 *  Order matters — first matching branch wins. anomalyHint comes before
 *  threshold so an explicit-fraud-warning row pushes even when amount=0
 *  (e.g. "verify it was you" with no transaction). Threshold comes
 *  before crm-sender because amount-driven pushes are more user-visible
 *  signal than relationship priority. */
export function evaluateAnomalyGate(
	msg: InboxMessage,
	extract: TransactionalExtract,
	cfg: AnomalyConfig,
	crmHit: boolean,
): AnomalyDecision {
	if (msg.category === 'personal') {
		return { push: true, reason: 'personal' };
	}
	if (extract.kind === 'unknown') {
		return { push: false, reason: 'no-match' };
	}
	if (extract.anomalyHint) {
		return { push: true, reason: 'anomalyHint' };
	}
	if (
		extract.amount !== undefined &&
		extract.amount > cfg.thresholdAmount &&
		extract.currency === cfg.thresholdCurrency
	) {
		return { push: true, reason: 'threshold' };
	}
	if (crmHit && msg.category === 'transactional') {
		return { push: true, reason: 'crm-sender' };
	}
	return { push: false, reason: 'no-match' };
}

/** Server-side deterministic formatter. One line per anomaly, no LLM.
 *  The trailing `(msg <id>)` token lets the user reply "what was the
 *  merchant for 33912" without ambiguity. */
export function formatAnomalyMessage(
	msg: InboxMessage,
	extract: TransactionalExtract,
	reason: AnomalyReason,
): string {
	const prefix = reasonPrefix(reason);
	const summary = summarizeExtract(msg, extract);
	return `${prefix} ${summary} (msg ${msg.id})`;
}

function reasonPrefix(reason: AnomalyReason): string {
	switch (reason) {
		case 'personal':
			return '✉️ Personal mail:';
		case 'anomalyHint':
			return '⚠️ Anomaly flag:';
		case 'threshold':
			return '💸 Large amount:';
		case 'crm-sender':
			return '🤝 CRM contact:';
		case 'no-match':
			return '(should not push)';
	}
}

function summarizeExtract(msg: InboxMessage, extract: TransactionalExtract): string {
	if (msg.category === 'personal') {
		const from = msg.fromName || msg.fromAddress || 'unknown sender';
		return `${from} — "${truncate(msg.subject, 60)}"`;
	}

	const parts: string[] = [];
	const hasAmount = extract.amount !== undefined;
	if (hasAmount && extract.currency) {
		parts.push(`${extract.currency} ${formatAmount(extract.amount!)}`);
	} else if (hasAmount) {
		parts.push(String(formatAmount(extract.amount!)));
	}
	// `@` separator only reads naturally after an amount. Without one,
	// the merchant just leads the summary.
	if (extract.merchant) {
		parts.push(hasAmount ? `@ ${extract.merchant}` : extract.merchant);
	}
	if (extract.cardLast4) parts.push(`••${extract.cardLast4}`);
	if (parts.length === 0) parts.push(truncate(msg.subject, 60));
	if (extract.note) parts.push(`— ${truncate(extract.note, 80)}`);
	return parts.join(' ');
}

function formatAmount(n: number): string {
	// Two decimals if it has fractional cents, otherwise tight.
	if (Math.round(n) === n) return n.toLocaleString('en-US');
	return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
