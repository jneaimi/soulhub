/** Scheduler handler: audit-assumption-rate-scan (project-phases ADR-008 S2 + S3).
 *
 *  Periodic offline scan of Claude Code session transcripts. Layer A
 *  (deterministic scorer) runs always; Layer B (Haiku 4.5 LLM grader)
 *  runs when `params.llmGrading === true` AND the deterministic score
 *  cleared `params.llmGradingThreshold` (default 20) — keeps the LLM
 *  bill low by skipping obviously-clean sessions.
 *
 *  Settings shape:
 *    {
 *      id: 'audit-assumption-rate-scan',
 *      type: 'audit-assumption-rate',
 *      cron: '0 *​/6 * * *',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        maxCandidates?: 50,           // cap per tick; default 50
 *        minScoreToStore?: 0,          // store every audit; UI filters
 *        llmGrading?: false,           // S3 — turn on for Layer B
 *        llmGradingThreshold?: 20,     // skip LLM for det score < this
 *        llmGradingModel?: 'anthropic/claude-haiku-4-5'
 *      }
 *    }
 */

import { readFileSync } from 'node:fs';
import { scoreTranscript } from '../../audit/assumption-scorer.js';
import { extractLinkedProjects } from '../../audit/extract-linked-projects.js';
import { saveAudit, latestTranscriptMtimeByPath } from '../../audit/persister.js';
import { scanTranscripts } from '../../audit/scan-transcripts.js';
import { gradeTranscript, isGraderError } from '../../audit/llm-grader.js';
import type { LlmGraderResult } from '../../audit/llm-grader.js';
import type { TaskFn } from '../task-types.js';

interface AuditAssumptionRateParams {
	maxCandidates?: number;
	minScoreToStore?: number;
	llmGrading?: boolean;
	llmGradingThreshold?: number;
	llmGradingModel?: string;
}

export interface AuditScanSummary {
	scanned_dirs: number;
	candidates: number;
	skipped_unchanged: number;
	skipped_empty: number;
	scored: number;
	stored: number;
	skipped_below_threshold: number;
	failed: number;
	high_score_audits: number;
	cumulative_score_sum: number;
	llm_graded: number;
	llm_skipped_below_threshold: number;
	llm_failed: number;
	llm_total_cost_usd: number;
	took_ms: number;
}

export function auditAssumptionRateFactory(rawParams: unknown): TaskFn {
	const params: AuditAssumptionRateParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as AuditAssumptionRateParams)
			: {};
	const maxCandidates = params.maxCandidates ?? 50;
	const minScoreToStore = params.minScoreToStore ?? 0;
	const llmGrading = params.llmGrading === true;
	const llmGradingThreshold = params.llmGradingThreshold ?? 20;
	const llmGradingModel = params.llmGradingModel;

	return async (ctx) => {
		const startedAt = Date.now();
		const summary: AuditScanSummary = {
			scanned_dirs: 0,
			candidates: 0,
			skipped_unchanged: 0,
			skipped_empty: 0,
			scored: 0,
			stored: 0,
			skipped_below_threshold: 0,
			failed: 0,
			high_score_audits: 0,
			cumulative_score_sum: 0,
			llm_graded: 0,
			llm_skipped_below_threshold: 0,
			llm_failed: 0,
			llm_total_cost_usd: 0,
			took_ms: 0
		};

		const watermark = latestTranscriptMtimeByPath();
		const scan = scanTranscripts({
			latestAuditedAtByPath: watermark,
			maxCandidates
		});
		summary.scanned_dirs = scan.scanned_dirs;
		summary.candidates = scan.candidates.length;
		summary.skipped_unchanged = scan.skipped_unchanged;
		summary.skipped_empty = scan.skipped_empty;

		for (const candidate of scan.candidates) {
			if (ctx?.signal.aborted) break;
			try {
				const content = readFileSync(candidate.path, 'utf8');
				const layerA = scoreTranscript(content);
				summary.scored++;
				summary.cumulative_score_sum += layerA.score;
				if (layerA.score > 70) summary.high_score_audits++;

				if (layerA.score < minScoreToStore) {
					summary.skipped_below_threshold++;
					continue;
				}

				let llmResult: LlmGraderResult | null = null;
				if (llmGrading) {
					if (layerA.score < llmGradingThreshold) {
						summary.llm_skipped_below_threshold++;
					} else {
						const r = await gradeTranscript(content, layerA, {
							model: llmGradingModel,
							signal: ctx?.signal
						});
						if (isGraderError(r)) {
							summary.llm_failed++;
							console.error(
								`[audit-assumption-rate] LLM grader failed for ${candidate.path}: ${r.error}`
							);
						} else {
							llmResult = r;
							summary.llm_graded++;
							summary.llm_total_cost_usd += r.cost_usd;
						}
					}
				}

				const projects = extractLinkedProjects(content);
				saveAudit({
					session_id: layerA.session_id ?? candidate.path.split('/').pop() ?? '',
					transcript_path: candidate.path,
					audited_at: Date.now(),
					transcript_mtime: Math.round(candidate.mtime_ms),
					scorer_result: layerA,
					linked_projects: projects,
					llm_result: llmResult
				});
				summary.stored++;
			} catch (err) {
				summary.failed++;
				console.error(
					`[audit-assumption-rate] failed for ${candidate.path}:`,
					err instanceof Error ? err.message : err
				);
			}
		}

		summary.took_ms = Date.now() - startedAt;
		summary.llm_total_cost_usd = Number(summary.llm_total_cost_usd.toFixed(6));
		return summary;
	};
}
