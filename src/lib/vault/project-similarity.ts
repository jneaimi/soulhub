/** ADR-038 Phase 3 — creation-time validation hook.
 *
 *  Surfaces likely-duplicate or related projects before a new project
 *  folder is written. Soft gate: returns matches; the operator decides
 *  whether to proceed (force-create), pick an existing project to extend,
 *  or pick a different name.
 *
 *  Two strategies, in order:
 *  1. **Lexical** — slug-substring + MiniSearch over existing project
 *     index notes (type: index | project) in the `projects/` zone.
 *  2. **Semantic** — only fires when lexical returns zero hits AND the
 *     `GEMINI_API_KEY` env var is set. One Gemini Flash call, no retries.
 *
 *  Returns a flat `SimilarityResult` consumed by `/api/vault/projects/similar`
 *  and the `/new` page UI. Cheap to call; safe to debounce on input change.
 */

import type { VaultEngine } from './index.js';
import { gemini } from '$lib/llm/gemini.js';

export interface SimilarityMatch {
	/** Existing project slug. */
	slug: string;
	/** Index-note title (falls back to slug when missing). */
	title: string;
	/** Parent project slug, if any — helps the operator decide whether
	 *  this is a sibling cluster or a totally unrelated namespace. */
	parentProject: string | null;
	/** Why this matched. */
	reason: 'slug-exact' | 'slug-substring' | 'lexical' | 'semantic';
	/** 0-1, higher = more similar. Comparable within a reason; absolute
	 *  scale differs per reason. */
	score: number;
	/** First ~120 chars of body (for the UI to render a snippet). */
	snippet?: string;
}

export type SemanticVerdict = 'duplicate' | 'related' | 'novel' | 'skipped' | 'error';

export interface SimilarityResult {
	proposedSlug: string;
	matches: SimilarityMatch[];
	lexicalHits: number;
	semanticCheck: SemanticVerdict | null;
	/** Free-text reason from Gemini when `semanticCheck` is set. */
	semanticReason?: string;
	/** Aggregate confidence that this is a duplicate-or-related project.
	 *  - `high` — exact slug match OR Gemini said "duplicate"
	 *  - `medium` — slug-substring match OR strong lexical OR Gemini said "related"
	 *  - `low` — no signal (novel) */
	confidence: 'high' | 'medium' | 'low';
}

export interface SimilarityInput {
	/** Proposed kebab-case slug (e.g. `soul-hub-whatsapp`). Required. */
	slug: string;
	/** Optional human title. Used in the semantic prompt. */
	title?: string;
	/** Optional 1-2 sentence description. Used by both strategies. */
	description?: string;
}

export interface SimilarityOptions {
	/** Skip the Gemini Flash call even when lexical returns zero. Useful
	 *  for batch checks or when the operator just wants a fast lexical
	 *  read. */
	skipSemantic?: boolean;
	/** Override the semantic model. Defaults to gemini's `defaultModel`. */
	semanticModel?: string;
	/** Max matches to return. Default 8. */
	limit?: number;
}

const DEFAULT_LIMIT = 8;
/** MiniSearch raw-score threshold for a lexical hit to be worth surfacing.
 *  Empirically: slug-match queries against project indexes score 100-300;
 *  unrelated body-token matches score 2-10. 30 cleanly separates the two. */
const LEXICAL_MIN_RAW = 30;
/** Above this raw score the lexical hit counts as a STRONG signal — used
 *  to gate whether the semantic fallback runs. */
const LEXICAL_STRONG_RAW = 100;

