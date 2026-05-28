/**
 * ADR-014 — Assembly-time toolset gating + dynamic discovery registry.
 *
 * Tier 1: `ToolsetName` type + per-tool membership (in manifest.ts).
 * Tier 2: `selectToolsets` + `applyGatingFilter` — pure, unit-tested.
 * Tier 3: `requestToolsetExpansion` / `getSessionExpansions` — session
 *          registry that lets the `enableToolset` meta-tool self-heal
 *          under-selected turns (the model calls `enableToolset`, state
 *          is written here, and the NEXT turn's `buildOrchestratorTools`
 *          call picks it up via `GatingContext.conversationKey`).
 *
 * Design principles:
 *  - selectToolsets is PURE: same ctx → same result; no in-memory reads.
 *    Callers compose it with `getSessionExpansions` before calling (so
 *    tests can control session state without global setup).
 *  - applyGatingFilter operates on a COPY of the tools dictionary and
 *    never mutates the original. parity assertion must run on the full
 *    set BEFORE this is called.
 *  - WEB_ONLY_TOOLS is the single, authoritative channel hard-filter.
 *    Any execute()-time channel check on these tools is defence-in-depth
 *    only; the tools should never be assembled off-web in the first place.
 */

import { TOOL_MANIFESTS } from './manifest.js';
import type { ToolsetName } from './manifest.js';

export type { ToolsetName };

// ─── Channel hard-filter ──────────────────────────────────────────────────────

/**
 * Tools that MUST NOT be assembled when channel !== 'web'.
 * Covers:
 *  - navigation toolset items that require a live browser (navigateTo,
 *    describeCurrentPage) — listPages is all-channel so NOT included.
 *  - project-adr write tools that modify vault state and are gated by
 *    the web confirmation UX (adrAccept/Ship/Park/Reject).
 *  - vault write tool that is link-safe but destructive without inline
 *    preview (vaultNoteMove).
 */
export const WEB_ONLY_TOOLS = new Set([
	'navigateTo',
	'describeCurrentPage',
	'adrAccept',
	'adrShip',
	'adrPark',
	'adrReject',
	'vaultNoteMove',
]);

// ─── Toolset descriptions (for listToolsets tool) ─────────────────────────────

export const TOOLSET_DESCRIPTIONS: Record<ToolsetName, string> = {
	core: 'Always loaded. Reply, vault search, web search, agent dispatch, system health, page list.',
	vault: 'Vault note operations: read, save, update, move notes. Loaded for vault/project scopes.',
	'project-adr': 'Project + ADR lifecycle: list, get, propose, ship, accept, reject. Loaded for project scope.',
	inbox: 'Inbox email operations: list, read, drill down, extract, mark processed. Loaded for inbox scope.',
	crm: 'CRM contact management: find, add, log interactions, stages, follow-ups. Loaded for CRM scope.',
	'external-fetch': 'Fetch external content: web pages, YouTube videos, TikTok videos. Loaded when a URL is present.',
	navigation: 'Browser navigation (web-only): navigate to pages, describe current page.',
	actions: 'Side-effect actions: generate images, schedule reminders, invoke skills.',
};

// ─── Gating context ───────────────────────────────────────────────────────────

export interface GatingContext {
	/** Chat channel for this turn. Drives channel hard-filters. */
	channel?: 'whatsapp' | 'telegram' | 'web';
	/** Current page scope kind from the web chat provider (ADR-002/006). */
	scopeKind?: string;
	/** User's message text — scanned with cheap keyword regexes (Tier 2). */
	userMessage?: string;
	/** Conversation key for session-expansion lookups (Tier 3). */
	conversationKey?: string;
}

// ─── Toolset selection (pure, Tier 2 + Tier 3) ────────────────────────────────

