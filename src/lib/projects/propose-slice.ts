/**
 * project-phases ADR-005 S2 — proposeSlice orchestrator tool core.
 *
 * Adds a NEW row to an existing ADR's `## Implementation plan` table.
 * Pure-mutation primitive `appendSliceRow` is the structural analogue of
 * `appendSliceMarkerToStatus` in ship-slice.ts — same body-text-rewrite
 * shape, different surface.
 *
 * Critically distinct from ship-slice's purpose:
 *   - ship-slice CLOSES a slice (writes SHIPPED marker + ship-log row)
 *   - propose-slice PROPOSES a slice (adds a planning row, no status change)
 *
 * Pure helpers (parseImplementationTable / nextSliceOrdinalFromTable /
 * formatSliceRow / appendSliceRow) are exported so tests can exercise
 * them without spinning the engine. The orchestrator entry point
 * (`applyProposeSlice`) is the only one that talks to the engine.
 */

import { z } from 'zod';
import type { VaultMeta } from '../vault/types.js';

// Inlined from ship-slice.ts to keep this module's import graph free of
// SvelteKit `.js` aliases — the pure helpers below need to be importable
// from node:test without dragging in vault-engine deps. The two functions
// are tiny (~15 LOC combined) and have stable contracts (ADR-003).

function resolveAdrPath(slug: string, adr: string): string | null {
	const trimmed = adr.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('projects/') && trimmed.endsWith('.md')) return trimmed;
	if (trimmed.startsWith('adr-')) return `projects/${slug}/${trimmed}.md`;
	return null;
}

function findAdrPathByOrdinal(indexBody: string, slug: string, ordinal: string): string | null {
	const padded = ordinal.padStart(3, '0');
	const wikiRe = new RegExp(`\\[\\[(adr-${padded}-[a-z0-9-]+)(?:\\|[^\\]]*)?\\]\\]`);
	const m = wikiRe.exec(indexBody);
	if (!m) return null;
	return `projects/${slug}/${m[1]}.md`;
}

// ─── Input schema ─────────────────────────────────────────────────────

const SLICE_FAMILY_VALUES = ['S', 'CP', 'Phase', 'PASS', 'Pass', 'Stage'] as const;

export const ProposeSliceInputSchema = z
	.object({
		/** Target project slug. */
		slug: z
			.string()
			.trim()
			.min(1)
			.regex(/^[a-z0-9][a-z0-9-]+$/),
		/** ADR identifier — bare ordinal ("007"), bare slug
		 *  ("adr-007-foo"), or full path ("projects/X/adr-007-foo.md"). */
		adr: z.string().trim().min(1),
		/** Optional explicit slice id (`S5`, `CP4.2`, `Phase 3`). If omitted,
		 *  the tool computes next-available within `family`. */
		slice_id: z
			.string()
			.trim()
			.regex(/^(S|CP|Phase|PASS|Pass|Stage)\s*\d+(?:\.\d+)?$/, {
				message: 'slice_id must match `S<N>` / `CP<N>` / `Phase <N>` / `PASS <N>` / `Stage <N>`',
			})
			.optional(),
		/** Family to use when slice_id is omitted. Defaults to the most
		 *  common family in the existing table, or `S` if the table is empty. */
		family: z.enum(SLICE_FAMILY_VALUES).optional(),
		/** Scope cell — 1-3 sentences. Markdown is allowed but inline only
		 *  (no line breaks — markdown tables don't honour them). */
		scope: z
			.string()
			.trim()
			.min(5)
			.max(800)
			.refine((s) => !/\n/.test(s), { message: 'scope must be single-line (no newlines)' }),
		/** Estimate cell, e.g. "2-3 hours" or "30-45 min". Single-line. */
		estimate: z
			.string()
			.trim()
			.min(1)
			.max(60)
			.refine((s) => !/\n/.test(s), { message: 'estimate must be single-line' }),
		/** Source-agent override for audit attribution. Defaults to 'proposeSlice'. */
		source_agent: z.string().trim().min(1).max(60).optional(),
	})
	.strict();

export type ProposeSliceInput = z.infer<typeof ProposeSliceInputSchema>;

// ─── Pure helpers: table parsing ──────────────────────────────────────

const SLICE_LABEL_RE = /^(S|CP|Phase|PASS|Pass|Stage)\s*(\d+(?:\.\d+)?)$/;

