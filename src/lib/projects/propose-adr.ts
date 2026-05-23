/**
 * project-phases ADR-005 S1 — proposeAdr orchestrator tool core.
 *
 * Composes a new ADR markdown note + computes next-available ordinal
 * within the target project + writes via engine.createNote with
 * actor='proposeAdr' (using the ADR-005 S0 CreateNoteOpts extension).
 *
 * Pure functions (composeAdrFrontmatter / composeAdrBody / deriveAdrSlug
 * / nextOrdinalFromNotes) live here so tests can exercise them without
 * spinning up the engine. The orchestrator entry point (`applyProposeAdr`)
 * is the only one that talks to the engine.
 */

import { z } from 'zod';
import type { VaultEngine } from '../vault/index.js';
import type { VaultMeta } from '../vault/types.js';

// ─── Input schema ─────────────────────────────────────────────────────

const WIKILINK_RE = /^\[\[[^\]\n]+\]\]$/;

export const ProposeAdrInputSchema = z
	.object({
		/** Target project slug — must match an existing `projects/<slug>/` folder. */
		slug: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]+$/),
		/** Human-readable title — kebab-slugified for the filename. */
		working_title: z.string().trim().min(3).max(120),
		/** ADR size class per project-phases retrospective convention. */
		tier: z.enum(['Tier 1', 'Tier 2', 'Tier 3']),
		/** One-paragraph problem statement (Context section body). */
		problem_statement: z.string().trim().min(20).max(2000),
		/** 3-5 bullets sketching the decision approach. */
		decision_sketch: z.array(z.string().trim().min(5).max(500)).min(3).max(8),
		/** ≥1 falsifier conditions. Each becomes F1/F2/... in the Falsifiers section. */
		falsifier_conditions: z.array(z.string().trim().min(10).max(500)).min(1).max(10),
		/** Optional wikilink array — auto-attached as `relates_to` in frontmatter
		 *  + listed under Related section. Operator can promote to `blocked_by`
		 *  via AdrDrawer after accepting if a stricter relationship is needed. */
		parent_adrs: z.array(z.string().trim().regex(WIKILINK_RE)).max(10).optional(),
		/** Source agent label for frontmatter — distinct from opts.actor (which
		 *  goes to audit log). When omitted, defaults to 'proposeAdr'. */
		source_agent: z.string().trim().min(1).max(60).optional(),
		/** ADR-010 S1 — IANA timezone for date rendering (`created` field +
		 *  Status PROPOSED line + `falsifier_date` base). Defaults to
		 *  `Asia/Dubai` per operator location. Pass `'UTC'` for legacy behavior. */
		timezone: z.string().trim().min(1).max(60).optional(),
	})
	.strict();

export type ProposeAdrInput = z.infer<typeof ProposeAdrInputSchema>;

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Convert "AI propose-ADR + propose-slice asymmetry" → "ai-propose-adr-and-propose-slice".
 *  Mirrors the existing-ADR slug convention (kebab, alphanumeric + dashes, ≤60 chars). */
export function deriveAdrSlug(working_title: string): string {
	return working_title
		.toLowerCase()
		.replace(/\+/g, ' and ')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
}

/** Scan a flat list of note paths and return the next-available `adr-NNN-`
 *  ordinal (zero-padded 3 digits) for the given project. Pure — takes
 *  paths as input so tests can supply synthetic data. */
export function nextOrdinalFromNotes(paths: string[], slug: string): string {
	const prefix = `projects/${slug}/`;
	const re = /^adr-(\d{1,3})-/;
	let max = 0;
	for (const p of paths) {
		if (!p.startsWith(prefix)) continue;
		const filename = p.slice(prefix.length);
		const m = re.exec(filename);
		if (m) max = Math.max(max, parseInt(m[1], 10));
	}
	return String(max + 1).padStart(3, '0');
}

const DEFAULT_FALSIFIER_DAYS = 90;

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** ADR-010 S1 — strip a leading `F<N>` prefix + separator from a falsifier
 *  string so `composeAdrBody`'s `**F<N>**` prefix doesn't render as the
 *  visible double-label `**F1** F1 — text`. Covers all 5 separator variants
 *  (em-dash, colon, hyphen, period, close-paren) and optional surrounding
 *  markdown asterisks. Anchored at start so mid-text mentions of F<N>
 *  (e.g. "Requires F1 to close") are NOT stripped. */
const FALSIFIER_PREFIX_RE = /^\s*\*{0,2}F\d+\*{0,2}\s*[—:\-.)]\s*/;

export function stripFalsifierPrefix(s: string): string {
	return s.replace(FALSIFIER_PREFIX_RE, '');
}

