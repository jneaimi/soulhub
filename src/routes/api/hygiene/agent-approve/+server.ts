/** POST /api/hygiene/agent-approve — execute an approved HygieneProposal.
 *
 *  ADR-007 P1: the "Approve" action on a proposal card. Reads the proposal from
 *  the in-process store and routes each EditOp to the deterministic executor.
 *
 *  Approval-actor discipline (load-bearing for the falsifier):
 *    - Every vault write executed here uses `actor = 'hygiene-remediate'`.
 *    - The fixer agent's id (`hygiene-fixer`) NEVER appears in the audit log's
 *      actor column — that column is the data source for the falsifier task
 *      `hygiene-agent-propose-only-check` which asserts zero rows with that actor.
 *    - This discipline is enforced inside the executor primitives themselves
 *      (`retargetWikilink`, `addWikilinks`) via the APPROVAL_ACTOR constant.
 *
 *  TOCTOU re-validation:
 *    For `retarget-link`: we verify the source note still contains the broken
 *    wikilink before writing. If the link was already fixed (e.g. by a concurrent
 *    session), we return 409 `stale` rather than producing a no-op write.
 *
 *  P1 supported ops: `retarget-link` + `add-links`.
 *  P2 ops (`move-note`, `set-status`, `tick-task`, `promote`) return 400
 *  `op-not-supported` until ADR-007 P2 lands.
 *
 *  Body:
 *    { rowKey, alternativeIndex? }
 *    - rowKey: the proposal store key (identifies the pending proposal)
 *    - alternativeIndex: (optional) use alternatives[i] instead of the primary edits.
 *      When absent or -1, uses the primary `edits` array.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getProposal, deleteProposal } from '$lib/vault-hygiene/proposal-store.js';
import { retargetWikilink, addWikilinks } from '$lib/vault-hygiene/agent-primitives.js';
import { getVaultEngine } from '$lib/vault/index.js';
import type { EditOp, RetargetLinkOp, AddLinksOp, ProposalExecutionResult } from '$lib/vault-hygiene/agent-types.js';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

/** TOCTOU guard for `retarget-link`: verify the broken link still exists
 *  in the source note before executing. Returns false if the source is gone
 *  or no longer contains the link (already fixed / note moved). */
async function retargetLinkStillValid(op: RetargetLinkOp, vaultDir: string): Promise<boolean> {
	try {
		await access(join(vaultDir, op.source));
		const content = await readFile(join(vaultDir, op.source), 'utf-8');
		// Check that the raw wikilink still appears in the file.
		return content.includes(`[[${op.raw}]]`) || content.includes(`[[${op.raw}|`);
	} catch {
		return false;
	}
}

/** TOCTOU guard for `add-links`: verify the orphan note still exists. */
async function addLinksStillValid(op: AddLinksOp, vaultDir: string): Promise<boolean> {
	try {
		await access(join(vaultDir, op.path));
		return true;
	} catch {
		return false;
	}
}

/** Execute a single P1 edit-op. Returns detail on success; throws on failure. */
async function executeOp(op: EditOp, vaultDir: string): Promise<string> {
	switch (op.op) {
		case 'retarget-link': {
			// TOCTOU: re-validate before writing.
			if (!(await retargetLinkStillValid(op, vaultDir))) {
				throw Object.assign(new Error(`stale`), { code: 'stale' });
			}
			const result = await retargetWikilink(op.source, op.raw, op.newTarget);
			if (!result.ok) throw new Error(result.error ?? 'retargetWikilink failed');
			return result.detail ?? `retarget-link ok`;
		}
		case 'add-links': {
			// TOCTOU: re-validate before writing.
			if (!(await addLinksStillValid(op, vaultDir))) {
				throw Object.assign(new Error(`stale`), { code: 'stale' });
			}
			const result = await addWikilinks(op.path, op.targets);
			if (!result.ok) throw new Error(result.error ?? 'addWikilinks failed');
			return result.detail ?? `add-links ok`;
		}
		case 'move-note':
		case 'set-status':
		case 'set-frontmatter':
		case 'rename-file':
		case 'tick-task':
		case 'promote':
			throw new Error(`op '${op.op}' is not yet supported — lands in ADR-007 P2`);
		default: {
			const exhaustive: never = op;
			throw new Error(`unknown op: ${(exhaustive as { op: string }).op}`);
		}
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	let body: { rowKey?: unknown; alternativeIndex?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const { rowKey, alternativeIndex } = body;

	if (!rowKey || typeof rowKey !== 'string') {
		return json({ ok: false, error: 'rowKey is required (string)' }, { status: 400 });
	}

	// Read proposal from store.
	const entry = getProposal(rowKey);
	if (!entry) {
		return json({ ok: false, error: 'proposal-not-found', detail: 'No pending proposal for this row — may have expired' }, { status: 404 });
	}
	if (entry.status !== 'ready' || !entry.proposal) {
		return json({ ok: false, error: 'proposal-not-ready', detail: `Current status: ${entry.status}` }, { status: 409 });
	}

	const proposal = entry.proposal;

	// Resolve which edit set to execute.
	const altIdx = typeof alternativeIndex === 'number' ? alternativeIndex : -1;
	let opsToExecute: EditOp[];
	if (altIdx >= 0) {
		if (altIdx >= proposal.alternatives.length) {
			return json(
				{ ok: false, error: 'invalid-alternative-index', detail: `Only ${proposal.alternatives.length} alternatives` },
				{ status: 400 },
			);
		}
		opsToExecute = proposal.alternatives[altIdx];
	} else {
		opsToExecute = proposal.edits;
	}

	if (!opsToExecute || opsToExecute.length === 0) {
		// Empty edits = agent said "no good candidate" — delete proposal and return.
		deleteProposal(rowKey);
		return json({ ok: true, opsExecuted: 0, details: [], message: 'No ops to execute (agent proposed empty edits)' });
	}

	const engine = getVaultEngine();
	if (!engine) {
		return json({ ok: false, error: 'engine-unavailable' }, { status: 503 });
	}

	// Execute ops sequentially. On TOCTOU stale, 409 — row re-enters the report.
	// On any other error, 500 — leave the proposal in the store so the operator
	// can retry or reject.
	const executionResult: ProposalExecutionResult = {
		ok: true,
		opsExecuted: 0,
		details: [],
	};

	for (const op of opsToExecute) {
		try {
			const detail = await executeOp(op, engine.vaultDir);
			executionResult.opsExecuted++;
			executionResult.details.push(detail);
		} catch (err) {
			const errMsg = (err as Error).message ?? String(err);
			const isStale = (err as { code?: string }).code === 'stale' || errMsg === 'stale';
			if (isStale) {
				// TOCTOU: the anomaly was already fixed or the note moved.
				deleteProposal(rowKey);
				return json({ ok: false, error: 'stale', detail: `Op ${op.op} no longer applicable — report stale` }, { status: 409 });
			}
			executionResult.ok = false;
			executionResult.error = errMsg;
			// Leave the proposal in the store so the operator can retry.
			const { ok: _ok, ...partialResult } = executionResult;
			return json({ ok: false, ...partialResult }, { status: 500 });
		}
	}

	// All ops succeeded — remove the proposal from the store.
	deleteProposal(rowKey);

	const { ok: _ok2, ...successResult } = executionResult;
	return json({ ok: true, ...successResult });
};