/**
 * ADR-014 Tier 2 + Tier 3 — pure toolset selector.
 *
 * Returns the set of toolset names that should be exposed for a given context.
 * Always includes 'core'. Does NOT read the session expansion registry —
 * callers must merge `getSessionExpansions(conversationKey)` themselves so
 * this function remains pure and unit-testable without global state.
 *
 * Priority order (additive, not exclusive):
 *  1. core always
 *  2. channel hard-filter (web adds navigation + project-adr writes)
 *  3. undefined channel → include all (REPL / test / legacy callers)
 *  4. scope default (project / crm-contact / inbox-thread / vault-note)
 *  5. keyword-intent regex scan of userMessage
 */
export function selectToolsets(ctx: Omit<GatingContext, 'conversationKey'>): Set<ToolsetName> {
	const enabled = new Set<ToolsetName>(['core']);

	// Undefined channel = REPL / test / legacy caller — include everything for
	// backwards compat. New callers always set `channel`.
	if (!ctx.channel) {
		return new Set<ToolsetName>([
			'core',
			'vault',
			'project-adr',
			'inbox',
			'crm',
			'external-fetch',
			'navigation',
			'actions',
		]);
	}

	// Channel: navigation is web-only (navigateTo + describeCurrentPage).
	// listPages lives in navigation but is all-channel; WEB_ONLY_TOOLS handles it.
	if (ctx.channel === 'web') {
		enabled.add('navigation');
		// project-adr includes adrAccept/Ship/Park/Reject which are web-only writes.
		// On web, expose the full toolset; WEB_ONLY_TOOLS doesn't filter on web.
		enabled.add('project-adr');
	}

	// Scope defaults (ADR-014 §Tier 2).
	if (ctx.scopeKind === 'project') {
		enabled.add('project-adr');
		enabled.add('vault');
	} else if (ctx.scopeKind === 'crm-contact') {
		enabled.add('crm');
		enabled.add('vault');
	} else if (ctx.scopeKind === 'inbox-thread') {
		enabled.add('inbox');
	} else if (ctx.scopeKind === 'vault-note') {
		enabled.add('vault');
	}

	// Keyword-intent expansion (ADR-014 §S4 — cheap regex over userMessage).
	if (ctx.userMessage) {
		const msg = ctx.userMessage.toLowerCase();

		// CRM: contact/lead/deal/pipeline keywords
		if (/\b(contact|lead|crm|deal|pipeline|stage|follow[\s-]?up|prospect)\b/.test(msg)) {
			enabled.add('crm');
		}

		// External fetch: URLs and video platform hostnames
		if (/https?:\/\/|youtu\.be\/|youtube\.com|tiktok\.com/.test(msg)) {
			enabled.add('external-fetch');
		}

		// Fetch: explicit "fetch" or "article" / "page" / "link" vocabulary
		if (/\b(fetch|article|web\s?page|read\s+this|open\s+link|summarize\s+this)\b/.test(msg)) {
			enabled.add('external-fetch');
		}

		// Actions: reminders, image generation, skill invocations
		if (/\b(remind|reminder|schedule|ping me|set\s+alarm)\b/.test(msg)) {
			enabled.add('actions');
		}
		if (/\b(image|picture|photo|generate\s+\w*\s*image|draw|illustrate)\b/.test(msg)) {
			enabled.add('actions');
		}
		if (/\b(arabic|research|recipe|draft|skill)\b/.test(msg)) {
			enabled.add('actions');
		}

		// Inbox: email/inbox/message references
		if (/\b(inbox|email|msg\s+\d|message\s+\d|\bmail\b|new\s+emails?|bank\s+alert|receipt)\b/.test(msg)) {
			enabled.add('inbox');
		}

		// Vault: save/note/remember/search patterns
		if (/\b(save\s+(this|it)|remember|capture|write\s+down|store\s+this)\b/.test(msg)) {
			enabled.add('vault');
		}

		// Project/ADR: project or decision vocabulary
		if (/\b(project|adr|decision|architecture)\b/.test(msg)) {
			enabled.add('project-adr');
			enabled.add('vault');
		}
	}

	return enabled;
}

// ─── Gating filter (Tier 2 application) ──────────────────────────────────────

