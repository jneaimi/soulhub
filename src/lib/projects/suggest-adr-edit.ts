/**
 * project-phases ADR-005 S3 — suggestAdrEdit orchestrator tool core.
 *
 * Writes a NEW vault note under `projects/<slug>/proposals/` describing
 * a structured edit suggestion for an existing ADR. NEVER mutates the
 * target ADR itself — operator reviews and applies via AdrDrawer.
 *
 * Pure functions (composeProposalFrontmatter / composeProposalBody /
 * deriveProposalSlug / nextProposalFilename) live here so tests can
 * exercise them without an engine. `applyProposeAdrEdit` is the
 * orchestration entry point.
 *
 * Proposal note shape (per ~/vault/projects/CLAUDE.md "Proposal Notes"):
 *   path: projects/<slug>/proposals/YYYY-MM-DD-NN-<short-slug>.md
 *   frontmatter:
 *     type: proposal
 *     status: open
 *     target_adr: "[[adr-NNN-slug]]"
 *     proposed_section: <Decision|Falsifiers|Context|Status|Implementation plan|Related>
 *     created: YYYY-MM-DD
 *     tags: [proposal, proposed-by-ai, <slug>, <cluster-tag?>]
 *     project: <slug>
 *     source_agent: suggestAdrEdit (or override)
 *   body:
 *     # Proposal — <short title>
 *     ## Target
 *     - ADR: [[adr-NNN-slug]]
 *     - Section: ## <section>
 *     ## Rationale
 *     <rationale>
 *     ## Proposed text
 *     <proposed_text>
 */

import { z } from 'zod';
import type { VaultMeta } from '../vault/types.js';

// Inlined from ship-slice.ts to keep this module's import graph free of
// SvelteKit `.js` aliases (testability per
// feedback_no_raw_node_for_sveltekit_lib_smoke).

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

export const PROPOSAL_SECTIONS = [
	'Status',
	'Context',
	'Decision',
	'Falsifiers',
	'Implementation plan',
	'Related',
] as const;

export type ProposalSection = (typeof PROPOSAL_SECTIONS)[number];

export const SuggestAdrEditInputSchema = z
	.object({
		slug: z
			.string()
			.trim()
			.min(1)
			.regex(/^[a-z0-9][a-z0-9-]+$/),
		/** ADR identifier — same resolution as projectShipSlice / proposeSlice. */
		adr: z.string().trim().min(1),
		/** Target section in the ADR — one of the six standard sections. */
		section: z.enum(PROPOSAL_SECTIONS),
		/** Short title for the proposal (used to derive the filename). */
		title: z.string().trim().min(3).max(120),
		/** Why the edit is being suggested. 1-3 sentences expected. */
		rationale: z.string().trim().min(20).max(2000),
		/** Markdown chunk the operator can paste into the target section. */
		proposed_text: z.string().trim().min(20).max(8000),
		/** Source agent override for audit attribution. Defaults to 'suggestAdrEdit'. */
		source_agent: z.string().trim().min(1).max(60).optional(),
	})
	.strict();

export type SuggestAdrEditInput = z.infer<typeof SuggestAdrEditInputSchema>;

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Convert a title into a kebab-slug suitable for the proposal filename.
 *  Mirrors deriveAdrSlug's rules: lowercase, alphanumeric + dashes, ≤40 chars
 *  (shorter than ADR slugs so the date-prefix + counter still fit). */
export function deriveProposalSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/\+/g, ' and ')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '');
}

/** Scan existing proposal paths under `projects/<slug>/proposals/` and
 *  return the next-available `YYYY-MM-DD-NN-<short-slug>.md` filename
 *  for the given date. Counter is zero-padded (`01`, `02`, ...). Pure —
 *  takes paths as input so tests can supply synthetic data. */
export function nextProposalFilename(
	existingPaths: string[],
	slug: string,
	date: string,
	shortSlug: string,
): string {
	const prefix = `projects/${slug}/proposals/`;
	const dateRe = new RegExp(`^${date}-(\\d{2})-`);
	let max = 0;
	for (const p of existingPaths) {
		if (!p.startsWith(prefix)) continue;
		const filename = p.slice(prefix.length);
		const m = dateRe.exec(filename);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n > max) max = n;
		}
	}
	const counter = String(max + 1).padStart(2, '0');
	return `${date}-${counter}-${shortSlug}.md`;
}

export interface ComposeProposalOpts {
	created: string; // YYYY-MM-DD
	cluster_tag?: string; // e.g. "cluster:soul-hub"
	target_adr_slug: string; // bare adr slug e.g. "adr-005-ai-propose-adr-and-propose-slice"
}

export function composeProposalFrontmatter(
	input: SuggestAdrEditInput,
	opts: ComposeProposalOpts,
): VaultMeta {
	const tags: string[] = [input.slug, 'proposal', 'proposed-by-ai'];
	if (opts.cluster_tag) tags.unshift(opts.cluster_tag);
	const meta: VaultMeta = {
		type: 'proposal',
		status: 'open',
		created: opts.created,
		tags,
		project: input.slug,
		target_adr: `[[${opts.target_adr_slug}]]`,
		proposed_section: input.section,
		source_agent: input.source_agent ?? 'suggestAdrEdit',
		source_context: `proposal via suggestAdrEdit — slug=${input.slug} adr=${opts.target_adr_slug} section=${input.section}`,
	};
	return meta;
}