export interface ParsedSliceLabel {
	family: (typeof SLICE_FAMILY_VALUES)[number];
	ordinal: number;
	canonical: string;
}

export function parseSliceLabel(label: string): ParsedSliceLabel | null {
	const m = SLICE_LABEL_RE.exec(label.trim());
	if (!m) return null;
	return {
		family: m[1] as (typeof SLICE_FAMILY_VALUES)[number],
		ordinal: Number.parseFloat(m[2]),
		canonical: label.trim(),
	};
}

export interface TableRow {
	label: string; // raw first-cell text (e.g. "**S1**" or "S2")
	parsed: ParsedSliceLabel | null;
	scope: string;
	estimate: string;
	/** Line index within `body.split('\n')` for the data row. */
	lineIndex: number;
	/** Raw line text. */
	rawLine: string;
}

export interface ParsedImplementationTable {
	/** Line index of the `## Implementation plan` heading. */
	sectionStart: number;
	/** Line index of the table's header row. */
	headerLine: number;
	/** Line index of the separator (`|---|---|---|`). */
	separatorLine: number;
	/** Line index of the LAST data row (inclusive). May equal separatorLine
	 *  when the table is empty. */
	lastDataLine: number;
	/** Parsed data rows. */
	rows: TableRow[];
	/** Number of `|`-delimited columns inferred from the header. */
	columnCount: number;
}

/** Strip leading/trailing `|` and split on `|`. Returns trimmed cells.
 *  Tolerates the canonical `| Slice | Scope | Estimate |` shape AND
 *  variants with no leading/trailing pipe. */
function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|')) s = s.slice(0, -1);
	return s.split('|').map((c) => c.trim());
}

/** Detect the markdown-table separator row (`|---|---|---|`). Returns
 *  the column count when matched, else null. */
function parseSeparator(line: string): number | null {
	const trimmed = line.trim();
	if (!/^\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?$/.test(trimmed)) return null;
	const cells = splitTableRow(trimmed);
	return cells.length >= 2 ? cells.length : null;
}

/** Strip surrounding markdown emphasis (`**...**`, `*...*`, ` `...` `)
 *  from a table cell to extract the bare slice label. */
function stripCellEmphasis(cell: string): string {
	let s = cell.trim();
	// Strip backticks.
	const backtick = /^`+(.+?)`+$/.exec(s);
	if (backtick) s = backtick[1].trim();
	// Strip bold (`**x**`) then italic (`*x*` or `_x_`).
	const bold = /^\*\*(.+?)\*\*$/.exec(s);
	if (bold) s = bold[1].trim();
	const italic = /^[*_](.+?)[*_]$/.exec(s);
	if (italic) s = italic[1].trim();
	return s;
}

/** Parse the ADR body's `## Implementation plan` section into a
 *  structured table. Returns null when the section or table is missing. */
export function parseImplementationTable(body: string): ParsedImplementationTable | null {
	const lines = body.split('\n');
	const sectionRe = /^## Implementation plan\s*$/;

	let sectionStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (sectionRe.test(lines[i])) {
			sectionStart = i;
			break;
		}
	}
	if (sectionStart < 0) return null;

	// Find the next `## ` heading (or EOF) that bounds the section.
	let sectionEnd = lines.length;
	for (let i = sectionStart + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i])) {
			sectionEnd = i;
			break;
		}
	}

	// Find the separator row inside the section.
	let separatorLine = -1;
	let columnCount = 0;
	for (let i = sectionStart + 1; i < sectionEnd; i++) {
		const cols = parseSeparator(lines[i]);
		if (cols !== null) {
			separatorLine = i;
			columnCount = cols;
			break;
		}
	}
	if (separatorLine < 0) return null;

	// The header is the immediately-preceding non-blank line.
	let headerLine = -1;
	for (let i = separatorLine - 1; i > sectionStart; i--) {
		if (lines[i].trim() !== '') {
			headerLine = i;
			break;
		}
	}
	if (headerLine < 0) return null;

	// Data rows: contiguous from separatorLine+1 until first non-row line.
	const rows: TableRow[] = [];
	let lastDataLine = separatorLine;
	for (let i = separatorLine + 1; i < sectionEnd; i++) {
		const line = lines[i];
		// Blank line or new heading ends the table.
		if (line.trim() === '') break;
		// Defensive: rows must start with `|` or contain at least one `|`.
		if (!line.includes('|')) break;
		const cells = splitTableRow(line);
		if (cells.length < 2) break;
		const labelRaw = cells[0];
		const parsed = parseSliceLabel(stripCellEmphasis(labelRaw));
		rows.push({
			label: labelRaw,
			parsed,
			scope: cells[1] ?? '',
			estimate: cells[2] ?? '',
			lineIndex: i,
			rawLine: line,
		});
		lastDataLine = i;
	}

	return {
		sectionStart,
		headerLine,
		separatorLine,
		lastDataLine,
		rows,
		columnCount,
	};
}