/**
 * ADR-014 Tier 2 — filter a tools dictionary by the active toolsets.
 *
 * CONTRACT: `assertManifestParity` MUST have been called on `allTools`
 * BEFORE this function. Gating operates on the full set, then filters.
 *
 * Returns a new object containing only the tools whose manifest toolset
 * is in `enabled`, minus any WEB_ONLY_TOOLS when channel !== 'web'.
 */
export function applyGatingFilter<T extends Record<string, unknown>>(
	allTools: T,
	enabled: ReadonlySet<ToolsetName>,
	channel?: 'whatsapp' | 'telegram' | 'web',
): Partial<T> {
	const toolsetMap = getToolsetMap();
	const filtered = {} as Partial<T>;

	for (const [name, toolObj] of Object.entries(allTools)) {
		const toolset = toolsetMap.get(name);

		// Unknown toolset (not in manifest / newly added) → include to avoid
		// silently dropping tools. A parity warning will surface in logs.
		if (!toolset) {
			(filtered as Record<string, unknown>)[name] = toolObj;
			continue;
		}

		// Skip if the toolset is not in the enabled set.
		if (!enabled.has(toolset)) continue;

		// Channel hard-filter: WEB_ONLY_TOOLS never assembled off web.
		if (WEB_ONLY_TOOLS.has(name) && channel !== 'web') continue;

		(filtered as Record<string, unknown>)[name] = toolObj;
	}

	return filtered;
}

// ─── Toolset map (cached, built from manifest) ───────────────────────────────

let _toolsetMap: ReadonlyMap<string, ToolsetName> | undefined;

/**
 * Returns a stable name→toolset map derived from TOOL_MANIFESTS.
 * Memoized after the first call; safe to call on every turn.
 */
export function getToolsetMap(): ReadonlyMap<string, ToolsetName> {
	if (_toolsetMap) return _toolsetMap;
	const m = new Map<string, ToolsetName>();
	for (const entry of TOOL_MANIFESTS) {
		if (entry.toolset) m.set(entry.name, entry.toolset);
	}
	_toolsetMap = m;
	return _toolsetMap;
}

// ─── Session expansion registry (Tier 3 — enableToolset state) ───────────────

/**
 * In-memory session expansion registry. Keyed by conversationKey.
 * The `enableToolset` tool writes here; `buildOrchestratorTools` reads
 * it on the NEXT turn for the same conversation.
 *
 * Restart-loss is acceptable — sessions naturally resume without prior
 * expansions, and the model can re-call enableToolset if needed.
 */
const _sessionExpansions = new Map<string, Set<ToolsetName>>();

/**
 * Record that a given toolset should be added to future turns of this
 * conversation. Called by the `enableToolset` tool's execute().
 */
export function requestToolsetExpansion(conversationKey: string, toolset: ToolsetName): void {
	if (!_sessionExpansions.has(conversationKey)) {
		_sessionExpansions.set(conversationKey, new Set<ToolsetName>());
	}
	_sessionExpansions.get(conversationKey)!.add(toolset);
}

/**
 * Returns the set of toolsets that were requested for expansion in prior
 * turns of this conversation. Empty set when no expansions or unknown key.
 */
export function getSessionExpansions(conversationKey: string): ReadonlySet<ToolsetName> {
	return _sessionExpansions.get(conversationKey) ?? new Set<ToolsetName>();
}

/**
 * Clear all session expansions for a conversation (for testing / reset).
 */
export function clearSessionExpansions(conversationKey: string): void {
	_sessionExpansions.delete(conversationKey);
}

// ─── Coverage assertion ───────────────────────────────────────────────────────

/**
 * ADR-014 S1 — assert that every manifest entry has a toolset assignment.
 * Warn-only (mirrors assertManifestParity's trust model: developer notices
 * and fixes the gap without breaking dispatch). Called alongside
 * assertManifestParity in buildOrchestratorTools.
 */
export function assertToolsetCoverage(): void {
	const untagged = TOOL_MANIFESTS.filter((m) => !m.toolset);
	if (untagged.length > 0) {
		console.warn(
			`[orchestrator-v2] toolset coverage gap: ${untagged.length} tool(s) have no toolset assignment: ${untagged.map((m) => m.name).join(', ')}`,
		);
	}
}
