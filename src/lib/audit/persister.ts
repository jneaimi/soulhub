/**
 * project-phases ADR-008 — persistence for assumption audits.
 *
 * S1 introduced the table; S2 added the read API; post-S2 hardening
 * (v13) split `audited_at` (scan-time) from `transcript_mtime` (file
 * mtime). S3 (v14) added llm_claims / llm_cost_usd / llm_model.
 */

import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';
import type { ScorerResult } from './assumption-scorer.js';
import type { LlmGraderResult } from './llm-grader.js';

export interface AuditRow {
	id: number;
	session_id: string;
	transcript_path: string;
	audited_at: number;
	transcript_mtime: number;
	score: number;
	deterministic_score: number;
	llm_score: number | null;
	signals: ScorerResult['signals'];
	sample_claims: ScorerResult['sample_claims'];
	llm_claims: LlmGraderResult['claims'] | null;
	llm_cost_usd: number | null;
	llm_model: string | null;
	linked_projects: string[];
	dismissed_at: number | null;
	dismissed_reason: string | null;
}

export interface SaveAuditInput {
	session_id: string;
	transcript_path: string;
	/** Wall-clock time the audit was performed (ms epoch). Operator
	 *  dashboard's default `?since=30d` filters on THIS, not the file
	 *  mtime — so the panel correctly shows "audits I performed
	 *  recently", not "audits of recently-active sessions". */
	audited_at: number;
	/** File mtime at scan time (ms epoch). Used by the scanner's
	 *  watermark — files whose mtime is ≤ latest stored transcript_mtime
	 *  are skipped. */
	transcript_mtime: number;
	scorer_result: ScorerResult;
	linked_projects: string[];
	/** Optional LLM grader result (S3). When omitted, llm_* columns
	 *  stay null and `score` falls back to the deterministic score. */
	llm_result?: LlmGraderResult | null;
}

/** Composite score per ADR-008 D2: 0.6*llm + 0.4*deterministic when
 *  Layer B available; deterministic alone otherwise. Clamped to 0-100. */
function compositeScore(deterministic: number, llm: number | null): number {
	if (llm === null) return deterministic;
	return Math.min(100, Math.round(0.6 * llm + 0.4 * deterministic));
}

export function saveAudit(input: SaveAuditInput): number {
	const db = getHeartbeatDb();
	const det = input.scorer_result.score;
	const llm = input.llm_result?.llm_score ?? null;
	const composite = compositeScore(det, llm);

	const stmt = db.prepare(`
		INSERT INTO assumption_audits (
			session_id, transcript_path, audited_at, transcript_mtime,
			score, deterministic_score, llm_score,
			signals, sample_claims, linked_projects,
			llm_claims, llm_cost_usd, llm_model
		) VALUES (
			@session_id, @transcript_path, @audited_at, @transcript_mtime,
			@score, @deterministic_score, @llm_score,
			@signals, @sample_claims, @linked_projects,
			@llm_claims, @llm_cost_usd, @llm_model
		)
	`);
	const info = stmt.run({
		session_id: input.session_id,
		transcript_path: input.transcript_path,
		audited_at: input.audited_at,
		transcript_mtime: input.transcript_mtime,
		score: composite,
		deterministic_score: det,
		llm_score: llm,
		signals: JSON.stringify(input.scorer_result.signals),
		sample_claims: JSON.stringify(input.scorer_result.sample_claims),
		linked_projects: JSON.stringify(input.linked_projects),
		llm_claims: input.llm_result ? JSON.stringify(input.llm_result.claims) : null,
		llm_cost_usd: input.llm_result?.cost_usd ?? null,
		llm_model: input.llm_result?.model ?? null
	});
	return Number(info.lastInsertRowid);
}

interface RawAuditRow {
	id: number;
	session_id: string;
	transcript_path: string;
	audited_at: number;
	transcript_mtime: number;
	score: number;
	deterministic_score: number;
	llm_score: number | null;
	signals: string;
	sample_claims: string;
	linked_projects: string;
	llm_claims: string | null;
	llm_cost_usd: number | null;
	llm_model: string | null;
	dismissed_at: number | null;
	dismissed_reason: string | null;
}