/** Pick the next-available ordinal for the given family from the parsed
 *  table. Skips rows whose label couldn't be parsed (operator-curated
 *  free-form labels). When the family is absent, returns `<family>1`. */
export function nextSliceOrdinalFromTable(
	table: ParsedImplementationTable,
	family: (typeof SLICE_FAMILY_VALUES)[number],
): string {
	let max = 0;
	for (const row of table.rows) {
		if (!row.parsed) continue;
		if (row.parsed.family !== family) continue;
		// Use Math.floor for sub-ordinals like 1.5 — we always propose
		// integer next-rows, never sub-points.
		if (row.parsed.ordinal > max) max = Math.floor(row.parsed.ordinal);
	}
	const next = max + 1;
	// Phase / PASS / Pass / Stage carry a space; S / CP do not.
	const spaced = family !== 'S' && family !== 'CP';
	return spaced ? `${family} ${next}` : `${family}${next}`;
}

/** Inspect the existing rows and choose the dominant family. Ties pick
 *  in declaration order. Returns 'S' when no recognisable rows exist. */
export function detectDominantFamily(
	table: ParsedImplementationTable,
): (typeof SLICE_FAMILY_VALUES)[number] {
	const counts = new Map<string, number>();
	for (const row of table.rows) {
		if (!row.parsed) continue;
		counts.set(row.parsed.family, (counts.get(row.parsed.family) ?? 0) + 1);
	}
	let bestFamily: (typeof SLICE_FAMILY_VALUES)[number] = 'S';
	let bestCount = 0;
	for (const family of SLICE_FAMILY_VALUES) {
		const c = counts.get(family) ?? 0;
		if (c > bestCount) {
			bestCount = c;
			bestFamily = family;
		}
	}
	return bestFamily;
}

/** Format a markdown table row for a 3-column `| Slice | Scope | Estimate |`
 *  table. When the column count is higher (e.g. a 4-column variant), pads
 *  trailing cells with em-dash placeholders. */
export function formatSliceRow(
	slice_id: string,
	scope: string,
	estimate: string,
	columnCount = 3,
): string {
	const cells = [slice_id, scope, estimate];
	while (cells.length < columnCount) cells.push('—');
	return `| ${cells.join(' | ')} |`;
}

export interface AppendSliceRowResult {
	body: string;
	changed: boolean;
	error?: string;
	status_hint?: number;
	field?: string;
	/** When changed=true, the resolved slice_id (post-auto-derivation). */
	resolved_slice_id?: string;
	/** When changed=true, the rendered row line. */
	new_row_line?: string;
}

/** Append a new row to the `## Implementation plan` table. Refuses if:
 *   - the section is missing
 *   - no table parses inside the section
 *   - the requested slice_id is already present (idempotent no-op with `changed=false`).
 *
 *  Pure: takes body + parameters, returns the new body. No I/O. */
export function appendSliceRow(
	body: string,
	params: {
		slice_id?: string;
		family?: (typeof SLICE_FAMILY_VALUES)[number];
		scope: string;
		estimate: string;
	},
): AppendSliceRowResult {
	const table = parseImplementationTable(body);
	if (!table) {
		return {
			body,
			changed: false,
			error:
				'no `## Implementation plan` table found — add a `| Slice | Scope | Estimate |` table to the ADR before proposing slices',
			status_hint: 422,
		};
	}

	// Resolve slice_id: explicit > family-driven > dominant-family.
	let sliceId = params.slice_id?.trim();
	if (!sliceId) {
		const family = params.family ?? detectDominantFamily(table);
		sliceId = nextSliceOrdinalFromTable(table, family);
	}

	// Idempotency: if a row already exists with this label, no-op.
	const existing = table.rows.find((r) => {
		const bare = stripCellEmphasis(r.label);
		return bare === sliceId || r.label.trim() === sliceId;
	});
	if (existing) {
		return {
			body,
			changed: false,
			resolved_slice_id: sliceId,
		};
	}

	const newRow = formatSliceRow(sliceId, params.scope, params.estimate, table.columnCount);
	const lines = body.split('\n');
	// Insert immediately after the last data row (or the separator, when
	// the table is empty).
	lines.splice(table.lastDataLine + 1, 0, newRow);

	return {
		body: lines.join('\n'),
		changed: true,
		resolved_slice_id: sliceId,
		new_row_line: newRow,
	};
}

