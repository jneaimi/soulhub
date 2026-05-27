/**
 * ADR-006 — crm-contact scope contributor.
 *
 * Route matcher: `routeId === '/crm'` AND `params.contactId` is non-empty.
 * Payload builder: contact record (name, company, stage, role, notes) +
 * recent interactions list.
 *
 * The contact is identified by the `?id=` URL search param, which the CRM page
 * writes via `replaceState` when a contact row is selected — making the contact
 * detail view deep-linkable and scope-resolvable without any CRM page changes.
 */

import type { ScopeDescriptor, ScopeReader } from '../types.js';

/** Default CWD for crm-contact scope — the soul-hub repo. */
const SOUL_HUB_REPO = '~/dev/soul-hub';

/** Max recent interactions to include in contextPayload. */
const MAX_INTERACTIONS = 5;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Format an epoch-ms timestamp as a YYYY-MM-DD date string (UTC). */
function epochToDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the `contextPayload` for a crm-contact scope.
 *
 * Sources (all via the injected reader — no direct I/O):
 *   - `getCrmContact?(contactId)` — contact record
 *   - `getCrmInteractions?(contactId, limit)` — recent interactions
 */
export function buildCrmContactContextPayload(
	contactId: string,
	reader: ScopeReader,
): string {
	const contact = reader.getCrmContact?.(contactId);

	if (!contact) {
		return [
			`# CRM Contact: ${contactId}`,
			'',
			'(Contact record unavailable — CRM may be initializing or the ID is unknown.)',
		].join('\n');
	}

	const lines: string[] = [
		`# CRM Contact: ${contact.displayName}`,
		`ID: ${contact.id} · Stage: ${contact.stage}`,
	];

	if (contact.company) lines.push(`Company: ${contact.company}`);
	if (contact.role) lines.push(`Role: ${contact.role}`);
	if (contact.notes?.trim()) {
		lines.push('', `Notes: ${contact.notes.trim()}`);
	}

	// Recent interactions
	const interactions = reader.getCrmInteractions?.(contactId, MAX_INTERACTIONS) ?? [];
	if (interactions.length > 0) {
		lines.push('', '## Recent Interactions');
		for (const ix of interactions) {
			const date = epochToDate(ix.timestamp);
			lines.push(`- ${date} · ${ix.channel} (${ix.direction}): ${ix.summary}`);
		}
	}

	return lines.join('\n');
}

/**
 * Resolve a crm-contact `ScopeDescriptor`.
 *
 * @param contactId  CRM contact ID (e.g. `CRM-2026-001`).
 * @param reader     Injected scope reader — implements optional `getCrmContact`
 *                   and `getCrmInteractions` for contact + interaction context.
 * @returns          Fully-populated `ScopeDescriptor` for the crm-contact contributor.
 */
export function resolveCrmContactScope(
	contactId: string,
	reader: ScopeReader,
): ScopeDescriptor {
	const contact = reader.getCrmContact?.(contactId);
	const displayName = contact?.displayName ?? contactId;

	return {
		kind: 'crm-contact',
		chip: { icon: 'user', label: `contact: ${displayName}` },
		contextPayload: buildCrmContactContextPayload(contactId, reader),
		cwd: SOUL_HUB_REPO,
		repo: null,
		primer:
			`You are viewing the CRM contact **${displayName}** (ID: \`${contactId}\`). ` +
			`The contact record and recent interactions are loaded above. ` +
			`You can help with follow-ups, interaction logging, stage moves, and outreach. ` +
			`What would you like to do?`,
	};
}