export async function checkProjectSimilarity(
	engine: VaultEngine,
	proposed: SimilarityInput,
	opts: SimilarityOptions = {},
): Promise<SimilarityResult> {
	const slug = proposed.slug.trim().toLowerCase();
	const limit = opts.limit ?? DEFAULT_LIMIT;

	if (!slug) {
		return {
			proposedSlug: slug,
			matches: [],
			lexicalHits: 0,
			semanticCheck: null,
			confidence: 'low',
		};
	}

	// Collect existing project index notes — these are the universe to
	// compare against. We use `type` filter (index | project) and zone
	// `projects` to keep the scan tight. The vault has ~50 projects; this
	// list query is sub-millisecond.
	const projectNotes = engine.getNotes({
		zone: 'projects',
		type: ['index', 'project'],
		limit: 500,
	});

	// Build a fast slug → metadata map. We need this for both strategies
	// AND for resolving the lexical search hits back to slugs.
	const bySlug = new Map<string, { slug: string; title: string; parentProject: string | null; snippet?: string }>();
	for (const r of projectNotes) {
		const slugFromPath = extractSlugFromIndexPath(r.path);
		if (!slugFromPath) continue;
		if (bySlug.has(slugFromPath)) continue; // first match wins per slug
		const full = engine.getNote(r.path);
		const parent = full?.meta?.parent_project;
		const parentSlug = typeof parent === 'string' ? parseWikilinkSlug(parent) : null;
		bySlug.set(slugFromPath, {
			slug: slugFromPath,
			title: r.title || slugFromPath,
			parentProject: parentSlug,
			snippet: (full?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) || undefined,
		});
	}

	// ── Strategy 1: lexical ──────────────────────────────────────
	const matches: SimilarityMatch[] = [];

	// 1a. Slug-exact match — the strongest signal.
	const exact = bySlug.get(slug);
	if (exact) {
		matches.push({ ...exact, reason: 'slug-exact', score: 1 });
	}

	// 1b. Slug-substring match (proposed contains an existing slug OR
	// vice versa) — catches `soul-hub-x` proposed when `soul-hub` exists.
	for (const [existingSlug, meta] of bySlug) {
		if (existingSlug === slug) continue; // already handled above
		const proposedContainsExisting = slug.includes(existingSlug) && existingSlug.length >= 4;
		const existingContainsProposed = existingSlug.includes(slug) && slug.length >= 4;
		if (proposedContainsExisting || existingContainsProposed) {
			const longer = Math.max(slug.length, existingSlug.length);
			const shorter = Math.min(slug.length, existingSlug.length);
			matches.push({
				...meta,
				reason: 'slug-substring',
				score: shorter / longer, // 0-1, higher when slugs are close in length
			});
		}
	}

	// 1c. MiniSearch lexical scan. Query is slug-as-words only — the
	// description goes to the semantic strategy, not lexical (description
	// tokens add too much noise; the operator's intent for the lexical
	// strand is "does this NAME look like an existing project"). Raw
	// MiniSearch scores are used directly with an empirical threshold;
	// relative normalization was tried and over-promoted noise.
	const seen = new Set(matches.map((m) => m.slug));
	const slugTokens = slug.replace(/-/g, ' ').trim();
	let topRawScore = 0;
	let lexicalStrongRaw = false;

	if (slugTokens) {
		const hits = engine.getNotes({
			q: slugTokens,
			zone: 'projects',
			type: ['index', 'project'],
			limit: limit * 3, // over-fetch so dedup leaves headroom
		});
		topRawScore = hits.length > 0 ? hits[0].score : 0;
		for (const h of hits) {
			if (h.score < LEXICAL_MIN_RAW) break; // hits are score-desc; stop at floor
			const candidate = extractSlugFromIndexPath(h.path);
			if (!candidate || seen.has(candidate)) continue;
			const meta = bySlug.get(candidate);
			if (!meta) continue;
			if (h.score >= LEXICAL_STRONG_RAW) lexicalStrongRaw = true;
			// Normalize to 0-1 within the response for UI ordering; the raw
			// gate above already filtered out noise.
			const normalized = topRawScore > 0 ? h.score / topRawScore : 0;
			matches.push({ ...meta, reason: 'lexical', score: normalized });
			seen.add(candidate);
			if (matches.length >= limit) break;
		}
	}

	const lexicalHits = matches.length;

	// ── Strategy 2: semantic fallback ────────────────────────────
	// Fires when there's no STRONG signal (slug-* match OR a lexical hit
	// above the strong raw-score threshold). Skipped silently when
	// `GEMINI_API_KEY` isn't set or the catalog is empty.
	let semanticCheck: SemanticVerdict | null = null;
	let semanticReason: string | undefined;

	const hasStrongSignal =
		matches.some((m) => m.reason === 'slug-exact' || m.reason === 'slug-substring') ||
		lexicalStrongRaw;
	const shouldSemantic =
		!hasStrongSignal && !opts.skipSemantic && gemini.available() && projectNotes.length > 0;

	if (shouldSemantic) {
		const result = await runSemanticCheck(proposed, bySlug, opts.semanticModel);
		semanticCheck = result.verdict;
		semanticReason = result.reason;
		// When semantic flags a duplicate/related, surface the named match(es)
		// so the UI can show "this looks like [[foo]]" instead of just a verdict.
		for (const slug of result.namedSlugs) {
			const meta = bySlug.get(slug);
			if (!meta || seen.has(slug)) continue;
			matches.push({ ...meta, reason: 'semantic', score: 0.7 });
			seen.add(slug);
		}
	}

	// ── Aggregate confidence ─────────────────────────────────────
	let confidence: SimilarityResult['confidence'] = 'low';
	if (matches.some((m) => m.reason === 'slug-exact') || semanticCheck === 'duplicate') {
		confidence = 'high';
	} else if (
		matches.some((m) => m.reason === 'slug-substring') ||
		matches.some((m) => m.reason === 'lexical' && m.score >= 0.6) ||
		semanticCheck === 'related'
	) {
		confidence = 'medium';
	}

	// Sort by score desc, then by reason priority.
	matches.sort((a, b) => {
		const priority = (r: SimilarityMatch['reason']) =>
			r === 'slug-exact' ? 0 : r === 'slug-substring' ? 1 : r === 'lexical' ? 2 : 3;
		const p = priority(a.reason) - priority(b.reason);
		if (p !== 0) return p;
		return b.score - a.score;
	});

	return {
		proposedSlug: slug,
		matches: matches.slice(0, limit),
		lexicalHits,
		semanticCheck,
		semanticReason,
		confidence,
	};
}

