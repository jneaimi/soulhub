/**
 * Falsifier parser — extracts structured falsifier state from ADR bodies AND
 * project-index bodies. Per project-phases ADR-004.
 *
 * Five prose shapes observed in the soul-hub cluster (2026-05-17 audit):
 *
 *   Shape A — new canonical (5 ADRs, all 2026-05-17):
 *     ## Falsifiers
 *     - **F1** Endpoint shipped + tests
 *     - **F2** 5/5 clean shadow runs
 *
 *   Shape D — numbered inline markers (naseej ADR-005 et al):
 *     ## Falsifier
 *     1. **✅ closed CP2 (2026-05-17).** Evidence prose
 *     2. **⏳ open — CP4 target.** Evidence prose
 *
 *   Shape E — named bold-prose IDs (project indexes: soul-hub-brain, project-phases):
 *     ## Falsifiers
 *     - **Smart router**: if 30 days of logs show <70% accuracy ...
 *     - **Multimodal captions**: if "find that thing" queries fail ...
 *
 *   Shape C — legacy prose conditions (≈30 ADRs):
 *     ## Falsifier
 *     By **2026-08-16**, at least one of the following must be true:
 *     - Condition A in prose
 *     - Condition B in prose
 *
 *   Shape F — pure prose (no list at all):
 *     ## Falsifier (when to switch to Plan B)
 *     If both contacts decline ... fall back to ...
 *
 * Closure markers (`✅ F1 — closed YYYY-MM-DD (evidence)`) live OUTSIDE the
 * `## Falsifiers` section — typically inside `## Status` blocks like
 * `**Falsifier scorecard after S3**:`. Parser does a two-pass: definitions
 * from the falsifier section, closure markers from the whole body. Latest
 * closure marker wins per id.
 *
 * Distinct from `phase-parser.ts` — different domain, sibling design.
 */

import type { VaultMeta } from './types.js';

export type FalsifierStatus = 'open' | 'closed' | 'superseded' | 'rejected';

export type FalsifierShape = 'A' | 'C' | 'D' | 'E' | 'F';

export type FalsifierSourceKind = 'project-index' | 'adr-body';

export interface Falsifier {
	id: string; // "F1" for Shape A/C/D/F; slugified bold-name for Shape E
	ordinal: number; // 1-based position; for Shape A it's the F<N> number
	status: FalsifierStatus;
	description: string; // free text from definition line
	closed_at?: string; // YYYY-MM-DD if status === 'closed' (from closure marker)
	evidence?: string; // closure prose, typically in parens after status verb
	commit?: string; // short-SHA extracted from evidence if present
	deadline?: string; // YYYY-MM-DD from frontmatter falsifier_date (ADRs only)
	raw_definition: string; // verbatim definition line
	raw_closure?: string; // verbatim closure marker line if any
	shape: FalsifierShape;
	source_path: string; // ADR path or project-index path
	source_kind: FalsifierSourceKind;
}

export type ParserWarningKind =
	| 'no_falsifier_section'
	| 'unparseable_definition'
	| 'closure_without_definition'
	| 'mixed_shapes';

export interface ParserWarning {
	kind: ParserWarningKind;
	detail: string;
	raw?: string;
}

export interface FalsifierParserInput {
	sourcePath: string; // e.g. "projects/foo/adr-003-...md" or "projects/foo/index.md"
	body: string;
	meta: VaultMeta;
	sourceKind: FalsifierSourceKind;
}

export interface FalsifierParserOutput {
	falsifiers: Falsifier[];
	warnings: ParserWarning[];
}

// ── Section detection ─────────────────────────────────────────────────────