function decode(r: RawAuditRow): AuditRow {
	return {
		id: r.id,
		session_id: r.session_id,
		transcript_path: r.transcript_path,
		audited_at: r.audited_at,
		transcript_mtime: r.transcript_mtime,
		score: r.score,
		deterministic_score: r.deterministic_score,
		llm_score: r.llm_score,
		signals: JSON.parse(r.signals) as ScorerResult['signals'],
		sample_claims: JSON.parse(r.sample_claims) as ScorerResult['sample_claims'],
		linked_projects: JSON.parse(r.linked_projects) as string[],
		llm_claims: r.llm_claims
			? (JSON.parse(r.llm_claims) as LlmGraderResult['claims'])
			: null,
		llm_cost_usd: r.llm_cost_usd,
		llm_model: r.llm_model,
		dismissed_at: r.dismissed_at,
		dismissed_reason: r.dismissed_reason
	};
}

export interface QueryAuditsOptions {
	/** Filter to audits whose `linked_projects` JSON-array contains this slug. */
	project?: string;
	/** projects-graph ADR-004 — filter to audits whose `linked_projects`
	 *  contains ANY of these slugs (OR semantics). Used by the parent-
	 *  rollup AssumptionAuditPanel so a parent project surfaces high-
	 *  severity claims from any descendant. Combines with `project` if
	 *  both are passed (project must match AND projects OR-match). */
	projects?: string[];
	/** Lower-bound on audited_at (ms epoch); inclusive. */
	since?: number;
	/** Max rows to return. Default 50, capped at 500. */
	limit?: number;
	/** Include audits the operator dismissed as false positives. Default false. */
	include_dismissed?: boolean;
}

/** Latest-per-session view: when a transcript is re-audited (file grew),
 *  return only the most recent row for that session_id. Project filtering
 *  applied AFTER de-dup. */
export function queryAudits(opts: QueryAuditsOptions = {}): AuditRow[] {
	const db = getHeartbeatDb();
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

	const sql = `
		SELECT * FROM assumption_audits
		WHERE id IN (
			SELECT MAX(id) FROM assumption_audits
			${opts.since ? 'WHERE audited_at >= @since' : ''}
			GROUP BY session_id
		)
		${opts.include_dismissed ? '' : 'AND dismissed_at IS NULL'}
		ORDER BY audited_at DESC, id DESC
		LIMIT @oversize
	`;
	const rows = db
		.prepare(sql)
		.all({ since: opts.since ?? 0, oversize: limit * 4 }) as RawAuditRow[];
	const decoded = rows.map(decode);

	const slug = opts.project;
	const slugSet = opts.projects && opts.projects.length > 0 ? new Set(opts.projects) : null;
	if (!slug && !slugSet) return decoded.slice(0, limit);

	return decoded
		.filter((r) => {
			if (slug && !r.linked_projects.includes(slug)) return false;
			if (slugSet && !r.linked_projects.some((p) => slugSet.has(p))) return false;
			return true;
		})
		.slice(0, limit);
}

/** Bucket counts (high/medium/low) over the same set queryAudits would
 *  return. Used by the operator dashboard. */
export function countAudits(opts: QueryAuditsOptions = {}): {
	high_score: number;
	medium_score: number;
	low_score: number;
} {
	const rows = queryAudits({ ...opts, limit: 500 });
	let high = 0;
	let medium = 0;
	let low = 0;
	for (const r of rows) {
		if (r.score > 70) high++;
		else if (r.score >= 40) medium++;
		else low++;
	}
	return { high_score: high, medium_score: medium, low_score: low };
}

/** Latest transcript_mtime per transcript_path — used by the scheduler
 *  scanner to skip transcripts whose file mtime hasn't advanced since
 *  the last audit. (Renamed from `latestAuditedAtByPath` in post-S2
 *  hardening; the rename is the load-bearing change for correctness —
 *  the old function compared mtime to scan-time, which masked
 *  re-auditing intent.) */
export function latestTranscriptMtimeByPath(): Map<string, number> {
	const db = getHeartbeatDb();
	const rows = db
		.prepare(
			`SELECT transcript_path, MAX(transcript_mtime) AS last_mtime
			 FROM assumption_audits
			 GROUP BY transcript_path`
		)
		.all() as Array<{ transcript_path: string; last_mtime: number }>;
	const map = new Map<string, number>();
	for (const r of rows) map.set(r.transcript_path, r.last_mtime);
	return map;
}

/** Test-only helper: wipe the table between fixture runs. */
export function _clearAuditsForTests(): void {
	const db = getHeartbeatDb();
	db.exec('DELETE FROM assumption_audits;');
}
