/**
 * vaultSave — thin wrapper around `engine.createNote()` for the
 * orchestrator-v2 `vaultSave` tool (ADR-013).
 *
 * Differs from `src/lib/vault-actions/save.ts` (which is the WhatsApp `/save`
 * slash-command handler): this module takes already-synthesized fields
 * from the orchestrator LLM (title, content, type, tags, sourceUrl) and
 * writes a vault note. No multimodal extraction, no envelope coupling,
 * no Gemini call. The LLM has done the synthesis upstream — this just
 * persists it.
 *
 * Always writes to `inbox/` so the user curates later. Filename is
 * `YYYY-MM-DD-${slug}.md` matching vault-actions/save.ts conventions so the
 * vault watcher and graph treat them uniformly.
 */

import { getVaultEngine } from '../vault/index.js';

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
const AGENT = 'orchestrator-v2-vaultSave';
const INBOX_ZONE = 'inbox';

/** Recipe-host domains. Hits any of these → route to `knowledge/cooking/recipes/`. */
const RECIPE_DOMAINS = /\b(allrecipes\.com|foodnetwork\.com|epicurious\.com|cookpad\.com|seriouseats\.com|tasty\.co|nytimes\.com\/recipes|bonappetit\.com|delish\.com|simplyrecipes\.com|food\.com|bbcgoodfood\.com|smitten[a-z]*\.com)\b/i;

/** Heuristic: the content reads like a recipe. Looks for the structural
 *  markers (ingredients list, instructions block) that appear in nearly
 *  every recipe regardless of source. */
function looksLikeRecipe(title: string, content: string): boolean {
	const t = String(title || '').toLowerCase();
	if (/\brecipe\b/.test(t)) return true;
	const c = String(content || '').toLowerCase();
	const hits = [
		/\bingredients?:/,
		/\binstructions?:/,
		/\bdirections?:/,
		/\bpreheat\b/,
		/\b(tablespoons?|teaspoons?|cup of|cups of|grams? of|kg of)\b/,
		/\bmins? at \d+/,
	].filter(re => re.test(c)).length;
	return hits >= 2;
}

/** Heuristic: a meeting recap. Used to route project work to projects/<x>/. */
function looksLikeMeetingRecap(title: string, content: string): boolean {
	const t = String(title || '').toLowerCase();
	if (/\b(meeting|recap|sync|standup|review|kickoff)\b/.test(t)) return true;
	const c = String(content || '').toLowerCase();
	return /\b(attendees:|agenda:|action items:|next steps:)/m.test(c);
}

/** Match a project name from the title/tags against `~/vault/projects/<x>/`.
 *  Returns the project slug when it's a high-confidence match, else null.
 *  Keeps the project-zone routing conservative — never invents a new project
 *  folder, only routes to ones that already exist. */
function detectExistingProject(title: string, tags: string[], knownProjects: string[]): string | null {
	const safeTags = (tags || []).filter((t): t is string => typeof t === 'string');
	const hay = (String(title || '') + ' ' + safeTags.join(' ')).toLowerCase();
	for (const slug of knownProjects) {
		const re = new RegExp(`\\b${slug.replace(/-/g, '[- ]?')}\\b`, 'i');
		if (re.test(hay)) return slug;
	}
	return null;
}

/** Classify the right vault zone for an incoming save. Priority:
 *
 *    1. Explicit `input.zone` — caller knows best.
 *    2. `input.sourceAgent` heuristic — `daily-focus` reports always go to
 *       `operations/daily-focus/`, etc.
 *    3. `input.sourceUrl` domain — YouTube → research; recipe sites → cooking.
 *    4. `input.type` — `recipe` → cooking, `decision`/`adr` → projects/<x>/decisions.
 *    5. Content heuristics — recipe markers, meeting-recap markers.
 *    6. Fallback — `inbox` (the lax governance zone).
 *
 *  Pure function. No filesystem access. Called by dispatchVaultSave AND by
 *  the keeper's misplacement detector — same logic, same output, no drift.
 *  Exported so the hygiene module can re-use it. */
export function classifyZone(input: VaultSaveInput, opts?: { knownProjects?: string[] }): string {
	// (1) Explicit zone — caller knows best.
	if (input.zone) return input.zone;

	// (2) source_agent → operations destination
	if (input.sourceAgent === 'daily-focus') {
		const yyyymm = new Date().toISOString().slice(0, 7);
		return `operations/daily-focus/${yyyymm}`;
	}
	if (input.sourceAgent === 'project-hygiene') {
		const yyyymm = new Date().toISOString().slice(0, 7);
		return `operations/hygiene/${yyyymm}`;
	}

	// (3) source URL → topic zone
	const url = (input.sourceUrl || '').toLowerCase();
	if (/youtube\.com|youtu\.be|vimeo\.com/.test(url)) return 'knowledge/research';
	if (RECIPE_DOMAINS.test(url)) return 'knowledge/cooking/recipes';

	// (4) Explicit type
	if (input.type === ('recipe' as VaultSaveType)) return 'knowledge/cooking/recipes';

	// Tag hints (defensive: tags array may contain non-strings from older
	// frontmatter — coerce + filter).
	const tags = (input.tags || [])
		.filter((t): t is string => typeof t === 'string')
		.map(t => t.toLowerCase());
	if (tags.includes('recipe') || tags.includes('cooking')) return 'knowledge/cooking/recipes';

	// (5) Content heuristics
	if (looksLikeRecipe(input.title, input.content)) return 'knowledge/cooking/recipes';

	// Meeting recap → existing project folder if we can match one, else inbox
	if (looksLikeMeetingRecap(input.title, input.content)) {
		const project = detectExistingProject(input.title, input.tags || [], opts?.knownProjects || []);
		if (project) return `projects/${project}/meetings`;
	}

	// (6) Fallback — inbox is the operator's triage queue
	return INBOX_ZONE;
}

