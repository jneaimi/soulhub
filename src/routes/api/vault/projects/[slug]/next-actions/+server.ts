/** GET /api/vault/projects/:slug/next-actions[?shipped_limit=N]
 *
 *  AI-facing surface for "what's open" / "what should we do next". Per
 *  project-phases ADR-013 (2026-05-18), this endpoint ranks ADRs directly
 *  rather than the parsed roadmap-table phases — slug uniqueness (enforced
 *  by ADR-046 createNote chokepoint) replaces the brittle ordinal-based
 *  key that crashed Svelte hydration via `each_key_duplicate`.
 *
 *  Returns:
 *    - open[]:           proposed + accepted ADRs, non-blocked first,
 *                        sorted by (statusRank, created ASC).
 *    - blocked[]:        proposed + accepted ADRs with at least one
 *                        blocked_by dep slug not yet in the shipped set.
 *                        Cross-project deps are treated as unmet.
 *    - recent_shipped[]: last N shipped ADRs by shipped_on DESC, then
 *                        slug DESC as deterministic tie-break.
 *    - next:             open[0] ?? blocked[0] ?? null — the single
 *                        "do this next" hint. Blocked falls through when
 *                        EVERYTHING is blocked so the widget still gives
 *                        signal rather than going silent.
 *    - hint:             "no_adrs" when the project has zero decision
 *                        notes (fresh project), else null. Lets the UI
 *                        render the "propose your first ADR" nudge from
 *                        ADR-013 Consequences §Negative.
 *
 *  Skips parked / rejected / superseded. Pure read transform over
 *  engine.getNotes(); no explicit cache (engine results refresh on
 *  watcher re-index). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import type { VaultMeta } from '$lib/vault/types.js';

interface NextActionItem {
	/** ADR vault path, e.g. "projects/naseej/adr-013-foo.md". */
	id: string;
	/** ADR slug (filename without .md), e.g. "adr-013-foo". */
	slug: string;
	/** ADR title — frontmatter `title` if present, else first H1, else slug. */
	label: string;
	/** Canonical ADR status — proposed | accepted | shipped. */
	status: string;
	created: string | null;
	accepted_on: string | null;
	shipped_on: string | null;
	target_date: string | null;
	falsifier_date: string | null;
	/** First sentence of body (markdown stripped) for one-line context.
	 *  Capped at ~120 chars. Null when body is empty. */
	scope: string | null;
	/** Distinguishes ADR-level rows from the legacy phase-level shape.
	 *  Page renderer keys off this for label formatting. */
	source: 'adr';
}

interface NextActionsResponse {
	project: string;
	generated_at: string;
	open: NextActionItem[];
	blocked: NextActionItem[];
	recent_shipped: NextActionItem[];
	next: NextActionItem | null;
	hint: 'no_adrs' | null;
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

/** Parse a `blocked_by` value (wikilink or bare slug) down to a comparable
 *  slug. `[[adr-001-foo|alias]]` → `adr-001-foo`. `adr-002` → `adr-002`.
 *  Cross-project refs (`[[../other/adr-X]]`) return the last segment. */
function blockedByToSlug(raw: string): string | null {
	const trimmed = raw.trim();
	const wiki = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
	const target = wiki ? wiki[1].trim() : trimmed;
	const last = target.split('/').pop() ?? target;
	return last.replace(/\.md$/i, '') || null;
}

/** ADR-002 S3 — parse and clamp the optional `?shipped_limit=N` query param.
 *  Bounded [1, 50]; falls back to default (10) on missing / non-numeric /
 *  out-of-range input. */
const DEFAULT_SHIPPED_LIMIT = 10;
const MAX_SHIPPED_LIMIT = 50;

function parseShippedLimit(raw: string | null): number {
	if (!raw) return DEFAULT_SHIPPED_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_SHIPPED_LIMIT;
	return Math.min(n, MAX_SHIPPED_LIMIT);
}

/** Extract an ADR title — frontmatter `title` if a non-empty string, else
 *  the first `# ` heading in the body, else the slug as a last resort. */
function extractTitle(meta: VaultMeta, body: string, slug: string): string {
	const t = meta.title;
	if (typeof t === 'string' && t.trim().length > 0) return t.trim();
	const h1 = /^#\s+(.+?)\s*$/m.exec(body);
	if (h1) return h1[1].trim();
	return slug;
}

/** Extract a one-line scope hint — first non-empty paragraph after any
 *  H1, with light markdown stripping. Capped at 120 chars. Null when the
 *  body has no extractable prose. */
function extractScope(body: string): string | null {
	const afterH1 = body.replace(/^---[\s\S]*?---\s*/, '').replace(/^#\s+.+?\n+/m, '');
	const firstPara = afterH1.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0);
	if (!firstPara) return null;
	const stripped = firstPara
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, _a, b) => (b ?? _a))
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	if (!stripped) return null;
	return stripped.length > 120 ? stripped.slice(0, 117) + '…' : stripped;
}

