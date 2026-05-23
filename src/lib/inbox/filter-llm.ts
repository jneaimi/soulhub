/**
 * Layer 2 filter — LLM batch classifier (claude -p).
 *
 * Calls Claude Code headless for the gray-area messages that rules can't
 * classify. Batches 5-10 messages per invocation so the per-call overhead
 * amortizes. Robust JSON extraction (3 fallback strategies) handles the
 * Claude Code wrapper adding incidental text.
 *
 * Security: `allowedTools: []` — the classifier should only emit text.
 * No file reads, no Bash, no WebFetch. The prompt also tells Claude to
 * output JSON only.
 *
 * Failure modes are classified (auth | rate-limit | timeout | parse |
 * spawn | network | unknown) so the worker's retry policy can react
 * differently per class — see ADR §D-Failure.
 */

import {
	runClaudeHeadless,
	type HeadlessClaudeResult,
} from '../pty/headless-claude.js';
import type { FilterCategory } from './types.js';

export const CATEGORIES: readonly FilterCategory[] = [
	'personal',
	'transactional',
	'notification',
	'promotional',
	'bulk',
	'unclassified',
];

export interface BatchEntry {
	/** DB row id — used as the index in the prompt + response JSON. */
	id: number;
	fromAddress: string;
	subject: string;
	bodyPreview: string;
}

export interface ClassifiedResult {
	id: number;
	category: FilterCategory;
	rationale: string;
}

export type LLMErrorClass =
	| 'auth'
	| 'rate-limit'
	| 'timeout'
	| 'parse'
	| 'spawn'
	| 'network'
	| 'unknown';

export interface LLMSuccess {
	ok: true;
	results: ClassifiedResult[];
	durationMs: number;
	raw: string;
}

export interface LLMFailure {
	ok: false;
	errorClass: LLMErrorClass;
	message: string;
	durationMs: number;
	raw: string;
}

export type LLMOutcome = LLMSuccess | LLMFailure;

/**
 * One-shot auth probe used at worker startup. Calls Claude with a trivial
 * prompt; checks for any auth-related signal in stderr. Returns true when
 * the classifier is usable, false otherwise.
 *
 * False → worker still runs (rules-only mode); a Telegram alert fires.
 */
export async function probeClaudeAuth(): Promise<{ ok: boolean; message: string }> {
	try {
		const result = await runClaudeHeadless({
			prompt: 'Reply with exactly the word: ok',
			model: 'claude-haiku-4-5',
			timeoutMs: 15_000,
			allowedTools: [],
		});
		if (result.ok && /\bok\b/i.test(result.stdout)) {
			return { ok: true, message: 'probe ok' };
		}
		const cls = classifyError(result);
		return {
			ok: false,
			message: `probe failed (${cls}): ${(result.stderr || result.stdout || '').slice(0, 200)}`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `probe threw: ${(err as Error).message}`,
		};
	}
}

/**
 * Classify a batch via `claude -p`. Throws nothing — wraps every failure
 * mode into an LLMFailure with an errorClass the worker can react to.
 */
export async function classifyBatch(
	batch: BatchEntry[],
	opts: { timeoutMs?: number; model?: string } = {},
): Promise<LLMOutcome> {
	const prompt = buildBatchPrompt(batch);
	let result: HeadlessClaudeResult;
	try {
		result = await runClaudeHeadless({
			prompt,
			model: opts.model ?? 'claude-haiku-4-5',
			timeoutMs: opts.timeoutMs ?? 30_000,
			allowedTools: [],
		});
	} catch (err) {
		return {
			ok: false,
			errorClass: 'spawn',
			message: (err as Error).message ?? String(err),
			durationMs: 0,
			raw: '',
		};
	}

	if (!result.ok) {
		return {
			ok: false,
			errorClass: classifyError(result),
			message: (result.stderr || result.stdout || 'unknown failure').slice(0, 500),
			durationMs: result.durationMs,
			raw: result.stdout,
		};
	}

	const parsed = parseClassifierOutput(result.stdout, batch);
	if (parsed === null) {
		return {
			ok: false,
			errorClass: 'parse',
			message: 'No valid JSON `results` object in stdout',
			durationMs: result.durationMs,
			raw: result.stdout,
		};
	}

	return {
		ok: true,
		results: parsed,
		durationMs: result.durationMs,
		raw: result.stdout,
	};
}

// ── Prompt building ──

