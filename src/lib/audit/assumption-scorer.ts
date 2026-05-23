/**
 * project-phases ADR-008 S1 — Layer A deterministic assumption-rate scorer.
 *
 * Pure function over a Claude Code session transcript (JSONL). No I/O, no
 * DB writes — those happen in S2 (scheduler handler). The scorer reads
 * the transcript content and emits three signal counts + sample claims +
 * a 0-100 composite score.
 *
 * Signals (from ADR-008 D2 Layer A):
 *
 *   - hedge:                hedge phrases within ±200 chars of a tool_use block
 *   - claim_no_verify:      concrete claims (commit SHAs, file paths, counts,
 *                           dates) appearing in assistant text WITHOUT a
 *                           preceding tool_use of Read/Bash/Grep against the
 *                           same subject in the same turn
 *   - post_hoc_corrections: phrases that admit drift after the fact
 *                           ("wait", "actually", "I was wrong", "let me re-check")
 *
 * Layer B (LLM grader) is gated separately in S3; this module's `score`
 * field is the deterministic-only score. The S3 composite will combine
 * `score` (this module) with an `llm_score` field stored on the same row.
 */

const HEDGE_PHRASES = [
	'i think',
	'i assume',
	'should be',
	'probably',
	'likely',
	'might be',
	'i believe',
	'i suspect',
	'presumably',
	'seems like',
	'appears to'
];

const POST_HOC_PHRASES = [
	'actually',
	'wait',
	'i was wrong',
	'let me re-check',
	'let me recheck',
	'let me check again',
	'i assumed but',
	'i missed',
	'correction',
	'on second look',
	'looking again',
	'scratch that',
	'i misread'
];

const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const FILE_PATH_RE = /\b(?:src|tests|\.claude|~|\/Users)[\w/.\-]*\.[a-z]{2,4}\b/g;

const HEDGE_WINDOW = 200;

export interface ScorerSignals {
	hedge: number;
	claim_no_verify: number;
	post_hoc_corrections: number;
}

export type ClaimKind = 'hedge' | 'claim_no_verify' | 'post_hoc_correction';

export interface SampleClaim {
	text: string;
	turn_index: number;
	kind: ClaimKind;
}

export interface ScorerResult {
	score: number;
	signals: ScorerSignals;
	sample_claims: SampleClaim[];
	session_id: string | null;
	turn_count: number;
}

interface Turn {
	index: number;
	role: 'assistant' | 'user' | 'system' | 'other';
	text: string;
	tool_uses: string[];
}

function parseTurns(jsonlContent: string): { turns: Turn[]; session_id: string | null } {
	const lines = jsonlContent.split('\n');
	const turns: Turn[] = [];
	let session_id: string | null = null;
	let index = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!row || typeof row !== 'object') continue;
		const r = row as Record<string, unknown>;

		if (session_id === null && typeof r.sessionId === 'string') {
			session_id = r.sessionId;
		}

		const rawType = typeof r.type === 'string' ? r.type : '';
		if (rawType !== 'assistant' && rawType !== 'user' && rawType !== 'system') continue;

		const message = r.message as Record<string, unknown> | undefined;
		const content = message?.content;

		const role: Turn['role'] =
			rawType === 'assistant' ? 'assistant' : rawType === 'user' ? 'user' : 'system';

		const textParts: string[] = [];
		const tool_uses: string[] = [];

		if (typeof content === 'string') {
			textParts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;
				if (b.type === 'text' && typeof b.text === 'string') {
					textParts.push(b.text);
				} else if (b.type === 'tool_use' && typeof b.name === 'string') {
					tool_uses.push(b.name);
				} else if (b.type === 'tool_result') {
					// Tool result content is verification material; include
					// as text so claims grounded in it can be detected as
					// "verified-in-same-turn".
					if (typeof b.content === 'string') textParts.push(b.content);
					else if (Array.isArray(b.content)) {
						for (const c of b.content) {
							if (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string') {
								textParts.push(c.text);
							}
						}
					}
				}
			}
		}

		turns.push({
			index: index++,
			role,
			text: textParts.join('\n'),
			tool_uses
		});
	}

	return { turns, session_id };
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	const lower = haystack.toLowerCase();
	const n = needle.toLowerCase();
	let count = 0;
	let from = 0;
	for (;;) {
		const i = lower.indexOf(n, from);
		if (i < 0) break;
		count++;
		from = i + n.length;
	}
	return count;
}

