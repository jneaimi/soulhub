/**
 * Shared conversation-key helpers for the web chat channel (ADR-017).
 *
 * Extracted from `src/routes/api/chat/web/+server.ts` so the GET/DELETE
 * history routes and GET conversations route share the SAME key derivation
 * and decoding as the POST handler — no drift risk.
 *
 * Key space (ADR-003 / ADR-006):
 *   `web:project:<slug>`
 *   `web:vault-note:<notePath>`
 *   `web:crm:<contactId>`
 *   `web:inbox`
 *   `web:global`
 */

// ── Encode: scope → conversation key ─────────────────────────────────────────

/**
 * Derive a stable `conversationKey` from the scope kind + params.
 * Always prefixed with `web:` so it can never collide with WhatsApp E.164
 * numbers (`+971…`) or Telegram keys (`tg:…`).
 *
 * ADR-003: project scope.
 * ADR-006: vault-note, crm-contact, inbox-thread, global extensions.
 */
export function conversationKeyForScope(
	kind: string,
	params: Record<string, string>,
): string {
	if (kind === 'project' && params.slug) {
		return `web:project:${params.slug}`;
	}
	if (kind === 'vault-note' && params.notePath) {
		return `web:vault-note:${params.notePath}`;
	}
	if (kind === 'crm-contact' && params.contactId) {
		return `web:crm:${params.contactId}`;
	}
	if (kind === 'inbox-thread') {
		return 'web:inbox';
	}
	return 'web:global';
}

// ── Decode: conversation key → scope ─────────────────────────────────────────

export interface ParsedScope {
	scopeKind: string;
	scopeParams: Record<string, string>;
	/** Human-readable label for the scope chip. */
	label: string;
	/** SvelteKit route URL for `goto()` — navigating here re-hydrates the transcript. */
	targetUrl: string;
}

/**
 * Decode a `web:` conversation key back to `{ scopeKind, scopeParams, label, targetUrl }`.
 * Used by GET /api/chat/web/conversations to turn DB rows into navigable items (ADR-017 S3).
 *
 * The inverse of `conversationKeyForScope`:
 *   `web:project:<slug>`      → `/projects/<slug>`
 *   `web:vault-note:<path>`   → `/vault?note=<path>`
 *   `web:crm:<contactId>`     → `/crm?id=<contactId>`
 *   `web:inbox`               → `/inbox`
 *   `web:global`              → `/`
 */
export function parseScopeFromKey(key: string): ParsedScope {
	if (key.startsWith('web:project:')) {
		const slug = key.slice('web:project:'.length);
		return {
			scopeKind: 'project',
			scopeParams: { slug },
			label: `project: ${slug}`,
			targetUrl: `/projects/${slug}`,
		};
	}
	if (key.startsWith('web:vault-note:')) {
		const notePath = key.slice('web:vault-note:'.length);
		const name = notePath.split('/').pop()?.replace(/\.md$/, '') ?? 'vault';
		return {
			scopeKind: 'vault-note',
			scopeParams: { notePath },
			label: `note: ${name}`,
			targetUrl: `/vault?note=${encodeURIComponent(notePath)}`,
		};
	}
	if (key.startsWith('web:crm:')) {
		const contactId = key.slice('web:crm:'.length);
		return {
			scopeKind: 'crm-contact',
			scopeParams: { contactId },
			label: `contact: ${contactId}`,
			targetUrl: `/crm?id=${encodeURIComponent(contactId)}`,
		};
	}
	if (key === 'web:inbox') {
		return {
			scopeKind: 'inbox-thread',
			scopeParams: {},
			label: 'inbox',
			targetUrl: '/inbox',
		};
	}
	// web:global (or any unrecognised key)
	return {
		scopeKind: 'global',
		scopeParams: {},
		label: 'Soul Hub',
		targetUrl: '/',
	};
}
