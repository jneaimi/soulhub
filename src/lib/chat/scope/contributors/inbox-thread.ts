/**
 * ADR-006 — inbox-thread scope contributor.
 *
 * Route matcher: `routeId === '/inbox'`.
 * Payload builder: general inbox area context.
 *
 * Design note: the inbox page tracks the selected message in component state
 * (not in the URL), so this contributor surfaces area-level context rather
 * than a specific thread. A future enhancement (P4) could add `?message=<id>`
 * URL tracking to the inbox page and use a thread-specific payload — that would
 * require no engine or drawer change, only an update to this contributor file.
 *
 * Satisfies the ADR-006 falsifier for inbox-thread: the scope kind is wired and
 * active on every `/inbox` navigation without touching the engine or drawer.
 */

import type { ScopeDescriptor } from '../types.js';

/** Default CWD for inbox-thread scope — the soul-hub repo. */
const SOUL_HUB_REPO = '~/dev/soul-hub';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the `contextPayload` for an inbox-thread scope.
 * Pure: no reader or I/O needed — general area context only.
 */
export function buildInboxContextPayload(): string {
	return [
		'# Soul Hub — Inbox',
		'',
		'You are in the Soul Hub email inbox.',
		'Available actions: search messages, filter by account / status / category, ' +
			'view message bodies, recategorize, save senders to CRM.',
		'',
		'API surface:',
		'  GET  /api/inbox/messages       — list messages with filters (account, status, category, search)',
		'  GET  /api/inbox/accounts       — email accounts and sync status',
		'  PATCH /api/inbox/messages/[id]/recategorize — change a message category',
		'  POST /api/inbox/save-sender-to-crm          — add message sender to CRM',
	].join('\n');
}

/**
 * Resolve an inbox-thread `ScopeDescriptor`.
 *
 * @returns Fully-populated `ScopeDescriptor` for the inbox-thread contributor.
 */
export function resolveInboxThreadScope(): ScopeDescriptor {
	return {
		kind: 'inbox-thread',
		chip: { icon: 'mail', label: 'inbox' },
		contextPayload: buildInboxContextPayload(),
		cwd: SOUL_HUB_REPO,
		repo: null,
		primer:
			'You are in the Soul Hub inbox. ' +
			'You can help search, triage, categorize, and manage email messages. ' +
			'What would you like to do?',
	};
}