/** A project index lives at `projects/<slug>/index.md`. Returns null
 *  when the path doesn't match that shape. */
function extractSlugFromIndexPath(path: string): string | null {
	const m = /^projects\/([^/]+)\/index\.md$/.exec(path);
	return m ? m[1] : null;
}

/** Pull the target slug from a wikilink string. Accepts the same forms
 *  as the projects API's `parseParentSlug`, including the path-to-index
 *  form `[[../soul-hub/index|soul-hub]]`. */
function parseWikilinkSlug(raw: string): string | null {
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(raw.trim());
	if (!m) return null;
	const target = m[1].trim();
	const segs = target.split('/').filter(Boolean);
	while (segs.length > 1 && /^index(\.md)?$/i.test(segs[segs.length - 1])) {
		segs.pop();
	}
	const lastSeg = segs[segs.length - 1] ?? target;
	return lastSeg.replace(/\.md$/i, '') || null;
}

/** Gemini Flash one-shot. Returns a coarse verdict plus any project
 *  slugs the model thinks are duplicates/related. Errors are swallowed
 *  and reported as `verdict: 'error'`. */
async function runSemanticCheck(
	proposed: SimilarityInput,
	bySlug: Map<string, { slug: string; title: string; parentProject: string | null; snippet?: string }>,
	model: string | undefined,
): Promise<{ verdict: SemanticVerdict; reason: string; namedSlugs: string[] }> {
	const projectList = [...bySlug.values()]
		.slice(0, 60)
		.map((p) => `- ${p.slug}${p.title && p.title !== p.slug ? ` — ${p.title}` : ''}`)
		.join('\n');

	const prompt = `You are reviewing a proposed new project slug against an existing project catalog. Decide if the proposed project is a duplicate of an existing one, related to one, or novel.

Proposed project:
- slug: ${proposed.slug}
- title: ${proposed.title ?? '(none)'}
- description: ${proposed.description ?? '(none)'}

Existing projects:
${projectList || '(catalog empty)'}

Respond ONLY with strict JSON in this shape:
{"verdict": "duplicate" | "related" | "novel", "reason": "<one short sentence>", "named_slugs": ["<slug>", ...]}

Rules:
- "duplicate" = same scope, same problem
- "related" = sibling or near-overlapping
- "novel" = no meaningful overlap
- named_slugs lists the existing slugs the verdict refers to (empty for novel)`;

	try {
		const out = await gemini.generate({
			messages: [{ role: 'user', content: prompt }],
			model,
			// gemini-2.5-flash uses "thinking" tokens before the final
			// response; the JSON itself is ~80 output tokens, but the
			// thinking budget pushes total much higher. 2000 has headroom
			// without significant cost (~$0.0005 per call).
			maxOutputTokens: 2000,
		});
		// Robust JSON extraction: Gemini sometimes wraps in code fences,
		// adds prose, or both. Find the first balanced `{ … }` and parse it.
		const text = out.text;
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start === -1 || end === -1 || end <= start) {
			return { verdict: 'error', reason: `Gemini returned non-JSON: ${text.slice(0, 80)}`, namedSlugs: [] };
		}
		const slice = text.slice(start, end + 1);
		const parsed = JSON.parse(slice) as {
			verdict?: string;
			reason?: string;
			named_slugs?: unknown;
		};
		const verdict: SemanticVerdict =
			parsed.verdict === 'duplicate' || parsed.verdict === 'related' || parsed.verdict === 'novel'
				? parsed.verdict
				: 'novel';
		const namedSlugs = Array.isArray(parsed.named_slugs)
			? (parsed.named_slugs.filter((x) => typeof x === 'string') as string[]).filter((s) =>
					bySlug.has(s),
				)
			: [];
		return {
			verdict,
			reason: typeof parsed.reason === 'string' ? parsed.reason : '',
			namedSlugs,
		};
	} catch (err) {
		return {
			verdict: 'error',
			reason: err instanceof Error ? err.message : 'Gemini call failed',
			namedSlugs: [],
		};
	}
}
