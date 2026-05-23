/**
 * Atomic ship-slice mutation primitives. Per project-phases ADR-003.
 *
 * Pure functions over markdown text — no I/O. The endpoint composes these
 * + reads/writes via the vault engine (which itself routes through the
 * ADR-046 chokepoint).
 *
 * Mutation surfaces wired (cumulative across ADR-003 + ADR-004):
 *
 *   1. ADR Status section — slice marker line (ADR-003 S2)
 *   2. Project index ship log — prepended entry (ADR-003 S2)
 *   3. ADR Falsifier scorecard — `✅ F<N> — closed` line when
 *      `closes_falsifier` is set (ADR-004 S3)
 *
 * All three writes flow through `engine.updateNote(..., {actor, actorContext})`
 * so the audit log shows `projectShipSlice` instead of the ADR's original
 * author. Atomicity: if mutation 1+3 (combined into ONE ADR write) succeed
 * but mutation 2 (index write) fails, the ADR is rolled back to its original
 * body — ship log entry must not exist without the corresponding ADR markers.
 *
 * Deferred:
 *   - Checkpoints table row mutation (regex-anchored on label cell)
 */

import { z } from 'zod';
import { parseFalsifiers, type Falsifier } from '../vault/falsifier-parser.js';
import type { VaultMeta } from '../vault/types.js';
import { todayInTimezone } from './propose-adr.js';

// ─── Zod schema for the request body ─────────────────────────────────────────

const STATUS_VALUES = ['shipped', 'accepted', 'parked', 'superseded', 'rejected'] as const;
const STATUS_VERB: Record<typeof STATUS_VALUES[number], string> = {
	shipped: 'SHIPPED',
	accepted: 'ACCEPTED',
	parked: 'PARKED',
	superseded: 'SUPERSEDED',
	rejected: 'REJECTED',
};

export const ShipSliceRequestSchema = z
	.object({
		/** ADR identifier — either the bare ordinal ("007"), the bare slug
		 *  ("adr-007-peer-brief-naseej-port"), or the full vault path
		 *  ("projects/naseej/adr-007-peer-brief-naseej-port.md"). The endpoint
		 *  resolves all three forms against `projects/<slug>/`. */
		adr: z.string().trim().min(1),
		/** Slice label as it appears in the ADR — `S3`, `CP4.2`, `Phase 1`,
		 *  `Stage 1`. Case-sensitive. Must match exactly how the operator
		 *  writes it in the Status section running tally. */
		slice_id: z
			.string()
			.trim()
			.regex(/^(S|CP|Phase|PASS|Pass|Stage)\s*\d+(?:\.\d+)?$/, {
				message: 'slice_id must match `S<N>` / `CP<N>` / `Phase <N>` / `PASS <N>` / `Stage <N>`',
			}),
		status: z.enum(STATUS_VALUES),
		commit: z
			.string()
			.trim()
			.regex(/^[a-f0-9]{7,40}$/, { message: 'commit must be a git short-SHA (7-40 hex chars)' })
			.optional(),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
			.optional(),
		bundle: z.string().trim().min(1).optional(),
		notes: z.string().trim().min(1).optional(),
		closes_falsifier: z
			.string()
			.trim()
			.regex(/^F\d+$/, { message: 'closes_falsifier must match `F<N>`' })
			.optional(),
		/** ADR-011 — IANA timezone for the auto-derived ship date. Defaults to
		 *  `Asia/Dubai` (operator wall-clock) so post-20:00-UTC ships don't render
		 *  the prior UTC-day. `req.date` still wins when supplied. Mirrors the
		 *  ADR-010 ProposeAdrInputSchema pattern. */
		timezone: z.string().trim().min(1).max(60).optional(),
	})
	.strict();

export type ShipSliceRequest = z.infer<typeof ShipSliceRequestSchema>;

// ─── ADR path resolution ─────────────────────────────────────────────────────

/** Resolve any of the accepted `adr` shorthand forms to a full vault path.
 *  Returns null when the shorthand can't be normalized. Caller verifies the
 *  file actually exists. */
