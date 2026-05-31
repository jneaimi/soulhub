/**
 * projects-graph ADR-026 — pure lane + progress computation for the Workbench
 * worklist endpoint.
 *
 * Extracted here (out of the SvelteKit `+server.ts`) so tests can import it
 * without pulling in `@sveltejs/kit` or the vault engine.
 */

export type Lane = 'ready_for_ai' | 'waiting_on_you' | 'ready_for_you' | 'waiting_on_ai' | 'in_flight';
export type Owner = 'ai' | 'human' | 'unassigned';

export interface RunningRunProgress {
	costUsd: number;
	numTurns: number;
	startedAt: number; // epoch ms
}

/** ADR-026 P2b — metadata for a run paused waiting for an operator answer. */
export interface AwaitingOperatorPayload {
	question: string;
	sessionId: string;
	branch: string;
	agentId: string;
	/** ADR-019 P2 — agent run ID; used by the "Bump budget + continue" affordance
	 *  to call POST /api/agents/runs/[runId]/bump-continue without a client-side
	 *  session lookup. */
	runId: string;
}

/** ADR-026 D3 — payload for a finished, un-merged coding dispatch awaiting
 *  operator review. Surfaces in the Waiting on you lane as a review hand-off
 *  card with branch, summary, follow-ups, and gate status. */
export interface ReviewHandoffPayload {
	branch: string;
	summary: string;
	followUps: string[];
	gatesGreen: boolean;
	costUsd: number;
}

/** ADR-012 P1 — payload for a finished coding dispatch that reported success
 *  but left NO reviewable artifact (no committed branch + no hand-back).
 *  Surfaces in Waiting on you as a "review manually" card instead of a silent
 *  ready_for_ai fallback. */
export interface NoArtifactPayload {
	summary: string;
	costUsd: number;
	numTurns: number;
}

export interface LaneResult {
	lane: Lane;
	progress?: RunningRunProgress;
	/** ADR-026 P2b — present when lane is `waiting_on_you` due to a paused run. */
	awaitingOperator?: AwaitingOperatorPayload;
	/** ADR-026 D3 — present when lane is `waiting_on_you` due to a finished, un-merged run. */
	reviewHandoff?: ReviewHandoffPayload;
	/** ADR-012 P1 — present when lane is `waiting_on_you` due to a success-like
	 *  run that produced no reviewable artifact. */
	noArtifact?: NoArtifactPayload;
}

/** Decide the worklist lane for one artifact and, if it is in-flight, attach
 *  the live run telemetry.  Pure — no DB, no vault, no SvelteKit.
 *
 *  Rules (evaluated in priority order):
 *    1. If `path` is in `runningRuns`  → `in_flight` + progress (blockers ignored).
 *    2. If `awaitingOperator` is set   → `waiting_on_you` + payload (a paused run
 *       beats blocked/ready computation; running and awaiting are mutually exclusive
 *       because a paused run has `finished_at` set and is NOT in `runningRuns`).
 *    3. If `reviewHandoff` is set      → `waiting_on_you` + reviewHandoff payload (a
 *       finished branch is the operator's move; beats normal blocked/ready logic).
 *    4. If `noArtifact` is set         → `waiting_on_you` + noArtifact payload (a
 *       success-like run that left nothing to review is still the operator's move —
 *       never a silent ready fallback). Ranks below reviewHandoff: a real branch
 *       always wins over a no-artifact note for the same subject.
 *    5. If `blockedByUnmet` is empty   → `ready_for_ai` (ai owner) or `ready_for_you`.
 *    6. Otherwise                      → `waiting_on_you` (ai) or `waiting_on_ai`. */
export function computeLaneAndProgress(
	path: string,
	owner: Owner,
	blockedByUnmet: string[],
	runningRuns: Map<string, { costUsd: number; numTurns: number; startedAt: number }>,
	awaitingOperator?: AwaitingOperatorPayload,
	reviewHandoff?: ReviewHandoffPayload,
	noArtifact?: NoArtifactPayload,
): LaneResult {
	// Priority 1: in-flight (running) wins everything.
	const telemetry = runningRuns.get(path);
	if (telemetry) {
		return {
			lane: 'in_flight',
			progress: {
				costUsd: telemetry.costUsd,
				numTurns: telemetry.numTurns,
				startedAt: telemetry.startedAt,
			},
		};
	}

	// Priority 2: paused run awaiting operator answer.
	if (awaitingOperator) {
		return { lane: 'waiting_on_you', awaitingOperator };
	}

	// Priority 3: finished, un-merged coding run awaiting review.
	if (reviewHandoff) {
		return { lane: 'waiting_on_you', reviewHandoff };
	}

	// Priority 4: success-like run that left no reviewable artifact.
	if (noArtifact) {
		return { lane: 'waiting_on_you', noArtifact };
	}

	// Priority 5 & 6: normal blocked / ready logic.
	const isAi = owner === 'ai';
	if (blockedByUnmet.length === 0) {
		return { lane: isAi ? 'ready_for_ai' : 'ready_for_you' };
	}
	return { lane: isAi ? 'waiting_on_you' : 'waiting_on_ai' };
}