function buildBatchPrompt(batch: BatchEntry[]): string {
	const head = [
		'You are classifying emails into one of 6 categories. Output JSON only — no markdown, no prose, no code fences.',
		'',
		'Categories:',
		'- personal: human-to-human mail you want a person to see',
		'- transactional: bank alerts, order confirmations, receipts, OTPs, account status changes',
		'- notification: automated service notifications (npm tokens, GitHub mentions, deploy success, calendar pings)',
		'- promotional: newsletters, marketing, product updates',
		'- bulk: generic list-server traffic that does not fit other categories',
		'- unclassified: only if genuinely unclear after considering the above',
		'',
		'Output format (single line, valid JSON, no trailing commas):',
		'{"results":[{"id":N,"category":"...","rationale":"<one-line>"}]}',
		'',
		'Emails:',
	];
	const lines = [head.join('\n')];
	for (const entry of batch) {
		const preview = entry.bodyPreview.replace(/\s+/g, ' ').slice(0, 280);
		lines.push(
			`[${entry.id}] From: ${entry.fromAddress}\n    Subject: ${entry.subject}\n    Preview: ${preview}`,
		);
	}
	return lines.join('\n');
}

// ── Output extraction ──

/**
 * Robust extraction. Three strategies, applied in order:
 *   1. Find a JSON object containing `"results"`. If parse succeeds, validate.
 *   2. Strip Claude Code wrapper text (anything before the first '{') and retry.
 *   3. Fall back to scanning for per-result objects (`{"id":N,"category":"..."}`).
 *
 * Returns the parsed result list, or null if all strategies fail.
 * Invalid entries (unknown category, unknown id) are silently dropped — the
 * worker treats missing results as "leave row in `new`, retry next tick".
 */
export function parseClassifierOutput(
	stdout: string,
	batch: BatchEntry[],
): ClassifiedResult[] | null {
	const validIds = new Set(batch.map((b) => b.id));

	const valid = (results: unknown[]): ClassifiedResult[] => {
		const out: ClassifiedResult[] = [];
		for (const r of results) {
			if (!r || typeof r !== 'object') continue;
			const obj = r as Record<string, unknown>;
			const id = typeof obj.id === 'number' ? obj.id : Number(obj.id);
			const category = typeof obj.category === 'string' ? obj.category : null;
			if (!Number.isFinite(id) || !validIds.has(id)) continue;
			if (!category || !(CATEGORIES as readonly string[]).includes(category)) continue;
			out.push({
				id,
				category: category as FilterCategory,
				rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
			});
		}
		return out;
	};

	// Strategy 1: any object containing "results".
	const m1 = stdout.match(/\{[^{}]*"results"[\s\S]*?\}\s*\]?\s*\}/);
	if (m1) {
		try {
			const parsed = JSON.parse(m1[0]) as { results?: unknown[] };
			if (parsed && Array.isArray(parsed.results)) {
				const out = valid(parsed.results);
				if (out.length > 0) return out;
			}
		} catch {
			/* fall through */
		}
	}

	// Strategy 2: trim wrapper text and try again on the largest balanced JSON.
	const start = stdout.indexOf('{');
	if (start >= 0) {
		const candidate = extractBalancedJson(stdout.slice(start));
		if (candidate) {
			try {
				const parsed = JSON.parse(candidate) as { results?: unknown[] };
				if (parsed && Array.isArray(parsed.results)) {
					const out = valid(parsed.results);
					if (out.length > 0) return out;
				}
			} catch {
				/* fall through */
			}
		}
	}

	// Strategy 3: scan for per-result objects.
	const itemRe = /\{\s*"id"\s*:\s*(-?\d+)\s*,\s*"category"\s*:\s*"([^"]+)"(?:\s*,\s*"rationale"\s*:\s*"([^"]*)")?\s*\}/g;
	const items: unknown[] = [];
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(stdout)) !== null) {
		items.push({ id: Number(m[1]), category: m[2], rationale: m[3] ?? '' });
	}
	if (items.length > 0) {
		const out = valid(items);
		if (out.length > 0) return out;
	}

	return null;
}

/** Pull the first balanced `{...}` substring starting at index 0 (or null). */
function extractBalancedJson(s: string): string | null {
	if (s[0] !== '{') return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return s.slice(0, i + 1);
		}
	}
	return null;
}

// ── Error classification ──

/**
 * Map a HeadlessClaudeResult into an LLMErrorClass for the worker's retry
 * policy. Looks at timedOut first, then sniffs stderr/stdout for known
 * markers.
 */
export function classifyError(result: HeadlessClaudeResult): LLMErrorClass {
	if (result.timedOut) return 'timeout';
	const blob = ((result.stderr || '') + '\n' + (result.stdout || '')).toLowerCase();
	if (/\b(not authenticated|auth required|please log in|authentication failed|unauthorized)\b/.test(blob)) return 'auth';
	if (/\b(rate limit|quota|429|too many requests)\b/.test(blob)) return 'rate-limit';
	if (/\b(enotfound|econnrefused|econnreset|etimedout|dns|network)\b/.test(blob)) return 'network';
	if (result.exitCode === 127 || /command not found/.test(blob)) return 'spawn';
	return 'unknown';
}
