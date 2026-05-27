/**
 * GET /api/chat/scope — Resolve PTY-relevant scope fields (ADR-005).
 *
 * The chat drawer (ADR-004) calls this when the user activates the Claude PTY
 * engine to obtain `cwd` and `primer` without duplicating `resolveScope` logic
 * on the client. Server-side call ensures vault reads (project index, open
 * decisions, note backlinks, CRM contacts) are available exactly as they are
 * for the Orchestrator engine.
 *
 * Query params (ADR-002 P1 + ADR-006 P3):
 *   scopeKind   — 'project' | 'vault-note' | 'inbox-thread' | 'crm-contact' | 'global'  (required)
 *   slug        — project slug                (required when scopeKind='project')
 *   notePath    — vault-relative note path   (required when scopeKind='vault-note')
 *   contactId   — CRM contact ID             (required when scopeKind='crm-contact')
 *
 * Response 200: `{ cwd: string, primer: string, kind: ScopeKind }`
 * Response 400: `{ error: string }` when required params are missing.
 *
 * Safety: read-only GET. Does not expose the full `contextPayload`.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { resolveScope } from '$lib/chat/scope/resolve.js';
import type { ScopeReader, CrmContactScopeShape, CrmInteractionScopeItem } from '$lib/chat/scope/types.js';
import { getContact, listInteractions } from '$lib/crm/index.js';

// ── Scope reader ─────────────────────────────────────────────────────────────

/**
 * Build a `ScopeReader` backed by the live vault engine + CRM DB.
 * ADR-006: extended with optional `getVaultNoteBacklinks`, `getCrmContact`,
 * `getCrmInteractions` — all wrapped in try/catch so the reader degrades
 * gracefully when the engine or DB is unavailable.
 */
function buildScopeReader(): ScopeReader {
	const engine = getVaultEngine();

	return {
		// ── ADR-002 baseline ────────────────────────────────────────────────
		getNote: (path) => {
			if (!engine) return undefined;
			const note = engine.getNote(path);
			if (!note) return undefined;
			return { meta: note.meta, content: note.content, title: note.title };
		},
		listProjectNotes: (slug, opts) => {
			if (!engine) return [];
			const prefix   = `projects/${slug}/`;
			const wantType = opts?.type;
			return engine
				.getAllNotes()
				.filter(
					(n) =>
						n.path.startsWith(prefix) &&
						(wantType === undefined || n.meta.type === wantType),
				)
				.slice(0, 10)
				.map((n) => ({ path: n.path, title: n.title, meta: n.meta }));
		},

		// ── ADR-006 extensions ───────────────────────────────────────────────
		getVaultNoteBacklinks: (path) => {
			if (!engine) return [];
			try {
				return engine.getBacklinks(path).map((n) => n.title);
			} catch {
				return [];
			}
		},
		getCrmContact: (contactId): CrmContactScopeShape | undefined => {
			try {
				const c = getContact(contactId);
				if (!c) return undefined;
				return {
					id: c.id,
					displayName: c.displayName,
					company: c.company,
					role: c.role,
					stage: c.stage,
					notes: c.notes,
				};
			} catch {
				return undefined;
			}
		},
		getCrmInteractions: (contactId, limit): CrmInteractionScopeItem[] => {
			try {
				return listInteractions(contactId, limit).map((ix) => ({
					channel: ix.channel,
					direction: ix.direction,
					summary: ix.summary,
					timestamp: ix.timestamp,
				}));
			} catch {
				return [];
			}
		},
	};
}

// ── Route handler ─────────────────────────────────────────────────────────────

export const GET: RequestHandler = ({ url }) => {
	const scopeKind  = url.searchParams.get('scopeKind') ?? 'global';
	const slug       = url.searchParams.get('slug') ?? '';
	const notePath   = url.searchParams.get('notePath') ?? '';
	const contactId  = url.searchParams.get('contactId') ?? '';

	// ── Validate required params per scope kind ─────────────────────────────
	if (scopeKind === 'project' && !slug.trim()) {
		return json(
			{ error: "scopeKind='project' requires a non-empty 'slug' query param" },
			{ status: 400 },
		);
	}
	if (scopeKind === 'vault-note' && !notePath.trim()) {
		return json(
			{ error: "scopeKind='vault-note' requires a non-empty 'notePath' query param" },
			{ status: 400 },
		);
	}
	if (scopeKind === 'crm-contact' && !contactId.trim()) {
		return json(
			{ error: "scopeKind='crm-contact' requires a non-empty 'contactId' query param" },
			{ status: 400 },
		);
	}

	// ── Build params object for resolveScope ────────────────────────────────
	// resolveScope accepts scope kind strings directly (ADR-006 update) so we
	// can pass scopeKind as routeId without translation.
	const params: Record<string, string> = {};
	if (slug)      params.slug      = slug;
	if (notePath)  params.notePath  = notePath;
	if (contactId) params.contactId = contactId;

	const reader = buildScopeReader();
	const scope  = resolveScope(scopeKind, params, reader);

	return json({ cwd: scope.cwd, primer: scope.primer, kind: scope.kind });
};
