/** ADR-007 — In-process proposal store.
 *
 *  Holds the transient state for agent-fix dispatches:
 *    dispatching → (fixer runs) → ready (has a HygieneProposal) | error
 *
 *  In-memory Map keyed by `rowKey` (the hygiene UI's per-row identifier).
 *  Proposals are short-lived — the operator either approves or rejects within
 *  the same session. A process restart clears the store; the operator
 *  re-dispatches if needed (acceptable for P1).
 *
 *  TTL: PROPOSAL_TTL_MS — stale entries are pruned on every write so the Map
 *  doesn't grow unbounded on a long-running server. Entries older than the
 *  TTL are treated as expired and return `null` from `getProposal`.
 */

import type { HygieneProposal, ProposalEntry, ProposalStatus } from './agent-types.js';

const PROPOSAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map<string, ProposalEntry>();

function prune(): void {
	const cutoff = Date.now() - PROPOSAL_TTL_MS;
	for (const [key, entry] of store) {
		if (entry.updatedAt < cutoff) store.delete(key);
	}
}

/** Set an entry to `dispatching` with an optional runId. */
export function setDispatching(rowKey: string, runId?: string): void {
	prune();
	store.set(rowKey, {
		rowKey,
		status: 'dispatching',
		runId,
		updatedAt: Date.now(),
	});
}

/** Update an in-flight entry (e.g. update runId once the dispatch started). */
export function updateRunId(rowKey: string, runId: string): void {
	const existing = store.get(rowKey);
	if (existing) {
		store.set(rowKey, { ...existing, runId, updatedAt: Date.now() });
	}
}

/** Mark a dispatch as ready with the parsed proposal. */
export function setReady(rowKey: string, proposal: HygieneProposal, rawOutput?: string): void {
	prune();
	store.set(rowKey, {
		rowKey,
		status: 'ready',
		proposal,
		rawOutput,
		updatedAt: Date.now(),
	});
}

/** Mark a dispatch as errored. */
export function setError(rowKey: string, error: string, rawOutput?: string): void {
	prune();
	store.set(rowKey, {
		rowKey,
		status: 'error',
		error,
		rawOutput,
		updatedAt: Date.now(),
	});
}

/** Read the current entry for a rowKey. Returns null when missing or expired. */
export function getProposal(rowKey: string): ProposalEntry | null {
	const entry = store.get(rowKey);
	if (!entry) return null;
	if (Date.now() - entry.updatedAt > PROPOSAL_TTL_MS) {
		store.delete(rowKey);
		return null;
	}
	return entry;
}

/** Remove an entry (after approve or reject). */
export function deleteProposal(rowKey: string): void {
	store.delete(rowKey);
}

/** Current status snapshot (for tests and the status API). */
export function getStatus(rowKey: string): ProposalStatus | 'not-found' {
	return getProposal(rowKey)?.status ?? 'not-found';
}