// ─── Orchestration ────────────────────────────────────────────────────

export interface ProposeSliceResult {
	success: true;
	path: string;
	slice_id: string;
	new_row: string;
	already_present?: true;
}

export interface ProposeSliceError {
	success: false;
	error: string;
	status_hint?: number;
	field?: string;
}

/** Minimal engine surface — mirrors ShipSliceVaultEngine so the tool
 *  can take either the real engine or a test mock. */
export interface ProposeSliceVaultEngine {
	getNote(
		path: string,
	):
		| Promise<{ content: string; meta?: VaultMeta } | null>
		| { content: string; meta?: VaultMeta }
		| null
		// VaultEngine.getNote is sync and returns `undefined` (not null) when absent.
		| undefined;
	updateNote(
		path: string,
		patch: { content?: string },
		opts?: { actor?: string; actorContext?: string },
	): Promise<{ success?: boolean; error?: string; field?: string }>;
}

export async function applyProposeSlice(
	engine: ProposeSliceVaultEngine,
	rawInput: unknown,
): Promise<ProposeSliceResult | ProposeSliceError> {
	const parsed = ProposeSliceInputSchema.safeParse(rawInput);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			success: false,
			error: `Invalid input: ${first?.path.join('.')}: ${first?.message}`,
			status_hint: 400,
		};
	}
	const input = parsed.data;

	// Verify the project exists.
	const indexPath = `projects/${input.slug}/index.md`;
	const indexNote = await engine.getNote(indexPath);
	if (!indexNote) {
		return {
			success: false,
			error: `Project not found: projects/${input.slug}/ has no index.md`,
			status_hint: 404,
			field: 'slug',
		};
	}

	// Resolve ADR path — same two-pass strategy as applyShipSlice.
	let adrPath = resolveAdrPath(input.slug, input.adr);
	let adrNote = adrPath ? await engine.getNote(adrPath) : null;
	if (!adrNote) {
		const ordinalHint = input.adr.replace(/^adr-/, '').split('-')[0];
		const fallbackPath = findAdrPathByOrdinal(indexNote.content, input.slug, ordinalHint);
		if (fallbackPath) {
			adrPath = fallbackPath;
			adrNote = await engine.getNote(adrPath);
		}
	}
	if (!adrPath || !adrNote) {
		return {
			success: false,
			error: `Could not resolve adr "${input.adr}" in project "${input.slug}" — try a full slug like "adr-005-ai-propose-adr-and-propose-slice"`,
			field: 'adr',
			status_hint: 400,
		};
	}

	const mutation = appendSliceRow(adrNote.content, {
		slice_id: input.slice_id,
		family: input.family,
		scope: input.scope,
		estimate: input.estimate,
	});

	if (mutation.error) {
		return {
			success: false,
			error: mutation.error,
			status_hint: mutation.status_hint ?? 422,
			field: mutation.field,
		};
	}

	const resolvedSliceId = mutation.resolved_slice_id!;

	if (!mutation.changed) {
		// Idempotent — row already present.
		return {
			success: true,
			path: adrPath,
			slice_id: resolvedSliceId,
			new_row: formatSliceRow(resolvedSliceId, input.scope, input.estimate),
			already_present: true,
		};
	}

	const actor = input.source_agent ?? 'proposeSlice';
	const actorContext = `slug=${input.slug} adr=${input.adr} slice=${resolvedSliceId}`;

	const writeRes = await engine.updateNote(
		adrPath,
		{ content: mutation.body },
		{ actor, actorContext },
	);
	if (!writeRes.success) {
		return {
			success: false,
			error: writeRes.error ?? 'updateNote failed',
			status_hint: 500,
			field: writeRes.field,
		};
	}

	return {
		success: true,
		path: adrPath,
		slice_id: resolvedSliceId,
		new_row: mutation.new_row_line!,
	};
}
