/**
 * Public dispatch API.
 *
 * `dispatchAgent(id, task, opts)` — backend-agnostic façade. Loads the agent
 * record, picks the right dispatcher, applies the resolved budget, streams
 * `DispatchEvent`s, and returns a final `DispatchResult`. Persists one row
 * per terminal status to `agent_runs` (queries in `src/lib/agents/runs.ts`).
 *
 * Other modules (orchestrator, scheduler, pipeline blocks, WhatsApp router)
 * consume this — they don't know or care which lane the agent uses.
 */

import type { AgentSummary } from '../types.js';
import { getAgent } from '../store.js';
import type {
	BackendDispatcher,
	DispatchEvent,
	DispatchMode,
	DispatchResult,
} from './types.js';
import { claudePtyDispatcher } from './claude-pty.js';
import { claudeCliFlagDispatcher } from './claude-cli-flag.js';
import { claudeStreamJsonDispatcher } from './claude-stream-json.js';
import { aiSdkDispatcher } from './ai-sdk.js';
import { recordAgentRun, startAgentRun, finishAgentRun } from '../runs.js';
import { escalateBudgetApproval } from '../budget-escalation.js';

const dispatchers: Record<AgentSummary['backend'], BackendDispatcher> = {
	'claude-pty': claudePtyDispatcher,
	'claude-cli-flag': claudeCliFlagDispatcher,
	'claude-stream-json': claudeStreamJsonDispatcher,
	'ai-sdk': aiSdkDispatcher,
};

export interface DispatchAgentOptions {
	mode?: DispatchMode;
	signal?: AbortSignal;
	/** WhatsApp orchestrator (ADR-005) populates these — UI/API dispatches leave undefined. */
	jid?: string;
	sourceMessage?: string;
	/** projects-graph ADR-018 S2b — vault artifact this dispatch works on.
	 *  Written to agent_runs.subject_path for the Workbench in_flight lane. */
	subjectPath?: string;
	/** Phase 5 — orchestrator-built conversation brief inlined into the agent's
	 *  task prompt so dispatched agents see the prior topic + recent agent
	 *  output gist. Bounded ~600 chars upstream by `buildAgentContextBrief`. */
	context?: string;
	/** Naseej ADR-005 — per-call goal-condition override. Forwarded as-is to
	 *  the backend dispatcher; only `claude-pty` acts on it today. */
	goal_condition?: string;
	/** Naseej ADR-005 — per-call budget override. Partial: missing fields fall
	 *  through to the agent's stored budget, which itself falls through to
	 *  `PRODUCTION_DEFAULTS`. Forwarded as-is to the backend dispatcher. */
	budget_override?: {
		max_usd?: number;
		max_turns?: number;
		timeout_sec?: number;
		ceiling_usd?: number;
		ceiling_turns?: number;
	};
	/** ADR-006 Phase 2 — pause (instead of kill) at the hard ceiling so the run
	 *  can be resumed after an operator budget grant. Defaults to `!jid`:
	 *  background dispatches are pausable, chat dispatches keep the hard kill. */
	pausableOnCeiling?: boolean;
	/** ADR-006 Phase 2 — resume an existing Claude session with a raised ceiling
	 *  (set by the budget-approval resume path). */
	resumeSessionId?: string;
}

/** Run an agent. Streams events; the generator's return value is the final
 *  `DispatchResult`. Use `for await ... of` and the iterator-protocol return
 *  to capture both the stream and the summary in a single pass. */