export function composeProposalBody(
	input: SuggestAdrEditInput,
	opts: ComposeProposalOpts,
): string {
	const lines: string[] = [];
	lines.push(`# Proposal — ${input.title}`, '');

	lines.push('## Target', '');
	lines.push(`- ADR: [[${opts.target_adr_slug}]]`);
	lines.push(`- Section: \`## ${input.section}\``);
	lines.push(`- Drafted: ${opts.created}`);
	lines.push(
		'- Status: `open` — operator transitions to `applied` or `rejected` after review',
	);
	lines.push('');

	lines.push('## Rationale', '');
	lines.push(input.rationale, '');

	lines.push('## Proposed text', '');
	lines.push(
		`The markdown below is what the AI suggests inserting into / replacing within the \`## ${input.section}\` section of the target ADR. Operator decides whether to apply verbatim, edit, or reject.`,
		'',
	);
	lines.push(input.proposed_text, '');

	lines.push('## Related', '');
	lines.push(`- [[../index|${input.slug}]] — the project this proposal targets`);
	lines.push(`- [[../${opts.target_adr_slug}|target ADR]]`);
	lines.push(
		'- [[../../project-phases/adr-005-ai-propose-adr-and-propose-slice|ADR-005]] — the tool that drafted this proposal',
	);
	lines.push('');

	return lines.join('\n');
}

// ─── Orchestration ────────────────────────────────────────────────────

export interface SuggestAdrEditResult {
	success: true;
	path: string;
	filename: string;
	target_adr: string;
	section: ProposalSection;
}

export interface SuggestAdrEditError {
	success: false;
	error: string;
	status_hint?: number;
	field?: string;
}

export interface SuggestEngine {
	getNote(
		path: string,
	):
		| Promise<{ content: string; meta?: VaultMeta } | null>
		| { content: string; meta?: VaultMeta }
		| null
		// VaultEngine.getNote is sync and returns `undefined` (not null) when absent.
		| undefined;
	getAllNotes(): Array<{ path: string }>;
	createNote(
		req: {
			zone: string;
			filename: string;
			meta: VaultMeta;
			content: string;
		},
		opts?: { actor?: string; actorContext?: string },
	): Promise<{ success?: boolean; error?: string; path?: string; field?: string }>;
}

function inheritProjectCluster(
	engine: SuggestEngine,
	slug: string,
): { cluster_tag?: string } {
	const indexNote = engine.getNote(`projects/${slug}/index.md`);
	// `getNote` may return a Promise or value — propose-adr uses sync, we do too.
	if (!indexNote || indexNote instanceof Promise) return {};
	const out: { cluster_tag?: string } = {};
	const tags = Array.isArray(indexNote.meta?.tags) ? indexNote.meta!.tags : [];
	const cluster = tags.find(
		(t): t is string => typeof t === 'string' && t.startsWith('cluster:'),
	);
	if (cluster) out.cluster_tag = cluster;
	return out;
}

export interface ApplyOpts {
	now?: () => Date;
}

export async function applyProposeAdrEdit(
	engine: SuggestEngine,
	rawInput: unknown,
	applyOpts: ApplyOpts = {},
): Promise<SuggestAdrEditResult | SuggestAdrEditError> {
	const parsed = SuggestAdrEditInputSchema.safeParse(rawInput);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			success: false,
			error: `Invalid input: ${first?.path.join('.')}: ${first?.message}`,
			status_hint: 400,
		};
	}
	const input = parsed.data;

	// Verify project exists.
	const indexNote = await engine.getNote(`projects/${input.slug}/index.md`);
	if (!indexNote) {
		return {
			success: false,
			error: `Project not found: projects/${input.slug}/ has no index.md`,
			status_hint: 404,
			field: 'slug',
		};
	}

	// Resolve target ADR path — two-pass strategy like ship-slice.
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

	// Extract bare ADR slug from the resolved path (strip prefix + .md).
	const adrSlug = adrPath
		.slice(`projects/${input.slug}/`.length)
		.replace(/\.md$/, '');

	const now = (applyOpts.now ?? (() => new Date()))();
	const created = now.toISOString().slice(0, 10);
	const cluster = inheritProjectCluster(engine, input.slug);
	const shortSlug = deriveProposalSlug(input.title);

	const allPaths = engine.getAllNotes().map((n) => n.path);
	let filename = nextProposalFilename(allPaths, input.slug, created, shortSlug);

	const opts: ComposeProposalOpts = {
		created,
		cluster_tag: cluster.cluster_tag,
		target_adr_slug: adrSlug,
	};

	const FILE_EXISTS_RE = /^File already exists:/;

	let result = await engine.createNote(
		{
			zone: `projects/${input.slug}/proposals`,
			filename,
			meta: composeProposalFrontmatter(input, opts),
			content: composeProposalBody(input, opts),
		},
		{
			actor: 'suggestAdrEdit',
			actorContext: `slug=${input.slug} adr=${adrSlug} section=${input.section} title="${input.title.slice(0, 60)}"`,
		},
	);

	if (!result.success && FILE_EXISTS_RE.test(result.error ?? '')) {
		// Same-second collision — refresh + retry once.
		const refreshedPaths = engine.getAllNotes().map((n) => n.path);
		filename = nextProposalFilename(refreshedPaths, input.slug, created, shortSlug);
		result = await engine.createNote(
			{
				zone: `projects/${input.slug}/proposals`,
				filename,
				meta: composeProposalFrontmatter(input, opts),
				content: composeProposalBody(input, opts),
			},
			{
				actor: 'suggestAdrEdit',
				actorContext: `slug=${input.slug} adr=${adrSlug} section=${input.section} retry=1`,
			},
		);
	}

	if (!result.success) {
		return {
			success: false,
			error: result.error ?? 'createNote failed',
			status_hint: 400,
			field: result.field,
		};
	}

	return {
		success: true,
		path: result.path!,
		filename,
		target_adr: adrSlug,
		section: input.section,
	};
}