export function resolveAdrPath(slug: string, adr: string): string | null {
	const trimmed = adr.trim();
	if (!trimmed) return null;
	// Full path passes through unchanged.
	if (trimmed.startsWith('projects/') && trimmed.endsWith('.md')) return trimmed;
	// Bare slug `adr-007-peer-brief-naseej-port`.
	if (trimmed.startsWith('adr-')) return `projects/${slug}/${trimmed}.md`;
	// Bare ordinal `007` or `7` — caller must already know the rest.
	// The endpoint resolves this against the project index's ADRs list,
	// not in this pure helper.
	return null;
}

/** Given the project index body, find the full vault path for an ADR
 *  identified by a bare ordinal like `7` or `007`. Looks for the wikilink
 *  pattern `[[adr-007-...|...]]` in the ADRs section. */
export function findAdrPathByOrdinal(indexBody: string, slug: string, ordinal: string): string | null {
	const padded = ordinal.padStart(3, '0');
	const wikiRe = new RegExp(`\\[\\[(adr-${padded}-[a-z0-9-]+)(?:\\|[^\\]]*)?\\]\\]`);
	const m = wikiRe.exec(indexBody);
	if (!m) return null;
	return `projects/${slug}/${m[1]}.md`;
}

// ─── Mutation 1: ADR Status section running tally ─────────────────────────────

const SLICE_LABEL_RE = /^(S|CP|Phase|PASS|Pass|Stage)\s*(\d+(?:\.\d+)?)$/;

interface ParsedSliceLabel {
	family: string;
	ordinal: number;
	canonical: string; // exact form as it appears
}

function parseSliceLabel(label: string): ParsedSliceLabel | null {
	const m = SLICE_LABEL_RE.exec(label.trim());
	if (!m) return null;
	return {
		family: m[1],
		ordinal: Number.parseFloat(m[2]),
		canonical: label.trim(),
	};
}

/** Find the existing running-tally line in the ADR Status section and either
 *  add the new slice to its ordinal list (if status matches), or append a NEW
 *  per-slice marker line below it. v1 always appends a new marker line — this
 *  keeps the audit trail visible. The aggregated tally lines like
 *  `**S1+S2+S3 SHIPPED YYYY-MM-DD**` are author-curated.
 *
 *  The new marker line is inserted right after the existing top-of-Status
 *  paragraph. Format:
 *
 *      **<LABEL> <STATUS_VERB> YYYY-MM-DD** commit `<sha>` — <notes if any>
 *
 *  Idempotent: if the exact line is already present, no change. */
export function appendSliceMarkerToStatus(
	body: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): { body: string; changed: boolean } {
	const verb = STATUS_VERB[req.status];
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';
	const newLine = `**${req.slice_id} ${verb} ${resolvedDate}**${commitFragment}${notesFragment}`;

	// Idempotency: bail if the exact line is already in the Status section.
	const statusBlock = extractSection(body, '## Status');
	if (statusBlock && statusBlock.includes(newLine)) {
		return { body, changed: false };
	}

	// Insert right after the first paragraph in `## Status`.
	const statusHeaderRe = /^## Status\s*\n+/m;
	const m = statusHeaderRe.exec(body);
	if (!m) {
		// No `## Status` header — append one at the top.
		return {
			body: `## Status\n\n${newLine}\n\n${body}`,
			changed: true,
		};
	}
	const insertAt = m.index + m[0].length;
	// Skip to end of the next paragraph (first blank line after insertAt).
	const rest = body.slice(insertAt);
	const blankLineIdx = rest.search(/\n\s*\n/);
	const inserted = blankLineIdx >= 0 ? blankLineIdx + 1 : 0;
	const splitAt = insertAt + inserted;
	return {
		body: body.slice(0, splitAt) + `\n${newLine}\n` + body.slice(splitAt),
		changed: true,
	};
}

/** Extract the body of a markdown section between the given heading and the
 *  next heading of the same or higher level. Returns null if not found. */
