/**
 * ADR-006 — vault-note scope contributor.
 *
 * Route matcher: `routeId === '/vault'` AND `params.notePath` is non-empty.
 * Payload builder: note title + frontmatter metadata + body excerpt + backlinks.
 *
 * `cwd` is set to the vault root so the PTY engine operates in the note's home.
 * Writes still hit the ADR-046 chokepoint — this contributor is read-only.
 */

import type { ScopeDescriptor, ScopeReader } from '../types.js';

/** Default CWD for vault-note scope — the operator's vault. */
const VAULT_ROOT = '~/vault';

/** Max characters of note body to include in contextPayload. */
const MAX_CONTENT_CHARS = 1000;

/** Max backlinks to list in contextPayload. */
const MAX_BACKLINKS = 10;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Derive a human-readable title from the vault note path as a fallback. */
function titleFromPath(notePath: string): string {
	return notePath.split('/').pop()?.replace(/\.md$/, '').replace(/-/g, ' ') ?? 'Vault Note';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the `contextPayload` for a vault-note scope.
 *
 * Sources (all via the injected reader — no direct I/O):
 *   - `getNote(notePath)` — title, frontmatter, body
 *   - `getVaultNoteBacklinks?(notePath)` — list of titles linking to this note
 */
export function buildVaultNoteContextPayload(
	notePath: string,
	reader: ScopeReader,
): string {
	const note = reader.getNote(notePath);
	const title = note?.title ?? titleFromPath(notePath);
	const lines: string[] = [`# Vault Note: ${title}`, `Path: ${notePath}`];

	// Frontmatter metadata — type / status / tags on one line
	if (note?.meta) {
		const { type, tags, status } = note.meta;
		const parts: string[] = [];
		if (type) parts.push(`type: ${String(type)}`);
		if (status) parts.push(`status: ${String(status)}`);
		if (Array.isArray(tags) && tags.length > 0) {
			parts.push(`tags: ${(tags as string[]).join(', ')}`);
		}
		if (parts.length > 0) lines.push(parts.join(' · '));
	}

	// Note body excerpt (first MAX_CONTENT_CHARS characters)
	const body = note?.content?.trim() ?? '';
	if (body) {
		const excerpt = body.length > MAX_CONTENT_CHARS ? body.slice(0, MAX_CONTENT_CHARS) + '…' : body;
		lines.push('', excerpt);
	}

	// Backlinks — notes that link to this note
	const backlinks = reader.getVaultNoteBacklinks?.(notePath) ?? [];
	if (backlinks.length > 0) {
		lines.push('', '## Linked from');
		for (const bl of backlinks.slice(0, MAX_BACKLINKS)) {
			lines.push(`- ${bl}`);
		}
	}

	return lines.join('\n');
}

/**
 * Resolve a vault-note `ScopeDescriptor`.
 *
 * @param notePath  Vault-relative path to the note (e.g. `projects/foo/index.md`).
 * @param reader    Injected scope reader — must implement `getNote`; optionally
 *                  `getVaultNoteBacklinks` for richer backlink context.
 * @returns         Fully-populated `ScopeDescriptor` for the vault-note contributor.
 */
export function resolveVaultNoteScope(
	notePath: string,
	reader: ScopeReader,
): ScopeDescriptor {
	const note = reader.getNote(notePath);
	const title = note?.title ?? titleFromPath(notePath);

	return {
		kind: 'vault-note',
		chip: { icon: 'file-text', label: `note: ${title}` },
		contextPayload: buildVaultNoteContextPayload(notePath, reader),
		cwd: VAULT_ROOT,
		repo: null,
		primer:
			`You are viewing the vault note **${title}** (path: \`${notePath}\`). ` +
			`The note content and backlinks are loaded above. ` +
			`Vault writes go through the ADR-046 chokepoint — no direct file edits. ` +
			`How can I help you with this note?`,
	};
}