function asStr(v: unknown): string | null {
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export const GET: RequestHandler = async ({ params, url }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const shippedLimit = parseShippedLimit(url.searchParams.get('shipped_limit'));

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const notes = engine
		.getNotes({ project: slug, limit: 500 })
		.filter((n) => !n.path.startsWith('archive/'));

	// Build ADR items + blocked-by index in one pass. shippedAdrSlugs is the
	// satisfaction set for the blocked filter.
	const items: NextActionItem[] = [];
	const shippedAdrSlugs = new Set<string>();
	const blockedByPerPath = new Map<string, string[]>();

	for (const note of notes) {
		const full = engine.getNote(note.path);
		if (!full) continue;
		if (full.meta.type !== 'decision') continue;

		const adrSlug = note.path.split('/').pop()?.replace(/\.md$/i, '') ?? note.path;
		const status = String(full.meta.status ?? '').toLowerCase();

		if (status === 'shipped') shippedAdrSlugs.add(adrSlug);

		const blockedBy = asStringArray(full.meta.blocked_by ?? full.meta.blockedBy);
		if (blockedBy.length > 0) blockedByPerPath.set(note.path, blockedBy);

		items.push({
			id: note.path,
			slug: adrSlug,
			label: extractTitle(full.meta, full.content, adrSlug),
			status,
			created: asStr(full.meta.created),
			accepted_on: asStr(full.meta.accepted_on),
			shipped_on: asStr(full.meta.shipped_on),
			target_date: asStr(full.meta.target_date),
			falsifier_date: asStr(full.meta.falsifier_date),
			scope: extractScope(full.content),
			source: 'adr',
		});
	}

	const isBlocked = (path: string): boolean => {
		const deps = blockedByPerPath.get(path);
		if (!deps || deps.length === 0) return false;
		// Blocked if ANY dep slug is not in this project's shipped set.
		// Cross-project deps (slugs not in this project) are conservatively
		// treated as unshipped — operator can resolve manually.
		return deps.some((dep) => {
			const depSlug = blockedByToSlug(dep);
			return depSlug ? !shippedAdrSlugs.has(depSlug) : false;
		});
	};

	const isOpen = (s: string) => s === 'proposed' || s === 'accepted';
	const statusRank = (s: string) => (s === 'proposed' ? 0 : s === 'accepted' ? 1 : 2);

	const open: NextActionItem[] = [];
	const blocked: NextActionItem[] = [];
	const shipped: NextActionItem[] = [];

	for (const item of items) {
		if (item.status === 'shipped') {
			if (item.shipped_on) shipped.push(item);
			continue;
		}
		if (!isOpen(item.status)) continue; // skip parked / rejected / superseded
		if (isBlocked(item.id)) blocked.push(item);
		else open.push(item);
	}

	// open[] + blocked[] — sort by (statusRank, created ASC, slug ASC).
	// Per ADR-013 §1. Slug is the deterministic tiebreak so two runs return
	// the same order when several ADRs share a created date.
	const sortOpen = (a: NextActionItem, b: NextActionItem) => {
		const r = statusRank(a.status) - statusRank(b.status);
		if (r !== 0) return r;
		const c = (a.created ?? '').localeCompare(b.created ?? '');
		if (c !== 0) return c;
		return a.slug.localeCompare(b.slug);
	};
	open.sort(sortOpen);
	blocked.sort(sortOpen);

	// recent_shipped — desc by shipped_on, then slug desc as tie-break
	// (mirrors the prior phase-level ordering rationale from ADR-002 S3:
	// projects shipping multiple ADRs same-day get a deterministic order).
	shipped.sort((a, b) => {
		const dateCmp = (b.shipped_on ?? '').localeCompare(a.shipped_on ?? '');
		if (dateCmp !== 0) return dateCmp;
		return b.slug.localeCompare(a.slug);
	});
	const recentShipped = shipped.slice(0, shippedLimit);

	// `next` falls through to blocked when nothing is unblocked — keeps the
	// widget useful instead of silent when every open ADR is gated.
	const next = open[0] ?? blocked[0] ?? null;

	// Empty-state hint: zero decision notes under the project. ADR-013
	// Consequences §Negative mitigation — the UI renders the nudge to
	// propose the first ADR.
	const hint: 'no_adrs' | null = items.length === 0 ? 'no_adrs' : null;

	const response: NextActionsResponse = {
		project: slug,
		generated_at: new Date().toISOString(),
		open,
		blocked,
		recent_shipped: recentShipped,
		next,
		hint,
	};

	return json(response);
};