function extractSection(body: string, heading: string): string | null {
	const level = heading.match(/^#+/)?.[0].length ?? 2;
	const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm');
	const m = re.exec(body);
	if (!m) return null;
	const start = m.index + m[0].length;
	const nextHeadingRe = new RegExp(`^#{1,${level}}\\s`, 'm');
	const after = body.slice(start);
	const next = nextHeadingRe.exec(after);
	return next ? after.slice(0, next.index) : after;
}

// ─── Mutation 2: project index ship log prepend ──────────────────────────────

/** Pure formatter for a ship-log entry line. Shared by `prependShipLogEntry`
 *  (the mutation) and `buildPreview` (the dry-run shape) so both surfaces
 *  show the same string. */
export function formatShipLogEntry(
	adrPath: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): string {
	const verb = STATUS_VERB[req.status];
	const ordinal = adrPath.match(/adr-(\d+)/)?.[1] ?? '???';
	const headline = `ADR-${ordinal} ${req.slice_id} ${verb.toLowerCase()}`;
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';
	return `- **${resolvedDate}** — **${headline}**${commitFragment}${notesFragment}`;
}

/** Prepend a new entry to the project index's `## Ship log` section.
 *  Format (matches existing operator convention across the cluster):
 *
 *      - **YYYY-MM-DD** — **<short summary>** commit `<sha>` — <notes prose>
 *
 *  Idempotent: if the same commit + slice already has an entry, no change.
 *  Returns the unchanged body when the section is missing — the caller logs
 *  a warning but the ship operation continues (author can add Ship log
 *  later). */
export function prependShipLogEntry(
	indexBody: string,
	adrSlug: string,
	req: ShipSliceRequest,
	resolvedDate: string,
): { body: string; changed: boolean } {
	const newEntry = formatShipLogEntry(adrSlug, req, resolvedDate);

	// Idempotency: skip if an identical entry already exists.
	if (indexBody.includes(newEntry)) {
		return { body: indexBody, changed: false };
	}

	const shipLogRe = /^## Ship log\s*\n+/m;
	const m = shipLogRe.exec(indexBody);
	if (!m) {
		return { body: indexBody, changed: false };
	}
	const insertAt = m.index + m[0].length;
	return {
		body: indexBody.slice(0, insertAt) + newEntry + '\n\n' + indexBody.slice(insertAt),
		changed: true,
	};
}

// ─── Mutation 3: ADR Falsifier scorecard closure (ADR-004 S3) ────────────────

/** Append a `✅ F<N> — closed YYYY-MM-DD (commit ..., slice ... shipped)` line
 *  to the latest `**Falsifier scorecard after S<N>**:` block in the ADR Status
 *  section. Creates a new scorecard block if none exists.
 *
 *  Idempotent: bails if a closure marker for the same F<N> already exists
 *  in the body.
 *
 *  Returns the unchanged body when no `## Status` section exists (the caller
 *  reports a structured error to the operator). */
export function appendFalsifierClosure(
	body: string,
	falsifierId: string,
	resolvedDate: string,
	commit: string | undefined,
	sliceId: string,
): { body: string; changed: boolean; newLine: string } {
	const commitFragment = commit ? `commit \`${commit}\`, ` : '';
	const newLine = `- ✅ ${falsifierId} — closed ${resolvedDate} (${commitFragment}slice ${sliceId} shipped)`;

	// Idempotency: bail if a closure marker for this falsifier already exists
	// in NON-FENCED prose. Pedagogical examples like ADR-004's example
	// `- ✅ F1 — closed 2026-05-17 (example evidence)` live inside
	// ```` ```markdown ```` fences and must NOT trigger the idempotency
	// short-circuit (caught by the F4 dogfood-ship 2026-05-17).
	const stripFencedLocal = (s: string) =>
		s.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '');
	const fenceStrippedBody = stripFencedLocal(body);
	const existingClosureRe = new RegExp(
		`^[ \\t]*(?:- )?(?:[✅⏳❌])\\s+${falsifierId}\\s+—\\s+(closed|pending|open|superseded|rejected)\\b`,
		'm',
	);
	if (existingClosureRe.test(fenceStrippedBody)) {
		// Check: is it ALREADY a `closed` marker for the same id+date+commit?
		const exactRe = new RegExp(
			`^- ✅ ${falsifierId} — closed ${resolvedDate} `,
			'm',
		);
		if (exactRe.test(fenceStrippedBody)) {
			return { body, changed: false, newLine };
		}
		// Different status (e.g. `⏳ F1 — pending`). Replace that line in place
		// so the parser's latest-wins yields the new closed state. Use the
		// regex against the ORIGINAL body — if the fence-stripped check passed,
		// the original has the marker somewhere outside a fence too (and the
		// replace will hit the FIRST occurrence; if a fenced earlier one
		// exists it'll be replaced INSTEAD, which is a known limitation —
		// real-world ADRs put closure markers in Status section which appears
		// before Context fences, so this hasn't been an issue in practice).
		return {
			body: body.replace(existingClosureRe, newLine),
			changed: true,
			newLine,
		};
	}

	// No existing closure — append to the latest `**Falsifier scorecard after ...**:`
	// block in the Status section, or create one.
	//
	// Bug fix (2026-05-17): the search MUST be bounded to the real `## Status`
	// section AND fenced code blocks must be stripped before scanning. Without
	// these guards a self-referential ADR like ADR-004 (which contains example
	// scorecard prose inside ```` ```markdown ```` fences elsewhere in the body)
	// would land the closure inside the fenced example, not the real Status
	// section. The parser correctly ignores the fenced write (fence-stripping
	// in scanning), so the corruption was silent — caught by F4 dogfood.

	// 1. Find the bounds of the real `## Status` section in the ORIGINAL body
	//    (so insert offsets line up with body indices).
	const statusHeaderRe = /^## Status\s*$/m;
	const statusHeaderMatch = statusHeaderRe.exec(body);
	if (!statusHeaderMatch) {
		// No `## Status` — append a fresh scorecard at the very top.
		const block = `## Status\n\n**Falsifier scorecard after ${sliceId}**:\n\n${newLine}\n\n`;
		return { body: block + body, changed: true, newLine };
	}
	const statusBodyStart = statusHeaderMatch.index + statusHeaderMatch[0].length;
	// Status section ends at the next `## ` heading (or end-of-body).
	const afterStatus = body.slice(statusBodyStart);
	const nextHeadingRe = /^## /m;
	const nextHeading = nextHeadingRe.exec(afterStatus);
	const statusBodyEnd = nextHeading ? statusBodyStart + nextHeading.index : body.length;
	const statusBodyText = body.slice(statusBodyStart, statusBodyEnd);

	// 2. Strip fenced blocks within the Status section so example scorecards
	//    don't shadow real ones. We can't just use the stripped body for
	//    insertion offsets — we need to scan stripped + map back to original.
	//    Workaround: search the stripped statusBodyText for the LAST scorecard
	//    header; if found, locate that same header in the ORIGINAL statusBodyText
	//    by counting how many scorecard headers precede it in stripped, then
	//    walking that many headers in original.
	const strippedStatus = stripFencedLocal(statusBodyText);
	const scorecardRe = /\*\*Falsifier scorecard after [^*]+\*\*:\s*\n+/g;
	const strippedMatches: RegExpExecArray[] = [];
	let sm: RegExpExecArray | null;
	while ((sm = scorecardRe.exec(strippedStatus)) !== null) strippedMatches.push(sm);

	if (strippedMatches.length === 0) {
		// No real scorecard in Status — append a new one at the end of the section.
		// Trim trailing whitespace then add the block + a trailing newline.
		const trimmed = body.slice(0, statusBodyEnd).replace(/\s+$/, '');
		const block = `\n\n**Falsifier scorecard after ${sliceId}**:\n\n${newLine}\n`;
		return {
			body: trimmed + block + (statusBodyEnd < body.length ? '\n' + body.slice(statusBodyEnd) : ''),
			changed: true,
			newLine,
		};
	}

	// Find the LAST scorecard in the ORIGINAL (un-stripped) statusBodyText.
	// Use the same regex; pick the Nth match where N = strippedMatches.length.
	scorecardRe.lastIndex = 0;
	const originalMatches: RegExpExecArray[] = [];
	let om: RegExpExecArray | null;
	while ((om = scorecardRe.exec(statusBodyText)) !== null) originalMatches.push(om);

	// Trust the same N: the last REAL scorecard is at originalMatches[strippedMatches.length - 1]
	// — except if there are MORE matches in original than stripped, some of the original
	// matches are inside fences (false positives). Skip those: take the last match whose
	// position falls OUTSIDE any fenced block within statusBodyText.
	let chosen: RegExpExecArray | null = null;
	if (originalMatches.length === strippedMatches.length) {
		chosen = originalMatches[originalMatches.length - 1];
	} else {
		// Compute fence ranges so we can filter
		const fenceRe = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm;
		const fenceRanges: Array<[number, number]> = [];
		let fm: RegExpExecArray | null;
		while ((fm = fenceRe.exec(statusBodyText)) !== null) {
			fenceRanges.push([fm.index, fm.index + fm[0].length]);
		}
		const outsideFences = originalMatches.filter(
			(mm) => !fenceRanges.some(([s, e]) => mm.index >= s && mm.index < e),
		);
		chosen = outsideFences[outsideFences.length - 1] ?? null;
	}

	if (chosen) {
		const blockStartInStatus = chosen.index + chosen[0].length;
		const after = statusBodyText.slice(blockStartInStatus);
		const endMatch = /\n(?:\s*\n|[^-\s])/m.exec(after);
		const insertAtInStatus = endMatch ? blockStartInStatus + endMatch.index : blockStartInStatus + after.length;
		const insertAt = statusBodyStart + insertAtInStatus;
		return {
			body: body.slice(0, insertAt) + '\n' + newLine + body.slice(insertAt),
			changed: true,
			newLine,
		};
	}

	// Fallback: every scorecard match was inside a fence — append a new one.
	const trimmed = body.slice(0, statusBodyEnd).replace(/\s+$/, '');
	const block = `\n\n**Falsifier scorecard after ${sliceId}**:\n\n${newLine}\n`;
	return {
		body: trimmed + block + (statusBodyEnd < body.length ? '\n' + body.slice(statusBodyEnd) : ''),
		changed: true,
		newLine,
	};
}