const SECTION_HEADING_H2_RE = /^(##)\s+Falsifier[s]?(?:\s|\W|$)/m;
const SECTION_HEADING_H3_RE = /^(###)\s+Falsifier[s]?(?:\s|\W|$)/m;

/** Find the body of the falsifier section: heading + optional inline label
 *  ("(kill criteria)", "(when to revert)", etc.) → up to next same-or-higher
 *  heading. Returns null if the body has no falsifier section.
 *
 *  Section extraction runs against a fenced-blocks-stripped copy so that
 *  pedagogical examples like ADR-004's own Shape A code block (which contains
 *  a literal `## Falsifiers` heading INSIDE ```` ```markdown ```` fences)
 *  don't shadow the real section. Without this, a self-referential ADR
 *  about falsifier parsing parses its own example block instead of its
 *  actual falsifier section.
 *
 *  H2 is preferred over H3 — naseej ADR-003 has both `## Falsifier` (the real
 *  one) and a nested `### Falsifier scorecard at ship` (sub-section with a
 *  status table). Without H2-preference the parser would grab the H3 table
 *  and miss the actual bullet list. Falls back to H3 only when no H2 exists,
 *  which covers the rare "ADR uses H3-only for Falsifier" case (a few legacy
 *  notes). */
function extractFalsifierSection(body: string): string | null {
	const fenceStripped = stripFencedBlocksOnly(body);

	let match = SECTION_HEADING_H2_RE.exec(fenceStripped);
	let headingLevel = 2;
	if (!match) {
		match = SECTION_HEADING_H3_RE.exec(fenceStripped);
		headingLevel = 3;
	}
	if (!match) return null;

	const start = match.index + match[0].length;

	// Find next same-or-higher heading (h1/h2 for h2 section; h1/h2/h3 for h3)
	const remainder = fenceStripped.slice(start);
	const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
	const next = nextHeadingRe.exec(remainder);
	const end = next ? next.index : remainder.length;

	return remainder.slice(0, end);
}

// ── Code stripping (mirrors phase-parser.ts) ──────────────────────────────

function stripCodeForMarkerScan(content: string): string {
	return content
		.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '')
		.replace(/(`+)[^\n]+?\1/g, '');
}

/** Closure-marker variant — strips fenced blocks (where pedagogical scorecard
 *  examples live) but PRESERVES inline backticks so `commit \`<sha>\`` survives
 *  for commit extraction. Mirrors phase-parser's split between marker scan
 *  (stripped) and detail extraction (original body). */
function stripFencedBlocksOnly(content: string): string {
	return content.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '');
}

// ── Shape detection ───────────────────────────────────────────────────────

const SHAPE_A_RE = /^- \*\*F\d+\*\*/m;
const SHAPE_D_RE = /^\d+\.\s+\*\*[✅⏳❌]/m;
// Shape E: bold-named id, must be CapitalizedWord, 3+ chars, followed by ":" or "."
const SHAPE_E_RE = /^- \*\*[A-Z][^*\n]{2,}\*\*[:.]\s/m;
const SHAPE_C_LIST_RE = /^- /m;

function detectShape(sectionBody: string): FalsifierShape {
	const stripped = stripCodeForMarkerScan(sectionBody);
	if (SHAPE_A_RE.test(stripped)) return 'A';
	if (SHAPE_D_RE.test(stripped)) return 'D';
	if (SHAPE_E_RE.test(stripped)) return 'E';
	if (SHAPE_C_LIST_RE.test(stripped)) return 'C';
	return 'F';
}

// ── Shape parsers ─────────────────────────────────────────────────────────

const SHAPE_A_LINE_RE = /^- \*\*F(\d+)\*\*\s+(.+?)(?=\n- \*\*F\d+\*\*|\n\n|\n#{1,3}\s|$)/gms;

function parseShapeA(sectionBody: string): Array<{ id: string; ordinal: number; description: string; raw: string }> {
	const out: Array<{ id: string; ordinal: number; description: string; raw: string }> = [];
	let m: RegExpExecArray | null;
	const stripped = stripCodeForMarkerScan(sectionBody);
	SHAPE_A_LINE_RE.lastIndex = 0;
	while ((m = SHAPE_A_LINE_RE.exec(stripped)) !== null) {
		const ordinal = Number.parseInt(m[1], 10);
		const description = m[2].trim().replace(/\s+/g, ' ');
		out.push({ id: `F${ordinal}`, ordinal, description, raw: m[0].trim() });
	}
	return out;
}

const SHAPE_D_LINE_RE = /^(\d+)\.\s+\*\*([✅⏳❌])\s+([^*]+?)\*\*\.?\s*(.*?)(?=\n\d+\.\s+\*\*[✅⏳❌]|\n\n|\n#{1,3}\s|$)/gms;
const STATUS_FROM_EMOJI: Record<string, FalsifierStatus> = {
	'✅': 'closed',
	'⏳': 'open',
	'❌': 'superseded',
};

function parseShapeD(sectionBody: string): Array<{
	id: string;
	ordinal: number;
	description: string;
	status: FalsifierStatus;
	closed_at?: string;
	evidence?: string;
	raw: string;
}> {
	const out: Array<{
		id: string;
		ordinal: number;
		description: string;
		status: FalsifierStatus;
		closed_at?: string;
		evidence?: string;
		raw: string;
	}> = [];
	let m: RegExpExecArray | null;
	const stripped = stripCodeForMarkerScan(sectionBody);
	SHAPE_D_LINE_RE.lastIndex = 0;
	while ((m = SHAPE_D_LINE_RE.exec(stripped)) !== null) {
		const ordinal = Number.parseInt(m[1], 10);
		const emoji = m[2];
		const statusFragment = m[3].trim();
		const description = m[4].trim().replace(/\s+/g, ' ');
		const status = STATUS_FROM_EMOJI[emoji] ?? 'open';
		const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(statusFragment);
		out.push({
			id: `F${ordinal}`,
			ordinal,
			description: description || statusFragment,
			status,
			closed_at: status === 'closed' && dateMatch ? dateMatch[1] : undefined,
			evidence: statusFragment,
			raw: m[0].trim(),
		});
	}
	return out;
}

const SHAPE_E_LINE_RE = /^- \*\*([A-Z][^*\n]{2,})\*\*[:.]\s*(.+?)(?=\n- \*\*[A-Z]|\n\n|\n#{1,3}\s|$)/gms;

function slugifyName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
}

function parseShapeE(sectionBody: string): Array<{ id: string; ordinal: number; description: string; raw: string; name: string }> {
	const out: Array<{ id: string; ordinal: number; description: string; raw: string; name: string }> = [];
	let m: RegExpExecArray | null;
	const stripped = stripCodeForMarkerScan(sectionBody);
	SHAPE_E_LINE_RE.lastIndex = 0;
	let ordinal = 0;
	while ((m = SHAPE_E_LINE_RE.exec(stripped)) !== null) {
		ordinal += 1;
		const name = m[1].trim();
		const description = m[2].trim().replace(/\s+/g, ' ');
		out.push({ id: slugifyName(name) || `F${ordinal}`, ordinal, description, raw: m[0].trim(), name });
	}
	return out;
}

const SHAPE_C_LINE_RE = /^- (.+?)(?=\n- |\n\n|\n#{1,3}\s|$)/gms;

function parseShapeC(sectionBody: string): Array<{ id: string; ordinal: number; description: string; raw: string }> {
	const out: Array<{ id: string; ordinal: number; description: string; raw: string }> = [];
	let m: RegExpExecArray | null;
	const stripped = stripCodeForMarkerScan(sectionBody);
	SHAPE_C_LINE_RE.lastIndex = 0;
	let ordinal = 0;
	while ((m = SHAPE_C_LINE_RE.exec(stripped)) !== null) {
		ordinal += 1;
		const description = m[1].trim().replace(/\s+/g, ' ');
		out.push({ id: `F${ordinal}`, ordinal, description, raw: m[0].trim() });
	}
	return out;
}

// ── Closure marker scan (whole body, not just section) ────────────────────

/** Matches ✅/⏳/❌ F<N> — <verb> [<date>] [(evidence)].
 *  Verb is one of `closed`, `pending`, `open`, `superseded`, `rejected`.
 *  Date and evidence are optional.
 *
 *  Line-anchored at start (optional `- ` bullet prefix + optional indent) so
 *  pedagogical examples written INSIDE inline-backtick spans mid-prose like
 *  `` `✅ F1 — closed YYYY-MM-DD` `` are NOT extracted. Without this anchor
 *  ADR-004's own description of the closure shape leaks into its parsed state. */
const CLOSURE_MARKER_RE =
	/^[ \t]*(?:- )?([✅⏳❌])\s+F(\d+)\s+—\s+(closed|pending|open|superseded|rejected)(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+\(([^)]+)\))?/gmu;

const STATUS_FROM_VERB: Record<string, FalsifierStatus> = {
	closed: 'closed',
	pending: 'open',
	open: 'open',
	superseded: 'superseded',
	rejected: 'rejected',
};

function extractClosureMarkers(body: string): Map<
	string,
	{ status: FalsifierStatus; closed_at?: string; evidence?: string; commit?: string; raw: string }
> {
	const out = new Map<
		string,
		{ status: FalsifierStatus; closed_at?: string; evidence?: string; commit?: string; raw: string }
	>();
	// Use fenced-only strip so `commit \`<sha>\`` inside an evidence parens
	// survives — otherwise inline-stripping eats the SHA and commit extraction
	// silently fails.
	const stripped = stripFencedBlocksOnly(body);
	let m: RegExpExecArray | null;
	CLOSURE_MARKER_RE.lastIndex = 0;
	while ((m = CLOSURE_MARKER_RE.exec(stripped)) !== null) {
		const emoji = m[1];
		const id = `F${m[2]}`;
		const verb = m[3].toLowerCase();
		const date = m[4];
		const evidence = m[5];
		const status = STATUS_FROM_VERB[verb] ?? STATUS_FROM_EMOJI[emoji] ?? 'open';
		const commit = evidence ? extractCommitFromEvidence(evidence) : undefined;
		// Latest occurrence wins — order of writing means later scorecard
		// blocks ("Falsifier scorecard after S3") sit lower than earlier ones
		// ("after S2"), so the LAST match per id is the canonical state.
		out.set(id, {
			status,
			closed_at: status === 'closed' ? date : undefined,
			evidence,
			commit,
			raw: m[0].trim(),
		});
	}
	return out;
}

function extractCommitFromEvidence(evidence: string): string | undefined {
	const m = /commit\s+`?([a-f0-9]{7,40})`?/i.exec(evidence);
	return m ? m[1] : undefined;
}

// ── Status defaults from frontmatter (for shape C/F ADRs with no closure) ─

function defaultStatusForAdr(meta: VaultMeta): FalsifierStatus {
	const status = String(meta.status ?? '').toLowerCase();
	switch (status) {
		case 'shipped':
			return 'closed';
		case 'superseded':
			return 'superseded';
		case 'rejected':
			return 'rejected';
		default:
			return 'open';
	}
}

function isoDate(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

// ── Main entry ────────────────────────────────────────────────────────────

export function parseFalsifiers(input: FalsifierParserInput): FalsifierParserOutput {
	const warnings: ParserWarning[] = [];
	const sectionBody = extractFalsifierSection(input.body);

	if (sectionBody === null) {
		warnings.push({
			kind: 'no_falsifier_section',
			detail: `No "## Falsifier[s]" section in ${input.sourcePath}`,
		});
		return { falsifiers: [], warnings };
	}

	const shape = detectShape(sectionBody);
	const closures = extractClosureMarkers(input.body);
	const deadline =
		input.sourceKind === 'adr-body'
			? isoDate(input.meta.falsifier_date) ?? isoDate((input.meta as Record<string, unknown>).falsifierDate)
			: undefined;
	const defaultStatus =
		input.sourceKind === 'adr-body' ? defaultStatusForAdr(input.meta) : 'open';

	const out: Falsifier[] = [];

	if (shape === 'A') {
		for (const entry of parseShapeA(sectionBody)) {
			const closure = closures.get(entry.id);
			out.push({
				id: entry.id,
				ordinal: entry.ordinal,
				status: closure?.status ?? 'open',
				description: entry.description,
				closed_at: closure?.closed_at,
				evidence: closure?.evidence,
				commit: closure?.commit,
				deadline,
				raw_definition: entry.raw,
				raw_closure: closure?.raw,
				shape: 'A',
				source_path: input.sourcePath,
				source_kind: input.sourceKind,
			});
		}
	} else if (shape === 'D') {
		for (const entry of parseShapeD(sectionBody)) {
			// Shape D's inline marker IS the closure marker — already captured
			// in the entry. Cross-reference with closures map in case there's
			// also a separate scorecard block, which wins.
			const closure = closures.get(entry.id);
			out.push({
				id: entry.id,
				ordinal: entry.ordinal,
				status: closure?.status ?? entry.status,
				description: entry.description,
				closed_at: closure?.closed_at ?? entry.closed_at,
				evidence: closure?.evidence ?? entry.evidence,
				commit: closure?.commit,
				deadline,
				raw_definition: entry.raw,
				raw_closure: closure?.raw,
				shape: 'D',
				source_path: input.sourcePath,
				source_kind: input.sourceKind,
			});
		}
	} else if (shape === 'E') {
		for (const entry of parseShapeE(sectionBody)) {
			// Shape E typically has no closure markers (no F<N> convention
			// for closures on bold-named falsifiers). Status defaults open.
			out.push({
				id: entry.id,
				ordinal: entry.ordinal,
				status: 'open',
				description: entry.description,
				deadline,
				raw_definition: entry.raw,
				shape: 'E',
				source_path: input.sourcePath,
				source_kind: input.sourceKind,
			});
		}
	} else if (shape === 'C') {
		for (const entry of parseShapeC(sectionBody)) {
			const closure = closures.get(entry.id);
			out.push({
				id: entry.id,
				ordinal: entry.ordinal,
				status: closure?.status ?? defaultStatus,
				description: entry.description,
				closed_at: closure?.closed_at,
				evidence: closure?.evidence,
				commit: closure?.commit,
				deadline,
				raw_definition: entry.raw,
				raw_closure: closure?.raw,
				shape: 'C',
				source_path: input.sourcePath,
				source_kind: input.sourceKind,
			});
		}
	} else {
		// Shape F — pure prose; one anonymous falsifier with the section as description.
		const description = sectionBody.trim().replace(/\s+/g, ' ').slice(0, 400);
		out.push({
			id: 'F1',
			ordinal: 1,
			status: defaultStatus,
			description,
			deadline,
			raw_definition: description,
			shape: 'F',
			source_path: input.sourcePath,
			source_kind: input.sourceKind,
		});
	}

	// Warning: closure markers that reference an id not in the parsed definitions
	for (const [id] of closures) {
		if (!out.find((f) => f.id === id)) {
			warnings.push({
				kind: 'closure_without_definition',
				detail: `Closure marker for ${id} found but no matching definition in ${input.sourcePath}`,
			});
		}
	}

	return { falsifiers: out, warnings };
}
