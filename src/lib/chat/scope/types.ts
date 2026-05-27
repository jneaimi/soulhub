/**
 * ADR-002 — ChatScope provider: per-area context for the conversational layer.
 *
 * Types for the scope registry: `ScopeDescriptor`, `ScopeKind`, `ScopeChip`,
 * and the injected reader interface that keeps `resolveScope` pure.
 *
 * P1 ships `project` + `global`. Future contributors (`vault-note`,
 * `inbox-thread`, `crm-contact`) are reserved in `ScopeKind` and wired
 * after those ADRs ship — see ADR-006 (scope generalisation).
 */

// ── Scope kinds ───────────────────────────────────────────────────────────────

/**
 * Discriminator for the current area's scope kind.
 *
 * - `project`       — a project detail page (`/projects/[slug]`)
 * - `vault-note`    — a specific vault note (reserved; ADR-006)
 * - `inbox-thread`  — an inbox conversation thread (reserved; ADR-006)
 * - `crm-contact`   — a CRM contact record (reserved; ADR-006)
 * - `global`        — any unrecognised route; guaranteed non-null fallback
 */
export type ScopeKind =
	| 'project'
	| 'vault-note'
	| 'inbox-thread'
	| 'crm-contact'
	| 'global';

// ── Scope chip ────────────────────────────────────────────────────────────────

/**
 * Visual chip rendered in the chat drawer so the user can see what context
 * is active. Uses Lucide icon names.
 *
 * Examples:
 *   `{ icon: 'folder', label: 'project: soul-hub' }`
 *   `{ icon: 'cpu',    label: 'Soul Hub' }`
 */
export interface ScopeChip {
	/** Lucide icon identifier (e.g. `'folder'`, `'cpu'`, `'file-text'`). */
	icon: string;
	/** Short human-readable label shown beside the icon. */
	label: string;
}

// ── Scope descriptor ──────────────────────────────────────────────────────────

/**
 * Full context descriptor for the current area.
 *
 * Produced once per navigation event and consumed by:
 *   1. The Orchestrator web engine — injects `contextPayload` into the system turn.
 *   2. The Claude PTY engine — sets `cwd` + passes `primer` as the opening message.
 *   3. The drawer UI (ADR-004) — renders `chip` + drives scope-chip display.
 *
 * Invariants (enforced by `resolveScope`):
 *   - `contextPayload` is never empty (global fallback guarantees at least one line).
 *   - `cwd` is always a non-empty string (defaults to `~/dev/soul-hub`).
 *   - `resolveScope` never returns null/undefined and never throws.
 */
export interface ScopeDescriptor {
	kind: ScopeKind;
	chip: ScopeChip;
	/**
	 * Markdown block injected as context into the Orchestrator system turn.
	 * Contains: project/area description, open decisions, recent artifacts.
	 * Never empty — the global fallback always returns at least a header.
	 */
	contextPayload: string;
	/**
	 * Working directory for the Claude PTY engine session.
	 * Defaults to `~/dev/soul-hub` when no bound repo exists.
	 */
	cwd: string;
	/**
	 * Bound repo path for the area (from `projects/<slug>/index.md` `repo:`
	 * frontmatter via ADR-030 `resolveProjectRepo`), or `null` when no repo
	 * is explicitly bound. The PTY engine uses this to decide which worktree
	 * to provision.
	 */
	repo: string | null;
	/**
	 * Opening orientation message sent to the PTY engine at session start.
	 * Sets context without appearing in the Orchestrator history.
	 */
	primer: string;
}

// ── Injected reader interface ─────────────────────────────────────────────────

/**
 * Minimal note shape consumed by scope resolution.
 * Kept deliberately thin — only the fields `resolveScope` actually reads.
 */
export interface NoteScopeShape {
	meta: Record<string, unknown>;
	content: string;
	title: string;
}

/** Summary of a note for listing (decisions, artifacts). */
export interface NoteListItem {
	path: string;
	title: string;
	meta: Record<string, unknown>;
}

// ── ADR-006 contributor shapes ────────────────────────────────────────────────

/**
 * Minimal CRM contact shape consumed by the crm-contact contributor (ADR-006).
 * Kept thin — only the fields `buildCrmContactContextPayload` reads.
 */
export interface CrmContactScopeShape {
	id: string;
	displayName: string;
	company: string | null;
	role: string | null;
	stage: string;
	notes: string | null;
}

/**
 * One interaction item for the crm-contact contributor (ADR-006).
 * Mirrors the `Interaction` row shape from `$lib/crm/types` without importing
 * that module here (keeps the scope package self-contained).
 */
export interface CrmInteractionScopeItem {
	channel: string;
	direction: string;
	summary: string;
	timestamp: number; // epoch ms
}

// ── Scope reader interface ────────────────────────────────────────────────────

/**
 * ADR-002 "getNote / project reader" DI pair — extended in ADR-006 with
 * optional contributor-specific methods.
 *
 * All methods are pure from the resolver's perspective — the resolver performs
 * no I/O. Callers inject real vault/CRM lookups; tests inject fakes (no live
 * vault or DB needed). Mirrors `resolveProjectRepo`'s DI shape.
 *
 * The ADR-006 additions are **optional** so existing `ScopeReader`
 * implementations (including tests) are backward-compatible — they need not
 * implement the new methods; contributors gracefully degrade via `?.()`.
 */
export interface ScopeReader {
	// ── ADR-002 baseline ──────────────────────────────────────────────────────

	/**
	 * Retrieve a single note by vault-relative path.
	 * Returns `undefined` when the note is not indexed.
	 */
	getNote(path: string): NoteScopeShape | undefined;

	/**
	 * List notes belonging to `slug`, optionally filtered by `type`.
	 * Implementations may cap results (10 is a reasonable ceiling).
	 * Returns `[]` when the project has no notes of the requested type.
	 */
	listProjectNotes(slug: string, opts?: { type?: string }): NoteListItem[];

	// ── ADR-006 contributor extensions (optional) ─────────────────────────────

	/**
	 * Return the titles (or paths) of notes that wikilink TO `path`.
	 * Used by the vault-note contributor to surface backlinks in the context
	 * payload. Returns `[]` when the vault engine is unavailable.
	 *
	 * Optional — callers use `reader.getVaultNoteBacklinks?.(path) ?? []`.
	 */
	getVaultNoteBacklinks?(path: string): string[];

	/**
	 * Retrieve a CRM contact record by its stable ID (e.g. `CRM-2026-001`).
	 * Returns `undefined` when the contact is not found or CRM is unavailable.
	 * Used by the crm-contact contributor.
	 *
	 * Optional — callers use `reader.getCrmContact?.(id)`.
	 */
	getCrmContact?(contactId: string): CrmContactScopeShape | undefined;

	/**
	 * Return up to `limit` most-recent interactions for a CRM contact,
	 * newest-first. Returns `[]` when none exist or CRM is unavailable.
	 * Used by the crm-contact contributor.
	 *
	 * Optional — callers use `reader.getCrmInteractions?.(id, limit) ?? []`.
	 */
	getCrmInteractions?(contactId: string, limit: number): CrmInteractionScopeItem[];
}
