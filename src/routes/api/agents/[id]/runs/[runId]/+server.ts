/**
 * GET /api/agents/[id]/runs/[runId] — sub-agent (fan-out) detail for one run.
 *
 * ADR-005 gap #3: an orchestrator's sub-agent work lands in transcript
 * sidechains that the parent run record skips, so it's invisible in the UI.
 * This re-reads the run's transcript (located by its stored claude_session_id)
 * and returns each sub-agent's task + final output + cost/turns/model — on
 * demand, only when the operator drills into a run. Returns `{ subagents: [] }`
 * for a non-fan-out run (the common case).
 */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { getAgentRun } from '$lib/agents/runs.js';
import { locateTranscript } from '$lib/sessions/run-record.js';
import { rollupSubagentDetail } from '$lib/sessions/subagent-cost.js';
import { config } from '$lib/config.js';

export const GET: RequestHandler = async ({ params }) => {
	const { id, runId } = params;
	if (!id || !runId) throw error(400, 'agent id and runId are required');

	const run = getAgentRun(runId);
	if (!run || run.agentId !== id) throw error(404, `run '${runId}' not found for agent '${id}'`);

	// No Claude session id (e.g. non-PTY backend) → nothing to re-read.
	if (!run.claudeSessionId) return json({ runId, subagents: [] });

	try {
		const path = locateTranscript(run.claudeSessionId, config.resolved.vaultDir);
		if (!path) return json({ runId, subagents: [] });
		const subagents = await rollupSubagentDetail(path);
		return json({ runId, subagents });
	} catch (err) {
		return json({ runId, subagents: [], error: (err as Error).message }, { status: 500 });
	}
};
