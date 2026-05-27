/**
 * projects-graph ADR-028 — Robust implementer hand-back parsing.
 *
 * Single shared module for parsing the soul-hub-implementer hand-back JSON.
 * All three consumers (AdrDrawer, worklist endpoint, ship-merge endpoint)
 * import from here — no more duplicate inline copies.
 *
 * Tolerant: tries strict JSON.parse first (unchanged for well-formed output);
 * on parse failure falls back to field-level extraction so a malformed
 * display-only field (summary / follow_ups with raw unescaped quotes) can
 * never downgrade a gating decision.
 *
 * Pure: no DB, no vault, no SvelteKit. Safe to import from tests and Svelte.
 */

/** Shape of the hand-back JSON emitted by the soul-hub-implementer agent. */
export interface ParsedHandback {
	branch: string;
	commits: string[];
	files_changed: string[];
	check_passed: boolean;
	build_passed: boolean;
	/**
	 * gate_results values — interpreted by `isGateGreen` / `handbackGatesGreen` (ADR-033).
	 * Green iff the value contains a pass token AND no fail token AND is not negated:
	 *   "pass", "pass (current=0, baseline=0)", "passed", "PASS" → green
	 *   "14/14 pass (details)", "3/3 pass", "✓ pass", "passing"  → green
	 *   "fail", "fail (2 errors)", "1 failed 13 pass", "✗"        → red
	 *   "did not pass", "tests did not pass"                       → red (negated)
	 *   "skipped", "warn", "pending", "0 == baseline 0"            → red (no pass token)
	 */
	gate_results: Record<string, string>;
	/** Display-only — may be empty string if unescaped quotes prevented extraction. */
	summary: string;
	/** Display-only — may be [] if unescaped content prevented extraction. */
	follow_ups: string[];
}

/**
 * @deprecated Use ParsedHandback — kept for ADR-026 callers until they migrate.
 */
export type HandBack = ParsedHandback;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract the LAST ```json…``` fenced block inner content from `text`. */
function extractLastFencedJson(text: string): string | null {
	let last: string | null = null;
	const fence = /```json\s*([\s\S]*?)\s*```/gi;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(text)) !== null) last = m[1];
	return last;
}

/** Depth-track `{…}` to extract the LAST top-level JSON object in `text`. */
function extractLastObjectBlock(text: string): string | null {
	const lastBrace = text.lastIndexOf('{');
	if (lastBrace < 0) return null;
	let depth = 0;
	let end = -1;
	for (let i = lastBrace; i < text.length; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}') {
			if (--depth === 0) {
				end = i;
				break;
			}
		}
	}
	return end > lastBrace ? text.slice(lastBrace, end + 1) : null;
}