export async function* dispatchAgent(
	id: string,
	task: string,
	opts: DispatchAgentOptions = {},
): AsyncGenerator<DispatchEvent, DispatchResult, void> {
	const mode: DispatchMode = opts.mode ?? 'production';
	const startedAt = Date.now();

	const agent = getAgent(id);
	if (!agent) {
		const err = `agent '${id}' not found`;
		yield { type: 'error', message: err, ts: Date.now() };
		const noAgentResult: DispatchResult = {
			runId: 'no-agent',
			agentId: id,
			backend: 'claude-pty',
			status: 'error',
			output: '',
			cost_usd: 0,
			num_turns: 0,
			duration_ms: 0,
			error: err,
		};
		// Skip persistence — no agent record to attribute the run to. The
		// caller will see status='error' in the streamed event.
		return noAgentResult;
	}

	const dispatcher = dispatchers[agent.backend];
	if (!dispatcher) {
		const err = `no dispatcher for backend '${agent.backend}'`;
		yield { type: 'error', message: err, ts: Date.now() };
		const noDispatcherResult: DispatchResult = {
			runId: 'no-dispatcher',
			agentId: id,
			backend: agent.backend,
			status: 'error',
			output: '',
			cost_usd: 0,
			num_turns: 0,
			duration_ms: 0,
			error: err,
		};
		persistRun(noDispatcherResult, agent, mode, task, startedAt, opts);
		return noDispatcherResult;
	}

	// Manual iteration (not `yield*`) so we can intercept the `started` event
	// and write a `running` row immediately — ADR-002 Layer 1 started-row
	// observability. `yield*` would forward the return value but hide events.
	const inner = dispatcher.dispatch(agent, {
		mode,
		task,
		signal: opts.signal,
		context: opts.context,
		goal_condition: opts.goal_condition,
		budget_override: opts.budget_override,
		// ADR-006 Phase 2 — background runs (no chat jid) are pausable by default;
		// an explicit flag overrides. Chat runs keep the hard kill at the ceiling.
		pausable_on_ceiling: opts.pausableOnCeiling ?? !opts.jid,
		resume_session_id: opts.resumeSessionId,
	});
	let result: DispatchResult;
	let startRowWritten = false;
	for (;;) {
		const next = await inner.next();
		if (next.done) {
			result = next.value;
			break;
		}
		const ev = next.value;
		if (ev.type === 'started' && !startRowWritten) {
			startRowWritten = true;
			try {
				startAgentRun({
					runId: ev.runId,
					agentId: agent.id,
					backend: agent.backend,
					model: agent.model,
					provider: agent.provider,
					mode,
					taskSpec: task,
					sourceMessage: opts.sourceMessage,
					jid: opts.jid,
					startedAt,
					subjectPath: opts.subjectPath,
				});
			} catch (err) {
				console.error('[agents/runs] failed to write start row:', (err as Error).message);
			}
		}
		yield ev;
	}

	finishRun(result, agent, mode, task, startedAt, opts);

	// ADR-006 Phase 2 — a pausable run that hit its ceiling is recorded as
	// `awaiting-budget-approval`; escalate to the operator's Telegram so a grant
	// can resume it. Best-effort + detached: escalation failure never affects the
	// (already-recorded) dispatch outcome.
	if (result.status === 'awaiting-budget-approval' && result.budget_pause) {
		const pause = result.budget_pause;
		void escalateBudgetApproval({
			runId: result.runId,
			agentId: agent.id,
			sessionUuid: result.claude_session_id ?? '',
			task,
			ceilingUsd: pause.ceiling_usd,
			ceilingTurns: pause.ceiling_turns,
			reason: pause.reason,
			spentUsd: result.cost_usd,
			turns: result.num_turns,
		}).catch((err) =>
			console.error('[agents/budget] escalation failed:', (err as Error).message),
		);
	}

	return result;
}

/** Close out the run: flip its `running` row to terminal status + metrics.
 *  If no open row exists (the dispatcher never emitted `started`), fall back
 *  to a full insert so the run is still recorded. */
function finishRun(
	result: DispatchResult,
	agent: AgentSummary,
	mode: DispatchMode,
	task: string,
	startedAt: number,
	opts: DispatchAgentOptions,
): void {
	try {
		const finishedAt = Date.now();
		const updated = finishAgentRun({
			runId: result.runId,
			finishedAt,
			durationMs: result.duration_ms || finishedAt - startedAt,
			status: result.status,
			costUsd: result.cost_usd,
			numTurns: result.num_turns,
			resultExcerpt: result.output,
			errorMessage: result.error,
			claudeSessionId: result.claude_session_id,
		});
		if (updated === 0) persistRun(result, agent, mode, task, startedAt, opts);
	} catch (err) {
		console.error('[agents/runs] failed to finish run:', (err as Error).message);
	}
}

function persistRun(
	result: DispatchResult,
	agent: AgentSummary,
	mode: DispatchMode,
	task: string,
	startedAt: number,
	opts: DispatchAgentOptions,
): void {
	try {
		const finishedAt = Date.now();
		recordAgentRun({
			runId: result.runId,
			agentId: agent.id,
			backend: agent.backend,
			model: agent.model,
			provider: agent.provider,
			mode,
			taskSpec: task,
			sourceMessage: opts.sourceMessage,
			jid: opts.jid,
			startedAt,
			finishedAt,
			durationMs: result.duration_ms || finishedAt - startedAt,
			status: result.status,
			costUsd: result.cost_usd,
			numTurns: result.num_turns,
			resultExcerpt: result.output,
			errorMessage: result.error,
			claudeSessionId: result.claude_session_id,
		});
	} catch (err) {
		// Persistence is best-effort — never fail a dispatch because the
		// audit log couldn't write. Surface the error in process logs so
		// it gets noticed.
		console.error('[agents/runs] failed to persist run:', (err as Error).message);
	}
}

export type { DispatchEvent, DispatchResult, DispatchMode } from './types.js';
