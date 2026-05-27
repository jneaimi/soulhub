/**
 * ADR-002 / ADR-006 — ChatScope provider: public surface.
 *
 * Consumers import from `$lib/chat/scope`:
 *   - `resolveScope` — the main resolver (pure, DI-friendly)
 *   - `SOUL_HUB_REPO` — default CWD constant
 *   - Types: `ScopeDescriptor`, `ScopeKind`, `ScopeChip`, `ScopeReader`,
 *     `NoteScopeShape`, `NoteListItem`,
 *     `CrmContactScopeShape`, `CrmInteractionScopeItem`  (ADR-006)
 *
 * Internal helpers (`buildProjectContextPayload`, `buildGlobalContextPayload`,
 * `CLOSED_STATUSES`, etc.) and contributor functions are NOT re-exported here
 * — they are implementation details used inside `resolveScope`.
 */

export { resolveScope, SOUL_HUB_REPO } from './resolve.js';
export type {
	ScopeKind,
	ScopeChip,
	ScopeDescriptor,
	ScopeReader,
	NoteScopeShape,
	NoteListItem,
	// ADR-006 contributor shapes (useful for callers building ScopeReader impls)
	CrmContactScopeShape,
	CrmInteractionScopeItem,
} from './types.js';