function findHedges(turn: Turn): SampleClaim[] {
	const claims: SampleClaim[] = [];
	if (turn.role !== 'assistant') return claims;
	if (turn.tool_uses.length === 0) return claims;

	const lower = turn.text.toLowerCase();
	for (const phrase of HEDGE_PHRASES) {
		let from = 0;
		for (;;) {
			const i = lower.indexOf(phrase, from);
			if (i < 0) break;
			const start = Math.max(0, i - HEDGE_WINDOW);
			const end = Math.min(turn.text.length, i + phrase.length + HEDGE_WINDOW);
			const slice = turn.text.slice(start, end);
			claims.push({
				text: slice.replace(/\s+/g, ' ').slice(0, 200).trim(),
				turn_index: turn.index,
				kind: 'hedge'
			});
			from = i + phrase.length;
		}
	}
	return claims;
}

function findPostHocCorrections(turn: Turn): SampleClaim[] {
	const claims: SampleClaim[] = [];
	if (turn.role !== 'assistant') return claims;
	const lower = turn.text.toLowerCase();
	for (const phrase of POST_HOC_PHRASES) {
		let from = 0;
		for (;;) {
			const i = lower.indexOf(phrase, from);
			if (i < 0) break;
			const start = Math.max(0, i - 80);
			const end = Math.min(turn.text.length, i + phrase.length + 120);
			claims.push({
				text: turn.text.slice(start, end).replace(/\s+/g, ' ').slice(0, 200).trim(),
				turn_index: turn.index,
				kind: 'post_hoc_correction'
			});
			from = i + phrase.length;
		}
	}
	return claims;
}

function findClaimsWithoutVerify(turn: Turn): SampleClaim[] {
	const claims: SampleClaim[] = [];
	if (turn.role !== 'assistant') return claims;

	const VERIFY_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob']);
	const verifiedInTurn = turn.tool_uses.some((t) => VERIFY_TOOLS.has(t));
	if (verifiedInTurn) return claims;

	// Look for concrete claims (commit SHAs, file paths) in text-only turns.
	const shas = Array.from(turn.text.matchAll(COMMIT_SHA_RE), (m) => m[0]).filter(
		// Filter out years and common numeric strings that match hex by coincidence.
		(s) => !/^[0-9]+$/.test(s) && s.length >= 7
	);
	const paths = Array.from(turn.text.matchAll(FILE_PATH_RE), (m) => m[0]);

	const concreteHits = [...new Set([...shas, ...paths])].slice(0, 3);
	for (const hit of concreteHits) {
		const i = turn.text.indexOf(hit);
		const start = Math.max(0, i - 80);
		const end = Math.min(turn.text.length, i + hit.length + 120);
		claims.push({
			text: turn.text.slice(start, end).replace(/\s+/g, ' ').slice(0, 200).trim(),
			turn_index: turn.index,
			kind: 'claim_no_verify'
		});
	}
	return claims;
}

function composite(signals: ScorerSignals): number {
	// Capped contributions so a single noisy turn can't saturate the score.
	const hedgePts = Math.min(30, signals.hedge * 5);
	const claimPts = Math.min(40, signals.claim_no_verify * 8);
	const correctionPts = Math.min(60, signals.post_hoc_corrections * 12);
	return Math.min(100, hedgePts + claimPts + correctionPts);
}

export function scoreTranscript(jsonlContent: string): ScorerResult {
	const { turns, session_id } = parseTurns(jsonlContent);

	let hedge = 0;
	let claim_no_verify = 0;
	let post_hoc_corrections = 0;
	const sample_claims: SampleClaim[] = [];

	for (const turn of turns) {
		const h = findHedges(turn);
		const c = findClaimsWithoutVerify(turn);
		const p = findPostHocCorrections(turn);
		hedge += h.length;
		claim_no_verify += c.length;
		post_hoc_corrections += p.length;
		sample_claims.push(...h.slice(0, 2), ...c.slice(0, 2), ...p.slice(0, 2));
	}

	const signals: ScorerSignals = { hedge, claim_no_verify, post_hoc_corrections };
	return {
		score: composite(signals),
		signals,
		sample_claims: sample_claims.slice(0, 20),
		session_id,
		turn_count: turns.length
	};
}