/** ADR-004 S3 — validate that the target ADR can accept a `closes_falsifier`
 *  mutation. Refuses Shape C/D/E/F (only Shape A mutates atomically),
 *  refuses non-existent F<N>, refuses already-closed F<N>. Returns the parsed
 *  Falsifier so the caller can echo the post-close state back to the user. */
export function validateClosesFalsifier(
	adrPath: string,
	adrBody: string,
	adrMeta: VaultMeta,
	falsifierId: string,
):
	| { ok: true; falsifier: Falsifier }
	| { ok: false; error: string; status_hint: number } {
	const { falsifiers } = parseFalsifiers({
		sourcePath: adrPath,
		body: adrBody,
		meta: adrMeta,
		sourceKind: 'adr-body',
	});
	const target = falsifiers.find((f) => f.id === falsifierId);
	if (!target) {
		return {
			ok: false,
			error: `closes_falsifier "${falsifierId}" not found in ${adrPath}'s Falsifier section — check spelling or add the F<N> definition first`,
			status_hint: 422,
		};
	}
	if (target.shape !== 'A') {
		const migrationHint: Record<string, string> = {
			C: 'prose-style falsifier (legacy)',
			D: 'numbered-inline falsifiers',
			E: 'named-bold-prose falsifiers',
			F: 'unstructured prose with no IDs',
		};
		return {
			ok: false,
			error: `closes_falsifier requires Shape A (\`**F<N>**\` list-items) but ${adrPath} uses Shape ${target.shape} (${migrationHint[target.shape] ?? 'unsupported'}) — migrate the Falsifier section to \`**F<N>**\` list-items before using closes_falsifier`,
			status_hint: 422,
		};
	}
	if (target.status === 'closed') {
		return {
			ok: false,
			error: `closes_falsifier ${falsifierId} is already closed (${target.closed_at ?? 'unknown date'}) — pass a different F<N> or omit closes_falsifier`,
			status_hint: 422,
		};
	}
	if (target.status === 'superseded' || target.status === 'rejected') {
		return {
			ok: false,
			error: `closes_falsifier ${falsifierId} is ${target.status} — can't close it; pass a different F<N> or omit closes_falsifier`,
			status_hint: 422,
		};
	}
	return { ok: true, falsifier: target };
}

