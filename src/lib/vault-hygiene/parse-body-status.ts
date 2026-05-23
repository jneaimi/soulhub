/** Parse the canonical status of an ADR from its body text.
 *
 *  Pure function; no I/O. Used by the body-vs-frontmatter consistency
 *  check (see `adr-status-drift.ts`) and shared with project-phases
 *  parsing if the refactor in `2026-05-18-adr-status-body-frontmatter-consistency`
 *  Phase 1.6 lands.
 *
 *  Algorithm — deliberately conservative to avoid the false-positive
 *  noise the v0 audit scanner hit (it caught "Rejected" inside
 *  Alternatives sections):
 *
 *    1. Find the `## Status` H2 section (case-insensitive). Section runs
 *       until the next H2 or end of body.
 *    2. If no Status section exists, fall back to the text BEFORE the
 *       first H2 — older ADRs lead with a bolded status span before any
 *       sectioning.
 *    3. Within that scope, scan every `**...**` bold span. For each,
 *       check if it contains a canonical status word.
 *    4. Return the HIGHEST-rank status found (shipped > accepted >
 *       proposed; superseded/parked/rejected are siblings with negative
 *       rank). This handles patterns like `**Accepted — 2026-05-03.
 *       Shipped.**` → claim is `shipped`.
 *    5. Return null if no recognised status is found — the parser is
 *       conservative; "unstructured" is not the same as "drift". */

export const CANONICAL_STATUSES = [
	'proposed',
	'accepted',
	'shipped',
	'rejected',
	'parked',
	'superseded',
] as const;

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

/** Rank used to pick the "most advanced" status when a bold span carries
 *  multiple. Positive rank is the active-life ladder (proposed →
 *  accepted → shipped). Negative-rank statuses are off-ladder terminal
 *  states; if seen alongside an active-ladder word, the active one
 *  wins. */
const RANK: Record<CanonicalStatus, number> = {
	proposed: 0,
	accepted: 1,
	shipped: 2,
	parked: -1,
	rejected: -2,
	superseded: -3,
};

export interface ParsedBodyStatus {
	status: CanonicalStatus;
	/** The bold span (with `**` delimiters) that triggered the match.
	 *  Used by the keeper digest as the evidence snippet. */
	evidence: string;
}

/** Returns the parsed status, or `null` if the body has no recognisable
 *  Status section / leading bold span. */
export function parseBodyStatus(body: string): ParsedBodyStatus | null {
	const scope = extractStatusScope(body);
	if (!scope) return null;

	let best: ParsedBodyStatus | null = null;

	// Match every `**...**` span. Non-greedy on content so multi-line
	// spans don't bleed across the section.
	const SPAN_RE = /\*\*([^*]+?)\*\*/g;
	for (const m of scope.matchAll(SPAN_RE)) {
		const inner = m[1];
		for (const status of CANONICAL_STATUSES) {
			if (!hasValidStatusOccurrence(inner, status)) continue;
			if (!best || RANK[status] > RANK[best.status]) {
				best = { status, evidence: m[0] };
			}
		}
	}

	return best;
}

/** Historical-context qualifiers — words that mean "this is talking about
 *  a past state, not the current one". When the status word is immediately
 *  preceded by one of these, skip it.
 *
 *  Catches cases like `**Originally accepted**` (ADR-006 supersededs
 *  describing its prior life) where the bold span discusses history, not
 *  the live status. */
const HISTORY_QUALIFIERS = new Set([
	'originally',
	'original',
	'previously',
	'previous',
	'formerly',
	'former',
	'earlier',
	'early',
	'initial',
	'initially',
	'first',
	'was',
	'were',
	'once',
]);

/** Returns true iff the inner text contains the status word in a position
 *  that plausibly describes the ADR's CURRENT status (not a historical
 *  reference, a parenthetical cross-reference to a sibling project, or
 *  an alternative being rejected within the body). */
function hasValidStatusOccurrence(inner: string, status: CanonicalStatus): boolean {
	const wordRe = new RegExp(`\\b${status}\\b`, 'gi');
	let m: RegExpExecArray | null;
	while ((m = wordRe.exec(inner)) !== null) {
		const before = inner.slice(0, m.index);

		// Skip if preceded by a historical qualifier ("originally
		// accepted", "previously shipped", etc.) — the span discusses
		// past state, not current.
		const lastWord = before.match(/([A-Za-z]+)\s*$/)?.[1]?.toLowerCase();
		if (lastWord && HISTORY_QUALIFIERS.has(lastWord)) continue;

		// Skip if inside an unclosed parenthetical — the status word
		// is part of a cross-reference (e.g., `**G2 — overlap with
		// vault-scout (already shipped)**` is talking about vault-scout,
		// not this ADR).
		if (insideUnclosedParen(before)) continue;

		return true;
	}
	return false;
}

/** Returns true iff there are more `(` than `)` characters in the
 *  prefix — i.e., the position immediately after `prefix` is inside a
 *  parenthetical group. */
function insideUnclosedParen(prefix: string): boolean {
	let depth = 0;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i];
		if (ch === '(') depth++;
		else if (ch === ')' && depth > 0) depth--;
	}
	return depth > 0;
}

/** Returns the substring that the parser should scope to — i.e. the
 *  `## Status` section if present, otherwise everything before the first
 *  H2 (handles older ADRs that lead with a bolded status before any
 *  sectioning).
 *
 *  Returns `null` if neither shape exists. */
function extractStatusScope(body: string): string | null {
	const lines = body.split('\n');

	// Pass 1 — look for `## Status` (or `## status`, or `## STATUS`).
	let inStatus = false;
	const section: string[] = [];
	for (const line of lines) {
		if (/^##\s+status\s*$/i.test(line)) {
			inStatus = true;
			continue;
		}
		if (inStatus && /^##\s+/.test(line)) {
			// Next H2 boundary — stop accumulating.
			break;
		}
		if (inStatus) section.push(line);
	}
	if (section.length > 0) return section.join('\n');

	// Pass 2 — fallback: everything before the first H2. ADRs older
	// than the convention sometimes lead with a `> **Status: shipped**`
	// quote-style line before any `## X` heading.
	const splitIdx = body.search(/^##\s+/m);
	const preface = splitIdx === -1 ? body : body.slice(0, splitIdx);
	if (/\*\*[^*]+\*\*/.test(preface)) return preface;

	return null;
}

/** Compare two statuses and return their drift direction. Used by the
 *  check to label whether the body or the frontmatter is "ahead". */
export function compareStatuses(
	fm: CanonicalStatus,
	body: CanonicalStatus,
): 'match' | 'body-ahead' | 'fm-ahead' | 'sideways' {
	if (fm === body) return 'match';
	const fr = RANK[fm];
	const br = RANK[body];
	if (br > fr) return 'body-ahead';
	if (br < fr) return 'fm-ahead';
	return 'sideways';
}

/** Type guard — narrows `string` to `CanonicalStatus`. */
export function isCanonicalStatus(s: string): s is CanonicalStatus {
	return (CANONICAL_STATUSES as readonly string[]).includes(s);
}
