/**
 * ADR-002 / ADR-006 — ChatScope provider: per-area context for the conversational layer.
 *
 * `resolveScope` is the one public entry point. It is **pure**: all vault I/O
 * is delegated through the injected `ScopeReader` so the function is unit-
 * testable without a live vault engine — mirroring `resolveProjectRepo`'s DI
 * shape (ADR-030).
 *
 * Contributors (registered in match order):
 *   1. `project`      — routes: `/projects/[slug]`, `/projects/[slug]/queue`   (ADR-002 P1)
 *   2. `vault-note`   — route:  `/vault`      with params.notePath              (ADR-006 P3)
 *   3. `inbox-thread` — route:  `/inbox`                                        (ADR-006 P3)
 *   4. `crm-contact`  — route:  `/crm`        with params.contactId             (ADR-006 P3)
 *   5. `global`       — guaranteed non-null fallback for any unrecognised route
 *
 * Invariants:
 *   - Never returns null / undefined.
 *   - Never throws (bad input → global fallback, never a crash).
 *   - `contextPayload` is always non-empty.
 *   - `cwd` is always a non-empty absolute-ish path.
 */

import type { ScopeDescriptor, ScopeReader } from './types.js';
import { resolveProjectRepo } from '../../agents/dispatch/resolve-project-repo.js';
import { resolveVaultNoteScope } from './contributors/vault-note.js';
import { resolveInboxThreadScope } from './contributors/inbox-thread.js';
import { resolveCrmContactScope } from './contributors/crm-contact.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Default CWD for every scope that has no bound repo. */
export const SOUL_HUB_REPO = '~/dev/soul-hub';

/**
 * Decision statuses that are considered "closed" and excluded from the
 * open-decisions list in the project contextPayload.
 */
const CLOSED_STATUSES = new Set(['shipped', 'rejected', 'parked', 'superseded']);

/** Max number of open decisions to include in the contextPayload. */
const MAX_DECISIONS = 6;

/** Max characters of project index content to include in contextPayload. */
const MAX_INDEX_CHARS = 600;

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Build the `contextPayload` for a project scope.
 *
 * Sources:
 *   - `projects/<slug>/index.md` — project description (first 600 chars)
 *   - `listProjectNotes(slug, { type: 'decision' })` — open decisions
 */
function buildProjectContextPayload(slug: string, reader: ScopeReader): string {
	const lines: string[] = [`# Project: ${slug}`];

	// Project description from index.md
	const indexNote = reader.getNote(`projects/${slug}/index.md`);
	if (indexNote?.content?.trim()) {
		const desc = indexNote.content.trim().slice(0, MAX_INDEX_CHARS);
		lines.push('', desc);
	}

	// Open decisions (type:decision, not closed)
	const allDecisions = reader.listProjectNotes(slug, { type: 'decision' });
	const openDecisions = allDecisions.filter((n) => {
		const status = typeof n.meta.status === 'string' ? n.meta.status : '';
		return !CLOSED_STATUSES.has(status);
	});

	if (openDecisions.length > 0) {
		lines.push('', '## Open Decisions');
		for (const d of openDecisions.slice(0, MAX_DECISIONS)) {
			const status =
				typeof d.meta.status === 'string' && d.meta.status
					? ` (${d.meta.status})`
					: '';
			lines.push(`- ${d.title}${status}`);
		}
	}

	return lines.join('\n');
}