// ─── Compose: dry-run preview shape ──────────────────────────────────────────

export interface ShipSlicePreview {
	adr_path: string;
	index_path: string;
	new_status_line: string;
	new_ship_log_entry: string;
	resolved_date: string;
	status_changed: boolean;
	ship_log_changed: boolean;
	warnings: string[];
	/** ADR-004 S3 — set when the request carried `closes_falsifier` and the
	 *  validator approved it (Shape A, F<N> exists + open). */
	falsifier_closure?: {
		falsifier_id: string;
		new_line: string;
		changed: boolean;
	};
}

/** Outcome shape from `applyShipSlice` — shared between the HTTP endpoint
 *  and the orchestrator-v2 tool. */
export interface ApplyShipSliceResult {
	success: boolean;
	applied: boolean;
	preview: ShipSlicePreview;
	error?: string;
	field?: string;
	status_hint?: number; // HTTP status the endpoint would return
	rollback_attempted?: boolean;
	rollback_ok?: boolean;
}

/** Minimal vault engine surface needed for ship-slice. Decouples this module
 *  from `getVaultEngine` so the orchestrator tool can pass any object that
 *  satisfies it (currently the real engine; future tests can pass a mock). */
export interface ShipSliceVaultEngine {
	/** ADR-004 S3 — `meta` is needed to derive falsifier status fallbacks for
	 *  Shape C/F ADRs (e.g. `status: shipped` → criteria treated as closed). */
	getNote(
		path: string,
	):
		| Promise<{ content: string; meta?: VaultMeta } | null>
		| { content: string; meta?: VaultMeta }
		| null
		// VaultEngine.getNote is sync and returns `undefined` (not null) when absent.
		| undefined;
	/** ADR-003 S4 — `opts.actor` lets ship-slice stamp the audit log + commit
	 *  with `projectShipSlice` instead of the note's original `source_agent`. */
	updateNote(
		path: string,
		patch: { content?: string },
		opts?: { actor?: string; actorContext?: string },
	): Promise<{ success?: boolean; error?: string }>;
}