/** ADR-010 S1 — render today's date in the given IANA timezone (defaults
 *  to Asia/Dubai per operator location). Returns YYYY-MM-DD. The `en-CA`
 *  locale produces the ISO date format directly without us assembling
 *  parts. UTC-default callers can pass `'UTC'`. */
export function todayInTimezone(now: Date, timezone: string = 'Asia/Dubai'): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(now);
}

export interface ComposeOpts {
	ordinal: string; // "001", "002", ...
	created: string; // YYYY-MM-DD
	parent_project?: string; // wikilink to parent (e.g. "[[../soul-hub/index|soul-hub]]")
	cluster_tag?: string; // e.g. "cluster:soul-hub"
}

export function composeAdrFrontmatter(input: ProposeAdrInput, opts: ComposeOpts): VaultMeta {
	const tags: string[] = [input.slug, 'decision', 'proposed-by-ai'];
	if (opts.cluster_tag) tags.unshift(opts.cluster_tag);
	const meta: VaultMeta = {
		type: 'decision',
		status: 'proposed',
		created: opts.created,
		tags,
		project: input.slug,
		falsifier_date: addDays(opts.created, DEFAULT_FALSIFIER_DAYS),
		source_agent: input.source_agent ?? 'proposeAdr',
		source_context: `proposed via proposeAdr tool — slug=${input.slug} tier=${input.tier} ordinal=${opts.ordinal}`,
	};
	if (opts.parent_project) meta.parent_project = opts.parent_project;
	if (input.parent_adrs && input.parent_adrs.length > 0) {
		meta.relates_to = input.parent_adrs.length === 1 ? input.parent_adrs[0] : input.parent_adrs;
	}
	return meta;
}

export function composeAdrBody(input: ProposeAdrInput, opts: ComposeOpts): string {
	const lines: string[] = [];
	lines.push(`# ADR-${opts.ordinal} — ${input.working_title}`, '');

	lines.push('## Status', '');
	lines.push(
		`**PROPOSED ${opts.created}** — Drafted via \`proposeAdr\` orchestrator tool ([ADR-005](../project-phases/adr-005-ai-propose-adr-and-propose-slice.md) S1). Tier: **${input.tier}**. Operator review pending — open in the AdrDrawer and use the Accept / Reject / Park buttons.`,
		'',
	);

	lines.push('## Context', '');
	lines.push(input.problem_statement, '');

	lines.push('## Decision (sketch)', '');
	for (const bullet of input.decision_sketch) {
		lines.push(`- ${bullet}`);
	}
	lines.push('');

	lines.push('## Falsifiers', '');
	const deadline = addDays(opts.created, DEFAULT_FALSIFIER_DAYS);
	lines.push(`Deadline ${deadline} (default 3-month window; operator can adjust on acceptance).`, '');
	input.falsifier_conditions.forEach((cond, i) => {
		// ADR-010 S1 — strip any leading F<N>+separator the caller mistakenly
		// included, so the rendered prefix never doubles up.
		const cleaned = stripFalsifierPrefix(cond);
		lines.push(`- **F${i + 1}** ${cleaned}`);
	});
	lines.push('');

	lines.push('## Implementation plan', '');
	lines.push('| Slice | Scope | Estimate |');
	lines.push('|---|---|---|');
	lines.push('| S1 | (operator to fill in after acceptance) | — |');
	lines.push('');

	lines.push('## Related', '');
	lines.push(`- [[index|${input.slug}]] — the project this ADR was drafted under`);
	if (input.parent_adrs && input.parent_adrs.length > 0) {
		for (const link of input.parent_adrs) {
			lines.push(`- ${link}`);
		}
	}
	lines.push(
		'- [[../project-phases/adr-005-ai-propose-adr-and-propose-slice|ADR-005]] — the tool that drafted this ADR',
	);
	lines.push('');

	return lines.join('\n');
}

// ─── Orchestration ────────────────────────────────────────────────────

export interface ProposeAdrResult {
	success: true;
	path: string;
	ordinal: string;
	adr_slug: string;
	preview: {
		filename: string;
		title: string;
		falsifier_date: string;
	};
	retried_after_collision?: true;
}

export interface ProposeAdrError {
	success: false;
	error: string;
	status_hint?: number;
	field?: string;
}

/** Reads cluster tag + parent_project from the project's index.md so the new
 *  ADR inherits its parent's cluster + hierarchy. Best-effort — if the index
 *  has neither field, returns empty opts and the operator can patch via
 *  AdrDrawer post-acceptance. */
