/**
 * POST /api/recipes/runs/[run_id]/cancel — fire AbortSignal for an in-flight
 *  recipe run. Closes ADR-005 falsifier #5 (cancellation works end-to-end).
 *
 * The run must have been started with a caller-supplied `run_id` in the body
 * of POST /api/recipes/run — otherwise the auto-generated short-id isn't
 * known until the run completes, leaving no window to cancel. Pattern:
 *
 *   uuid=$(uuidgen | tr 'A-Z' 'a-z')
 *   curl -X POST /api/recipes/run -d "{\"recipe\":\"X\",\"run_id\":\"$uuid\"}" &
 *   sleep 5
 *   curl -X POST /api/recipes/runs/$uuid/cancel
 *
 * Returns:
 *   200 { ok: true,  run_id }            — signal fired
 *   404 { ok: false, run_id, active }    — run_id not in registry; `active`
 *                                          lists currently-cancellable IDs
 *   400 on missing run_id (shouldn't happen with the route shape)
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { cancelRun, listActiveRuns } from '$lib/naseej/runner.js';

export const POST: RequestHandler = async ({ params }) => {
	const runId = params.run_id;
	if (!runId) return json({ error: 'run_id is required' }, { status: 400 });

	const ok = cancelRun(runId);
	if (!ok) {
		return json(
			{
				ok: false,
				run_id: runId,
				error: 'run_id not found in registry — already finished, never started, or wrong id',
				active: listActiveRuns(),
			},
			{ status: 404 },
		);
	}
	return json({ ok: true, run_id: runId });
};