/** Build the `contextPayload` for the global scope. */
function buildGlobalContextPayload(): string {
	return [
		'# Soul Hub — Command Center',
		'',
		'You are connected to Soul Hub, an AI-human collaboration command center.',
		'Available areas: projects graph, vault, inbox, CRM, orchestration, sessions, scheduler.',
		`Repo: ${SOUL_HUB_REPO}`,
	].join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * ADR-002 / ADR-006 — Resolve the ChatScope descriptor for the current SvelteKit route.
 *
 * **Pure**: all vault reads are delegated through the injected `reader` so this
 * function has no side-effects and is safe to call in tests with fakes.
 *
 * Contributor registry (match order — first match wins):
 * ```
 * /projects/[slug]        → kind:'project'      (ADR-002 P1)
 * /projects/[slug]/queue  → kind:'project'      (ADR-002 P1)
 * /vault  + notePath      → kind:'vault-note'   (ADR-006 P3)
 * /inbox                  → kind:'inbox-thread' (ADR-006 P3)
 * /crm    + contactId     → kind:'crm-contact'  (ADR-006 P3)
 * <anything else>         → kind:'global'  ← guaranteed non-null fallback
 * ```
 *
 * @param routeId  SvelteKit route ID (e.g. `'/projects/[slug]'`) OR scope kind
 *                 string (e.g. `'project'`) — both forms are accepted so that
 *                 callers can pass either the raw SvelteKit route or the
 *                 client-supplied `scopeKind` directly.
 * @param params   Scope parameters:
 *                   - project:     `{ slug: string }`
 *                   - vault-note:  `{ notePath: string }`
 *                   - crm-contact: `{ contactId: string }`
 *                   - inbox-thread / global: `{}`
 * @param reader   Injected reader — ADR-002 baseline (`getNote`, `listProjectNotes`)
 *                 plus ADR-006 optional extensions (`getVaultNoteBacklinks`,
 *                 `getCrmContact`, `getCrmInteractions`).
 * @returns        Fully-populated `ScopeDescriptor`. Never null/undefined.
 */
export function resolveScope(
	routeId: string,
	params: Record<string, string>,
	reader: ScopeReader,
): ScopeDescriptor {
	// ── Project contributor (ADR-002 P1) ───────────────────────────────────
	if (
		(routeId === '/projects/[slug]' ||
			routeId === '/projects/[slug]/queue' ||
			routeId === 'project') &&
		typeof params.slug === 'string' &&
		params.slug.length > 0
	) {
		const slug = params.slug;

		const contextPayload = buildProjectContextPayload(slug, reader);

		// Resolve the bound repo via ADR-030's resolveProjectRepo. We adapt
		// our ScopeReader.getNote into the NoteRepoShape the helper expects.
		const repo =
			resolveProjectRepo(`projects/${slug}/index.md`, (path) => {
				const n = reader.getNote(path);
				return n ? { meta: n.meta } : undefined;
			}) ?? null;

		return {
			kind: 'project',
			chip: { icon: 'folder', label: `project: ${slug}` },
			contextPayload,
			cwd: repo ?? SOUL_HUB_REPO,
			repo,
			primer:
				`You are working on the **${slug}** project in Soul Hub. ` +
				`The project context is loaded above. What would you like to work on?`,
		};
	}

	// ── Vault-note contributor (ADR-006 P3) ────────────────────────────────
	// Matches `/vault` route when a note path is supplied, or the `vault-note`
	// scope kind string sent by the client drawer.
	if (
		(routeId === '/vault' || routeId === 'vault-note') &&
		typeof params.notePath === 'string' &&
		params.notePath.length > 0
	) {
		return resolveVaultNoteScope(params.notePath, reader);
	}

	// ── Inbox-thread contributor (ADR-006 P3) ──────────────────────────────
	// Matches `/inbox` route or the `inbox-thread` scope kind.
	// Area-level context (no specific thread — see contributor file for rationale).
	if (routeId === '/inbox' || routeId === 'inbox-thread') {
		return resolveInboxThreadScope();
	}

	// ── CRM-contact contributor (ADR-006 P3) ───────────────────────────────
	// Matches `/crm` route when a contact ID is supplied, or the `crm-contact`
	// scope kind string. The CRM page writes `?id=<contactId>` via replaceState.
	if (
		(routeId === '/crm' || routeId === 'crm-contact') &&
		typeof params.contactId === 'string' &&
		params.contactId.length > 0
	) {
		return resolveCrmContactScope(params.contactId, reader);
	}

	// ── Global fallback ────────────────────────────────────────────────────
	// All unrecognised routes land here. This branch MUST be last and MUST
	// never throw — it is the guaranteed non-null sentinel.
	return {
		kind: 'global',
		chip: { icon: 'cpu', label: 'Soul Hub' },
		contextPayload: buildGlobalContextPayload(),
		cwd: SOUL_HUB_REPO,
		repo: null,
		primer:
			'You are in Soul Hub — your AI-human collaboration command center. ' +
			'How can I help you today?',
	};
}