/** Read the list of project slugs from `~/vault/projects/<slug>/`. Lazy +
 *  in-process cached for the duration of the worker — invalidated when the
 *  vault watcher notices a new project folder. The cache keeps the
 *  per-save cost at one fs.readdir per process boot. */
let _knownProjectsCache: string[] | null = null;
export function getKnownProjects(): string[] {
	if (_knownProjectsCache) return _knownProjectsCache;
	const engine = getVaultEngine();
	if (!engine) return [];
	try {
		const projectsDir = `${engine.vaultDir}/projects`;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { readdirSync } = require('node:fs');
		const entries = readdirSync(projectsDir, { withFileTypes: true });
		_knownProjectsCache = entries
			.filter((e: { isDirectory: () => boolean; name: string }) => e.isDirectory() && !e.name.startsWith('.'))
			.map((e: { name: string }) => e.name);
		return _knownProjectsCache ?? [];
	} catch {
		_knownProjectsCache = [];
		return [];
	}
}
/** Invalidate the projects cache. Called when the vault watcher sees a
 *  new directory under projects/. */
export function invalidateKnownProjectsCache(): void {
	_knownProjectsCache = null;
}

export type VaultSaveType = 'draft' | 'reference' | 'learning' | 'idea';

export interface VaultSaveInput {
	title: string;
	content: string;
	/** Note type. `idea` maps to `draft + tag:idea` because the inbox zone's
	 *  governance allowlist doesn't include `idea` as a type — same trick
	 *  vault-actions/save.ts uses for the `idea: foo` prefix. */
	type?: VaultSaveType;
	tags?: string[];
	/** When the saved content was derived from a URL (e.g., YouTube), pass
	 *  it here — lands in `meta.source` for back-tracking. */
	sourceUrl?: string;
	/** Channel that triggered the save — added as a tag for filterability.
	 *  Optional because non-channel callers (debug, tests) shouldn't have
	 *  to fake it. */
	channel?: 'whatsapp' | 'telegram' | 'web';
	/** Override the default `orchestrator-v2-vaultSave` agent identity.
	 *  Used by background workers (e.g., L3 S4 auto-route) so their writes
	 *  don't compete with chat-driven saves on the same per-agent rate
	 *  limit. Must be a registered identity in the vault engine's
	 *  RATE_LIMIT_OVERRIDES table to get a non-default ceiling. */
	sourceAgent?: string;
	/** Optional suffix appended to the filename stem AFTER the title slug,
	 *  before `.md`. Used by callers that produce same-titled notes from
	 *  distinct sources (e.g., L3 S4 auto-route emits one note per inbox
	 *  message, and bulk inflows of look-alike subjects — 38 Emirates NBD
	 *  transaction alerts in a day — collapse to the same slug). Passing
	 *  `msg-33391` here yields `2026-05-12-<slug>-msg-33391.md`. */
	filenameSuffix?: string;
	/** Override the target zone. Default is `inbox`. Callers can pass nested
	 *  zones (`inbox/finance`, `inbox/security`) to organize their writes
	 *  without forcing a top-level zone reshuffle. Validated by the engine's
	 *  governance allowlist — passing an unknown root zone will fail. */
	zone?: string;
}

export type VaultSaveOutcome =
	| { ok: true; path: string; openUrl: string; title: string }
	| { ok: false; error: string; title: string };

export async function dispatchVaultSave(input: VaultSaveInput): Promise<VaultSaveOutcome> {
	const engine = getVaultEngine();
	if (!engine) {
		return { ok: false, error: 'Vault is not initialized', title: input.title };
	}

	const today = new Date().toISOString().slice(0, 10);

	// `idea` is a tag, not a type — see vault-actions/save.ts:159 for the same
	// inbox-governance dance.
	const requestedType = input.type ?? 'draft';
	const isIdea = requestedType === 'idea';
	const finalType = isIdea ? 'draft' : requestedType;

	const slug = slugify(input.title);
	const suffix = input.filenameSuffix ? `-${slugify(input.filenameSuffix)}` : '';
	const filename = `${today}-${slug}${suffix}.md`;

	const tags = new Set<string>();
	if (isIdea) tags.add('idea');
	if (input.channel) tags.add(input.channel);
	for (const t of input.tags ?? []) {
		const cleaned = t.toLowerCase().replace(/^#/, '').trim();
		if (cleaned) tags.add(cleaned);
	}

	const meta: Record<string, unknown> = {
		title: input.title,
		type: finalType,
		created: today,
		tags: [...tags],
		source_agent: input.sourceAgent ?? AGENT,
	};
	if (input.sourceUrl) meta.source = input.sourceUrl;

	// Smart-route by content type when the caller didn't pin a zone.
	// `classifyZone` falls back to `inbox` when uncertain, preserving
	// today's behavior for ambiguous saves.
	const resolvedZone = classifyZone(input, { knownProjects: getKnownProjects() });

	const result = await engine.createNote({
		zone: resolvedZone,
		filename,
		meta,
		content: input.content.trim(),
	});

	if (!result.success) {
		return { ok: false, error: result.error, title: input.title };
	}

	return {
		ok: true,
		path: result.path,
		openUrl: noteOpenUrl(result.path),
		title: input.title,
	};
}

/** Slug a string into a filesystem-safe filename stem. Mirrors
 *  vault-actions/save.ts:142 so notes from both surfaces sort identically.
 *  Falls back to `note` when normalization strips everything. */
function slugify(input: string): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip combining marks
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const truncated = normalized.slice(0, 60).replace(/-+$/, '');
	return truncated || 'note';
}

function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}