function inheritProjectMeta(engine: VaultEngine, slug: string): {
	parent_project?: string;
	cluster_tag?: string;
} {
	const indexPath = `projects/${slug}/index.md`;
	const index = engine.getNote(indexPath);
	if (!index) return {};
	const out: { parent_project?: string; cluster_tag?: string } = {};
	const parent = index.meta.parent_project;
	if (typeof parent === 'string') out.parent_project = parent;
	const tags = Array.isArray(index.meta.tags) ? index.meta.tags : [];
	const cluster = tags.find(
		(t): t is string => typeof t === 'string' && t.startsWith('cluster:'),
	);
	if (cluster) out.cluster_tag = cluster;
	return out;
}

export interface ApplyOpts {
	/** Override "today" — used by tests. */
	now?: () => Date;
}

const FILE_EXISTS_RE = /^File already exists:/;

export async function applyProposeAdr(
	engine: VaultEngine,
	rawInput: unknown,
	applyOpts: ApplyOpts = {},
): Promise<ProposeAdrResult | ProposeAdrError> {
	const parsed = ProposeAdrInputSchema.safeParse(rawInput);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			success: false,
			error: `Invalid input: ${first?.path.join('.')}: ${first?.message}`,
			status_hint: 400,
		};
	}
	const input = parsed.data;

	// Verify the project exists — refuse on unknown slug rather than
	// silently creating a project-less ADR.
	const indexExists = engine.getNote(`projects/${input.slug}/index.md`);
	if (!indexExists) {
		return {
			success: false,
			error: `Project not found: projects/${input.slug}/ has no index.md`,
			status_hint: 404,
			field: 'slug',
		};
	}

	const now = (applyOpts.now ?? (() => new Date()))();
	// ADR-010 S1 — render `created` in the operator's TZ (default Asia/Dubai)
	// so an ADR drafted at 23:00 Dubai gets today's Dubai calendar date,
	// not yesterday's UTC date. addDays() keeps its UTC math — that's
	// unambiguous for adding 90 days to a YYYY-MM-DD anchor.
	const created = todayInTimezone(now, input.timezone);
	const inherited = inheritProjectMeta(engine, input.slug);
	const adrSlug = deriveAdrSlug(input.working_title);

	const allPaths = engine.getAllNotes().map((n) => n.path);
	let ordinal = nextOrdinalFromNotes(allPaths, input.slug);

	let composeOpts: ComposeOpts = { ordinal, created, ...inherited };
	let filename = `adr-${ordinal}-${adrSlug}.md`;

	let result = await engine.createNote(
		{
			zone: `projects/${input.slug}`,
			filename,
			meta: composeAdrFrontmatter(input, composeOpts),
			content: composeAdrBody(input, composeOpts),
		},
		{
			actor: 'proposeAdr',
			actorContext: `slug=${input.slug} tier=${input.tier} title="${input.working_title.slice(0, 60)}"`,
		},
	);

	let retried = false;
	if (!result.success && FILE_EXISTS_RE.test(result.error ?? '')) {
		// Race: operator hand-created adr-NNN-... between our ordinal lookup
		// and write. Re-scan + retry once.
		const refreshedPaths = engine.getAllNotes().map((n) => n.path);
		ordinal = nextOrdinalFromNotes(refreshedPaths, input.slug);
		composeOpts = { ordinal, created, ...inherited };
		filename = `adr-${ordinal}-${adrSlug}.md`;
		result = await engine.createNote(
			{
				zone: `projects/${input.slug}`,
				filename,
				meta: composeAdrFrontmatter(input, composeOpts),
				content: composeAdrBody(input, composeOpts),
			},
			{
				actor: 'proposeAdr',
				actorContext: `slug=${input.slug} tier=${input.tier} title="${input.working_title.slice(0, 60)}" retry=1`,
			},
		);
		retried = true;
		if (!result.success && FILE_EXISTS_RE.test(result.error ?? '')) {
			return {
				success: false,
				error: `Two consecutive collisions on adr-${ordinal}-${adrSlug}.md — operator likely racing manual ADR creation. Please retry once the manual write settles.`,
				status_hint: 409,
			};
		}
	}

	if (!result.success) {
		return {
			success: false,
			error: result.error ?? 'createNote failed',
			status_hint: 400,
			field: result.field,
		};
	}

	const ret: ProposeAdrResult = {
		success: true,
		path: result.path,
		ordinal,
		adr_slug: adrSlug,
		preview: {
			filename,
			title: `ADR-${ordinal} — ${input.working_title}`,
			falsifier_date: addDays(created, DEFAULT_FALSIFIER_DAYS),
		},
	};
	if (retried) ret.retried_after_collision = true;
	return ret;
}
