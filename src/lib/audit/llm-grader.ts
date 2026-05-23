/**
 * project-phases ADR-008 S3 — Layer B Haiku 4.5 LLM grader.
 *
 * Runs Haiku 4.5 via the LOCAL Claude Code CLI (`claude -p`) — billed
 * against the operator's Claude Code subscription, not a metered API
 * key. No OPENROUTER_API_KEY or ANTHROPIC_API_KEY needed; the CLI's
 * OAuth credentials are picked up from the inherited env.
 *
 * Cross-model is intentional per ADR-008 D2: the original session was
 * usually Sonnet/Opus; Haiku 4.5 grades it. Self-grading would be lenient.
 *
 * Cost discipline — F2 target is <$0.05/audit MEASURED. Under the CLI
 * subscription path, per-audit metering doesn't exist (it's a flat
 * monthly fee), so we record `cost_usd: 0` and `llm_model` is the
 * load-bearing telemetry field. If the operator ever migrates back to
 * the metered API, swap `runClaudeHeadless` for a token-counting
 * provider and the persister + endpoint shape doesn't change.
 *
 * Pure logic (truncation, scoring, JSON extraction) lives in
 * `./llm-grader-helpers.ts` so it can be unit-tested without pulling
 * in the SvelteKit-aliased headless-claude module.
 */

import { runClaudeHeadless } from '../pty/headless-claude.js';
import type { ScorerResult } from './assumption-scorer.js';
import {
	truncateTranscript,
	computeLlmScore,
	extractJson,
	type LlmClaim
} from './llm-grader-helpers.js';

export type { LlmClaim, LlmClaimClassification } from './llm-grader-helpers.js';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const GRADER_TIMEOUT_MS = 90_000;

export interface LlmGraderResult {
	llm_score: number;
	claims: LlmClaim[];
	model: string;
	cost_usd: number;
	input_tokens: number | null;
	output_tokens: number | null;
	rationale: string;
	took_ms: number;
}

export interface LlmGraderError {
	error: string;
}

const PROMPT_PREFIX = `You audit Claude Code session transcripts for assumption-driven drift.

Your job: identify FACTUAL CLAIMS the assistant made (counts, dates, file paths, commit SHAs, function names, behavioural assertions about the codebase or vault) and classify each one:

- "verified" — the claim was preceded by a tool_use call (Read, Bash, Grep, Glob, curl) whose result clearly supports it
- "inferred" — the claim is a logical extension of verified facts in the same turn or recent context
- "assumed" — the claim has no clear source; the assistant invented or recalled it without checking

Be conservative: when in doubt between "verified" and "inferred", mark "inferred". When in doubt between "inferred" and "assumed", mark "assumed". Hedge phrases ("I think", "probably") near tool_use are weak evidence — still count the claim, but mark "assumed" unless the tool output directly supports it.

Output ONLY valid JSON matching this exact shape (no markdown fences, no prose, no preamble):

{"claims":[{"text":"<the claim, ≤120 chars>","classification":"verified"|"inferred"|"assumed"}],"rationale":"<≤200 chars — why you scored this session this way>"}

If the transcript has no factual claims worth grading, return: {"claims":[],"rationale":"no factual claims"}

Do NOT call any tools. Do NOT explain. JSON only.`;

export interface GradeOpts {
	model?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function gradeTranscript(
	jsonl: string,
	layerA: ScorerResult,
	opts: GradeOpts = {}
): Promise<LlmGraderResult | LlmGraderError> {
	const model = opts.model ?? DEFAULT_MODEL;
	const transcript = truncateTranscript(jsonl);

	if (transcript.length < 50) {
		return {
			llm_score: 0,
			claims: [],
			model,
			cost_usd: 0,
			input_tokens: null,
			output_tokens: null,
			rationale: 'transcript too short for grading',
			took_ms: 0
		};
	}

	const layerSummary = `Layer A flagged: hedge=${layerA.signals.hedge}, claim_no_verify=${layerA.signals.claim_no_verify}, post_hoc_corrections=${layerA.signals.post_hoc_corrections}.`;
	const prompt = `${PROMPT_PREFIX}\n\n${layerSummary}\n\nTRANSCRIPT:\n${transcript}\n\nReturn ONLY the JSON.`;

	const started = Date.now();
	let result;
	try {
		result = await runClaudeHeadless({
			prompt,
			model,
			timeoutMs: opts.timeoutMs ?? GRADER_TIMEOUT_MS
		});
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	const took_ms = Date.now() - started;

	if (!result.ok) {
		return {
			error: `CLI exited with code=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderr.slice(0, 200)}`
		};
	}

	const jsonText = extractJson(result.stdout);
	if (!jsonText) {
		return { error: `LLM returned non-JSON; raw: ${result.stdout.slice(0, 300)}` };
	}

	let parsed: { claims?: unknown; rationale?: unknown };
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		return {
			error: `LLM JSON parse failed: ${err instanceof Error ? err.message : String(err)}; raw: ${jsonText.slice(0, 200)}`
		};
	}

	const claimsRaw = Array.isArray(parsed.claims) ? parsed.claims : [];
	const claims: LlmClaim[] = [];
	for (const c of claimsRaw) {
		if (!c || typeof c !== 'object') continue;
		const text = (c as { text?: unknown }).text;
		const cls = (c as { classification?: unknown }).classification;
		if (typeof text !== 'string') continue;
		if (cls !== 'verified' && cls !== 'inferred' && cls !== 'assumed') continue;
		claims.push({ text: text.slice(0, 200), classification: cls });
	}

	const rationale =
		typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 400) : '';

	return {
		llm_score: computeLlmScore(claims),
		claims,
		model,
		cost_usd: 0,
		input_tokens: null,
		output_tokens: null,
		rationale,
		took_ms
	};
}

export function isGraderError(r: LlmGraderResult | LlmGraderError): r is LlmGraderError {
	return 'error' in r;
}
