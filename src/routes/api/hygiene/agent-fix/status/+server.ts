/** GET /api/hygiene/agent-fix/status?rowKey=... — poll proposal status.
 *
 *  ADR-007 P1: the client polls this after dispatching the hygiene-fixer agent.
 *  Returns the current state from the in-memory proposal store:
 *
 *    { status: 'dispatching' }              — agent running, no result yet
 *    { status: 'ready', proposal: {...} }   — proposal ready for human review
 *    { status: 'error', error: '...' }      — dispatch or parse failed
 *    { status: 'not-found' }               — no entry (row not dispatched or TTL expired)
 *
 *  No authentication beyond same-origin (sec-fetch-site guard). The proposal
 *  store holds no sensitive data — it mirrors what the hygiene report already
 *  shows on this page.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getProposal } from '$lib/vault-hygiene/proposal-store.js';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

export const GET: RequestHandler = async ({ request, url }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	const rowKey = url.searchParams.get('rowKey');
	if (!rowKey) {
		return json({ ok: false, error: 'rowKey query param required' }, { status: 400 });
	}

	const entry = getProposal(rowKey);
	if (!entry) {
		return json({ status: 'not-found' });
	}

	switch (entry.status) {
		case 'dispatching':
			return json({ status: 'dispatching', runId: entry.runId });

		case 'ready':
			return json({
				status: 'ready',
				runId: entry.runId,
				proposal: entry.proposal,
			});

		case 'error':
			return json({
				status: 'error',
				error: entry.error,
				runId: entry.runId,
			});

		default:
			return json({ status: 'error', error: 'unknown status in store' });
	}
};