/** Shared core for both the HTTP endpoint and the orchestrator-v2 tool.
 *  Validates the request, resolves the ADR path, computes the preview, and
 *  (unless dryRun) writes both notes atomically with rollback. */
export async function applyShipSlice(
	engine: ShipSliceVaultEngine,
	slug: string,
	req: ShipSliceRequest,
	opts: { dryRun?: boolean } = {},
): Promise<ApplyShipSliceResult> {
	const indexPath = `projects/${slug}/index.md`;
	const indexNote = await engine.getNote(indexPath);
	if (!indexNote) {
		return {
			success: false,
			applied: false,
			preview: emptyPreviewShape(),
			error: `project index not found at ${indexPath}`,
			status_hint: 404,
		};
	}
	const indexBody = indexNote.content;

	// Resolve in two passes: literal shorthand first; if the file doesn't
	// exist, fall back to a project-index wikilink lookup (handles partial
	// slugs like `adr-003` that need the descriptive suffix appended).
	let adrPath = resolveAdrPath(slug, req.adr);
	let adrNote = adrPath ? await engine.getNote(adrPath) : null;
	if (!adrNote) {
		// Strip `adr-` prefix if present, then look up by ordinal.
		const ordinalHint = req.adr.replace(/^adr-/, '').split('-')[0];
		const fallbackPath = findAdrPathByOrdinal(indexBody, slug, ordinalHint);
		if (fallbackPath) {
			adrPath = fallbackPath;
			adrNote = await engine.getNote(adrPath);
		}
	}
	if (!adrPath || !adrNote) {
		return {
			success: false,
			applied: false,
			preview: emptyPreviewShape(),
			error: `could not resolve adr "${req.adr}" in project "${slug}" — try a full slug like "adr-007-peer-brief-naseej-port"`,
			field: 'adr',
			status_hint: 400,
		};
	}
	const adrBody = adrNote.content;
	const adrMeta = (adrNote as { meta?: VaultMeta }).meta ?? ({ type: 'decision' } as VaultMeta);

	// ADR-004 S3 — if closes_falsifier is set, validate BEFORE buildPreview so
	// the dry-run surface also reflects the refusal. Validation refuses for
	// non-Shape-A targets + non-existent + already-closed F<N>.
	if (req.closes_falsifier) {
		const v = validateClosesFalsifier(adrPath, adrBody, adrMeta, req.closes_falsifier);
		if (!v.ok) {
			return {
				success: false,
				applied: false,
				preview: emptyPreviewShape(),
				error: v.error,
				field: 'closes_falsifier',
				status_hint: v.status_hint,
			};
		}
	}

	const preview = buildPreview(adrPath, adrBody, indexPath, indexBody, req);

	if (opts.dryRun) {
		return { success: true, applied: false, preview };
	}

	if (
		!preview.status_changed &&
		!preview.ship_log_changed &&
		preview.warnings.length === 0 &&
		!preview.falsifier_closure?.changed
	) {
		return {
			success: false,
			applied: false,
			preview,
			error: 'no-op — slice marker already present and ship-log entry already exists',
			status_hint: 422,
		};
	}

	const resolvedDate = preview.resolved_date;
	// Compose ADR mutations in sequence so both Status marker + falsifier
	// closure land in a SINGLE updateNote call. Avoids the race-against-itself
	// failure mode of writing the same file twice.
	const statusMutation = appendSliceMarkerToStatus(adrBody, req, resolvedDate);
	let adrIntermediateBody = statusMutation.body;
	let adrChanged = statusMutation.changed;
	if (req.closes_falsifier) {
		const closure = appendFalsifierClosure(
			adrIntermediateBody,
			req.closes_falsifier,
			resolvedDate,
			req.commit,
			req.slice_id,
		);
		adrIntermediateBody = closure.body;
		adrChanged = adrChanged || closure.changed;
	}
	const adrUpdate = { body: adrIntermediateBody, changed: adrChanged };
	const indexUpdate = prependShipLogEntry(indexBody, adrPath, req, resolvedDate);

	// ADR-003 S4 — stamp every audit-log + commit entry from this transaction
	// with `projectShipSlice` so the orchestrator's footprint is distinct from
	// the note's original `source_agent` (the human/agent who authored it).
	const SHIP_ACTOR = 'projectShipSlice';
	const shipContext = `slug=${slug} adr=${req.adr} slice=${req.slice_id} status=${req.status}${
		req.commit ? ` commit=${req.commit}` : ''
	}`;
	const writeOpts = { actor: SHIP_ACTOR, actorContext: shipContext };
	const rollbackOpts = {
		actor: SHIP_ACTOR,
		actorContext: `${shipContext} rollback=adr-write`,
	};

	let adrWriteOk = false;
	let indexWriteOk = false;
	let rollbackAttempted = false;
	let rollbackOk = false;
	let failureDetail: string | undefined;

	try {
		if (adrUpdate.changed) {
			const res = await engine.updateNote(adrPath, { content: adrUpdate.body }, writeOpts);
			adrWriteOk = res.success ?? true;
			if (!adrWriteOk) failureDetail = `ADR write refused: ${res.error ?? 'unknown'}`;
		} else {
			adrWriteOk = true;
		}
	} catch (err) {
		failureDetail = `ADR write threw: ${(err as Error).message}`;
	}

	if (adrWriteOk) {
		try {
			if (indexUpdate.changed) {
				const res = await engine.updateNote(indexPath, { content: indexUpdate.body }, writeOpts);
				indexWriteOk = res.success ?? true;
				if (!indexWriteOk) failureDetail = `index write refused: ${res.error ?? 'unknown'}`;
			} else {
				indexWriteOk = true;
			}
		} catch (err) {
			failureDetail = `index write threw: ${(err as Error).message}`;
		}
	}

	if (adrWriteOk && !indexWriteOk && adrUpdate.changed) {
		rollbackAttempted = true;
		try {
			const res = await engine.updateNote(adrPath, { content: adrBody }, rollbackOpts);
			rollbackOk = res.success ?? true;
		} catch {
			rollbackOk = false;
		}
	}

	const allOk = adrWriteOk && indexWriteOk;
	return {
		success: allOk,
		applied: adrWriteOk || indexWriteOk,
		preview,
		error: allOk ? undefined : (failureDetail ?? 'unknown write failure'),
		status_hint: allOk ? 200 : 500,
		rollback_attempted: rollbackAttempted,
		rollback_ok: rollbackOk,
	};
}