/** Depth-track `[…]` to extract a JSON array starting after `key` in `raw`. */
function extractJsonArray(raw: string, key: string): string[] {
	const idx = raw.indexOf(`"${key}"`);
	if (idx === -1) return [];
	const start = raw.indexOf('[', idx);
	if (start === -1) return [];
	let depth = 0;
	let end = -1;
	for (let i = start; i < raw.length; i++) {
		if (raw[i] === '[') depth++;
		else if (raw[i] === ']') {
			if (--depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end <= start) return [];
	try {
		const arr: unknown = JSON.parse(raw.slice(start, end + 1));
		return Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as string[]) : [];
	} catch {
		return [];
	}
}

/** Depth-track `{…}` to extract the gate_results object from `raw`. */
function extractGateResults(raw: string): Record<string, string> {
	const grIdx = raw.indexOf('"gate_results"');
	if (grIdx === -1) return {};
	const brace = raw.indexOf('{', grIdx);
	if (brace === -1) return {};
	let depth = 0;
	let end = -1;
	for (let i = brace; i < raw.length; i++) {
		if (raw[i] === '{') depth++;
		else if (raw[i] === '}') {
			if (--depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end <= brace) return {};
	try {
		const obj: unknown = JSON.parse(raw.slice(brace, end + 1));
		return typeof obj === 'object' && obj !== null ? (obj as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Minimum validity: a parseable hand-back must have a non-empty branch string. */
function hasValidBranch(v: unknown): boolean {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.branch === 'string' && o.branch.length > 0;
}

/** Coerce a loosely-parsed object into a full ParsedHandback, defaulting any
 *  missing or wrong-typed fields. Called after a successful strict JSON.parse. */
function coerce(o: Record<string, unknown>): ParsedHandback {
	return {
		branch: String(o.branch ?? ''),
		commits: Array.isArray(o.commits)
			? (o.commits.filter((x) => typeof x === 'string') as string[])
			: [],
		files_changed: Array.isArray(o.files_changed)
			? (o.files_changed.filter((x) => typeof x === 'string') as string[])
			: [],
		check_passed: o.check_passed === true,
		build_passed: o.build_passed === true,
		gate_results:
			typeof o.gate_results === 'object' && o.gate_results !== null
				? (o.gate_results as Record<string, string>)
				: {},
		summary: typeof o.summary === 'string' ? o.summary : '',
		follow_ups: Array.isArray(o.follow_ups)
			? (o.follow_ups.filter((x) => typeof x === 'string') as string[])
			: [],
	};
}

/**
 * Tolerant fallback: extract load-bearing fields directly from a raw JSON
 * block via targeted, quote-safe regexes. Called ONLY when strict JSON.parse
 * fails — typically because `summary` or `follow_ups` contain unescaped quotes.
 *
 * Rule: a malformed display-only field can NEVER downgrade a gating decision.
 * Gates (check_passed, build_passed, gate_results) and branch are recovered
 * as long as *they* are well-formed. summary / follow_ups are best-effort —
 * empty string / [] on failure, never a parse error.
 */
function tolerantExtract(raw: string): ParsedHandback | null {
	// branch — git branch names never contain double-quotes, so this is safe.
	const branchM = /"branch"\s*:\s*"([^"]+)"/.exec(raw);
	if (!branchM) return null; // branch is the validity signal

	const check_passed = /"check_passed"\s*:\s*true/.test(raw);
	const build_passed = /"build_passed"\s*:\s*true/.test(raw);
	const gate_results = extractGateResults(raw);

	const commits = extractJsonArray(raw, 'commits');
	const files_changed = extractJsonArray(raw, 'files_changed');

	// summary — best-effort. The regex captures a valid JSON string value
	// (escaped chars OK, stops at first raw unescaped quote). Then re-parse
	// the captured content as a JSON string to unescape `\n`, `\"` etc.
	// If THAT fails for any reason, summary stays ''.
	let summary = '';
	try {
		const sM = /"summary"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(raw);
		if (sM) {
			summary = JSON.parse(`"${sM[1]}"`);
		}
	} catch {
		// unescaped quote mid-value — silently leave ''
	}

	// follow_ups — best-effort array (depth-tracked extraction handles quoted items)
	const follow_ups = extractJsonArray(raw, 'follow_ups');

	return {
		branch: branchM[1],
		commits,
		files_changed,
		check_passed,
		build_passed,
		gate_results,
		summary,
		follow_ups,
	};
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse the soul-hub-implementer hand-back from agent output or a DB row.
 *
 * Algorithm (ADR-028):
 *  1. Extract the LAST ```json…``` fenced block (the hand-back is always last).
 *  2. Try strict JSON.parse — happy path; unchanged for well-formed hand-backs.
 *  3. On parse failure: tolerant field extraction (branch/check_passed/
 *     build_passed/gate_results via quote-safe regexes; summary/follow_ups
 *     best-effort — never allowed to fail the parse).
 *  4. If no fence, try the last bare `{…}` block with the same 2→3 logic.
 *
 * Returns null only when `branch` cannot be recovered at all. Never throws.
 */
export function parseHandback(raw: string | null): ParsedHandback | null {
	if (!raw) return null;

	// Step 1: Try the LAST fenced block (hand-back is always the final fence).
	const fenced = extractLastFencedJson(raw);
	if (fenced) {
		// Step 2: strict parse
		try {
			const p: unknown = JSON.parse(fenced);
			if (hasValidBranch(p)) return coerce(p as Record<string, unknown>);
		} catch {
			// Step 3: tolerant fallback within the fenced content
		}
		const t = tolerantExtract(fenced);
		if (t) return t;
	}

	// Step 4: No fence (or fence parse failed) — try the last bare `{…}` block.
	const bare = extractLastObjectBlock(raw);
	if (bare) {
		try {
			const p: unknown = JSON.parse(bare);
			if (hasValidBranch(p)) return coerce(p as Record<string, unknown>);
		} catch {
			// tolerant fallback on the bare block
		}
		const t = tolerantExtract(bare);
		if (t) return t;
	}

	return null;
}

/**
 * True iff a single gate_results string value is green — content-aware, fail-closed (ADR-033).
 *
 * A trimmed gate value is green iff ALL three hold:
 *  1. Contains a pass token — `/\bpass(ed|ing)?\b/i`
 *     (covers "pass", "14/14 pass", "pass (details)", "passing", "passed")
 *  2. Does NOT contain a fail token — `/\bfail(ed|ures?|ings?)?\b/i`, `✗`, or `❌`
 *     (so "1 failed, 13 pass", "passed but 2 failures", and "✗ 2 failing" stay red)
 *  3. Is NOT a negated pass — `/\b(no|not|never|without)\b[^.]*\bpass/i` or
 *     `/\bdid\s?n[o']?t\b[^.]*\bpass/i`
 *     (so "did not pass" / "tests did not pass" stay red)
 *
 * Ambiguous values with neither a pass nor a fail token stay red — fail-closed.
 * Note: "error"/"errors" is deliberately NOT a fail token; green typecheck values
 * legitimately read "pass — 0 errors == baseline 0".
 *
 * Supersedes ADR-029's `/^pass/i` prefix match which could not handle count-prefixed
 * values such as "14/14 pass (5 ADR-016 + 7 ADR-018 falsifiers)".
 */
export function isGateGreen(v: string): boolean {
	const t = v.trim();
	const hasPass = /\bpass(ed|ing)?\b/i.test(t);
	if (!hasPass) return false;
	const hasFail = /\bfail(ed|ures?|ings?)?\b/i.test(t) || t.includes('✗') || t.includes('❌');
	if (hasFail) return false;
	const negated =
		/\b(no|not|never|without)\b[^.]*\bpass/i.test(t) ||
		/\bdid\s?n[o']?t\b[^.]*\bpass/i.test(t);
	return !negated;
}

/**
 * True when all code-review gates are green:
 * check_passed, build_passed (exact boolean true), and every gate_results value
 * is green per `isGateGreen` (ADR-033 content-based matching).
 *
 * Why content-based for gate_results? The implementer writes gate values as
 * natural prose — "pass (current=0, baseline=0)", "14/14 pass (details)", etc.
 * Position-sensitive matching (`/^pass/i`, ADR-029) false-redded any value whose
 * count or annotation came first. `isGateGreen` reads the pass/fail signal from
 * anywhere in the string while staying fail-closed on ambiguous values.
 * check_passed / build_passed remain hard booleans — they are typed, not free-text.
 *
 * Green examples:  "pass", "pass (…)", "passed", "PASS", "14/14 pass", "✓ pass"
 * Red examples:    "fail", "fail (2 errors)", "1 failed 13 pass", "did not pass",
 *                  "skipped", "warn", "pending", "0 == baseline 0" (no pass token)
 */
export function handbackGatesGreen(parsed: ParsedHandback): boolean {
	if (!parsed.check_passed || !parsed.build_passed) return false;
	const vals = Object.values(parsed.gate_results ?? {});
	return vals.length === 0 || vals.every(isGateGreen);
}

/**
 * Extract the raw ```json…``` fenced block from agent output.
 *
 * Returns the FIRST full fenced block including fence markers (so parseHandback
 * can parse it directly from the stored handback DB column), or null when no
 * block is found.
 *
 * ADR-026 D3 — stored untruncated in `agent_runs.handback` at dispatch finish;
 * the worklist review card reads this column instead of the 800-char excerpt.
 *
 * NOTE: returns the FIRST match (not last) — in practice agent output has
 * exactly one hand-back fence, so first === last. `parseHandback` scans for
 * the LAST when parsing full agent output directly.
 */
export function extractHandBackBlock(output: string | null): string | null {
	if (!output) return null;
	const match = /```json\s*[\s\S]*?```/.exec(output);
	return match ? match[0] : null;
}

// ── Backward-compat aliases (ADR-026 callers) ─────────────────────────────────

/**
 * @deprecated Use parseHandback — identical logic, kept so ADR-026 callers
 * (worklist +server.ts, test suite) compile without changes.
 */
export const parseHandBack = parseHandback;

/**
 * @deprecated Use handbackGatesGreen — identical logic, kept so ADR-026
 * callers (worklist +server.ts, test suite) compile without changes.
 */
export const isGatesGreen = handbackGatesGreen;