function emptyPreviewShape(): ShipSlicePreview {
	return {
		adr_path: '',
		index_path: '',
		new_status_line: '',
		new_ship_log_entry: '',
		// ADR-011 — Dubai-default ship date, not UTC.
		resolved_date: todayInTimezone(new Date()),
		status_changed: false,
		ship_log_changed: false,
		warnings: [],
	};
}

export function buildPreview(
	adrPath: string,
	adrBody: string,
	indexPath: string,
	indexBody: string,
	req: ShipSliceRequest,
): ShipSlicePreview {
	// ADR-011 — Dubai-default ship date when req.date is absent. Operator
	// override via req.date still wins; explicit req.timezone can change the
	// auto-derived default for cross-tz operators.
	const resolvedDate = req.date ?? todayInTimezone(new Date(), req.timezone);

	const parsed = parseSliceLabel(req.slice_id);
	const warnings: string[] = [];
	if (!parsed) {
		warnings.push(`slice_id "${req.slice_id}" doesn't match canonical shape — accepted anyway`);
	}

	const statusUpdate = appendSliceMarkerToStatus(adrBody, req, resolvedDate);
	const shipLogUpdate = prependShipLogEntry(indexBody, adrPath, req, resolvedDate);
	if (!shipLogUpdate.changed && !indexBody.includes('## Ship log')) {
		warnings.push('project index has no `## Ship log` section — entry not prepended');
	}

	// ADR-004 S3 — when closes_falsifier is set on the request, show the
	// closure marker line in the dry-run preview. Validator runs upstream in
	// applyShipSlice; here we just compute the would-be mutation.
	let falsifier_closure: ShipSlicePreview['falsifier_closure'];
	if (req.closes_falsifier) {
		const c = appendFalsifierClosure(
			statusUpdate.body,
			req.closes_falsifier,
			resolvedDate,
			req.commit,
			req.slice_id,
		);
		falsifier_closure = {
			falsifier_id: req.closes_falsifier,
			new_line: c.newLine,
			changed: c.changed,
		};
	}

	const verb = STATUS_VERB[req.status];
	const commitFragment = req.commit ? ` commit \`${req.commit}\`` : '';
	const notesFragment = req.notes ? ` — ${req.notes}` : '';

	return {
		adr_path: adrPath,
		index_path: indexPath,
		new_status_line: `**${req.slice_id} ${verb} ${resolvedDate}**${commitFragment}${notesFragment}`,
		new_ship_log_entry: formatShipLogEntry(adrPath, req, resolvedDate),
		resolved_date: resolvedDate,
		status_changed: statusUpdate.changed,
		ship_log_changed: shipLogUpdate.changed,
		warnings,
		falsifier_closure,
	};
}
