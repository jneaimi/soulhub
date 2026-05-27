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
import { recordAgentRun, startAgentRun, finishAgentRun, updateRunProgress } from '../runs.js';
import { extractHandBackBlock } from '../handback.js';
import { gateStatusForDeliverable } from './deliverable-gate.js';
import { deriveHandbackFromBranch } from './gate-runner.js';
import { escalateBudgetApproval, escalateVelocityWarning, escalateOperatorInput } from '../budget-escalation.js';
import {
	provisionAgentWorktree,
	provisionResumeWorktree,
	worktreeDirective,
	type AgentWorktree,
} from './worktree-provision.js';
import { resolveProjectRepo } from './resolve-project-repo.js';
import { getVaultEngine } from '../../vault/index.js';

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
	/** ADR-024 D2 — branch name of the existing worktree to resume in.
	 *  When set alongside `resumeSessionId`, skips fresh worktree provisioning
	 *  and re-uses (or adds) the worktree for this branch. */
	resumeBranch?: string;
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

	// ADR-030 — derive the worktree repo from the artifact's project first,
	// falling back to the agent's static `repo`. Projects that have no `repo`
	// frontmatter on their `index.md` return `undefined`, keeping behaviour
	// identical to pre-ADR-030 (the agent's own `repo` is used, exactly as
	// ADR-010 specified). Nothing changes until a project opts in.
	const effectiveRepo =
		resolveProjectRepo(opts.subjectPath, (p) => getVaultEngine()?.getNote(p)) ??
		agent.repo;

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
		await persistRun(noDispatcherResult, agent, mode, task, startedAt, opts, effectiveRepo);
		return noDispatcherResult;
	}

	// ADR-010 (soul-hub-agents) — repo-scoped agents run in an isolated git
	// worktree, provisioned HERE before spawn. The hardened claude-pty spawn
	// path is unchanged (still vaultDir); we cd the agent into the worktree via
	// a task directive. Gated on `effectiveRepo` (ADR-030: project repo or
	// agent repo fallback), so the vault/clerical agents are entirely unaffected.
	// Provisioning failure aborts before spawn.
	//
	// ADR-024 D2 — resume path: when both `resumeSessionId` + `resumeBranch`
	// are set, skip fresh provisioning and re-use the existing branch's worktree
	// via `provisionResumeWorktree`. The non-resume path is unchanged.
	let effectiveTask = task;
	if (effectiveRepo) {
		try {
			let wt: AgentWorktree;
			if (opts.resumeSessionId && opts.resumeBranch) {
				wt = await provisionResumeWorktree(effectiveRepo, opts.resumeBranch);
				console.log(
					`[agents/worktree] ${agent.id} → resume ${wt.branch} @ ${wt.worktreePath}`,
				);
			} else {
				wt = await provisionAgentWorktree(effectiveRepo, `run-${startedAt}`, opts.subjectPath);
				console.log(`[agents/worktree] ${agent.id} → ${wt.branch} @ ${wt.worktreePath}`);
			}
			effectiveTask = worktreeDirective(wt) + task;
		} catch (err) {
			const msg = `worktree provisioning failed: ${(err as Error).message}`;
			yield { type: 'error', message: msg, ts: Date.now() };
			const provFailResult: DispatchResult = {
				runId: 'no-worktree',
				agentId: id,
				backend: agent.backend,
				status: 'error',
				output: '',
				cost_usd: 0,
				num_turns: 0,
				duration_ms: 0,
				error: msg,
			};
			await persistRun(provFailResult, agent, mode, task, startedAt, opts, effectiveRepo);
			return provFailResult;
		}
	}

	// Manual iteration (not `yield*`) so we can intercept the `started` event
	// and write a `running` row immediately — ADR-002 Layer 1 started-row
	// observability. `yield*` would forward the return value but hide events.
	const inner = dispatcher.dispatch(agent, {
		mode,
		task: effectiveTask,
		signal: opts.signal,
		context: opts.context,
		goal_condition: opts.goal_condition,
		budget_override: opts.budget_override,
		// ADR-006 Phase 2 — background runs (no chat jid) are pausable by default;
		// an explicit flag overrides. Chat runs keep the hard kill at the ceiling.
		pausable_on_ceiling: opts.pausableOnCeiling ?? !opts.jid,
		resume_session_id: opts.resumeSessionId,
		// ADR-024 D2 — forwarded for completeness; worktree selection already
		// handled above in the provisioning block.
		resume_branch: opts.resumeBranch,
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
					// ADR-031 P1 — persist the dispatch-time repo so ship-merge and
					// review-handoff can route git to the run's actual repo. Null for
					// agents without a bound repo (legacy behaviour unchanged).
					repo: effectiveRepo ?? undefined,
				});
			} catch (err) {
				console.error('[agents/runs] failed to write start row:', (err as Error).message);
			}
		}
		// ADR-006 Phase 3 — velocity warning fires mid-run: escalate to Telegram so
		// the operator can raise the ceiling in-flight (a tap writes a live grant
		// the dispatch loop adopts). Detached — never block the event stream.
		if (ev.type === 'budget_warning') {
			void escalateVelocityWarning({
				runId: ev.runId,
				agentId: agent.id,
				sessionUuid: ev.sessionUuid,
				ceilingUsd: ev.ceilingUsd,
				ceilingTurns: ev.ceilingTurns,
				reason: ev.reason,
				spentUsd: ev.spentUsd,
				turns: ev.turns,
			}).catch((err) =>
				console.error('[agents/budget] velocity warning failed:', (err as Error).message),
			);
		}
		// ADR-026 P3 — live cost/turns: persist every progress tick into the
		// `running` DB row so the board chip shows real numbers mid-run.
		// Best-effort + sync (SQLite UPDATE is fast; no await needed).
		else if (ev.type === 'progress') {
			try {
				updateRunProgress(ev.runId, { costUsd: ev.costUsd, numTurns: ev.numTurns });
			} catch (e) {
				console.error('[agents] progress update failed:', (e as Error).message);
			}
		}
		yield ev;
	}

	await finishRun(result, agent, mode, task, startedAt, opts, effectiveRepo);

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

	// ADR-026 P2 — agent emitted an ask_operator sentinel; notify the operator.
	// The resume path is unchanged — the operator's answer rides back in as
	// the send-back `task` on `--resume`. Best-effort + detached.
	if (result.status === 'awaiting-operator-input' && result.operator_pause) {
		void escalateOperatorInput({
			runId: result.runId,
			agentId: agent.id,
			question: result.operator_pause.question,
		}).catch((err) =>
			console.error('[agents/budget] operator-input escalation failed:', (err as Error).message),
		);
	}

	return result;
}

/** soul-hub-agents ADR-016 — resolve the hand-back to persist for a finished
 *  run. Normally the agent's own trailer (extracted from output). When a
 *  success-like production *coding* dispatch committed a branch but emitted NO
 *  trailer, re-run the gates server-side and synthesize one, so the review card
 *  hydrates from ground truth instead of staying blank (the soul-hub-chat
 *  ADR-002 run #490 symptom). Best-effort: derivation failure leaves the
 *  hand-back undefined and the committed-branch deliverable gate behaves
 *  exactly as before this ADR. */
async function resolveHandback(
	result: DispatchResult,
	mode: DispatchMode,
	opts: DispatchAgentOptions,
	startedAt: number,
	effectiveRepo: string | undefined,
): Promise<string | undefined> {
	const fromAgent = extractHandBackBlock(result.output) ?? undefined;
	if (fromAgent) return fromAgent;
	const successLike = result.status === 'success' || result.status === 'goal_achieved';
	if (!successLike || mode !== 'production' || !effectiveRepo || !opts.subjectPath) return undefined;
	try {
		const derived = await deriveHandbackFromBranch({
			repo: effectiveRepo,
			startedAt,
			subjectPath: opts.subjectPath,
		});
		if (derived) {
			console.log(
				`[agents/gate-runner] auto-derived hand-back for run ${result.runId} ` +
					`(agent emitted none) — review card will hydrate from re-run gates`,
			);
		}
		return derived ?? undefined;
	} catch (e) {
		console.error('[agents/gate-runner] auto-derive failed:', (e as Error).message);
		return undefined;
	}
}

/** Close out the run: flip its `running` row to terminal status + metrics.
 *  If no open row exists (the dispatcher never emitted `started`), fall back
 *  to a full insert so the run is still recorded. */
async function finishRun(
	result: DispatchResult,
	agent: AgentSummary,
	mode: DispatchMode,
	task: string,
	startedAt: number,
	opts: DispatchAgentOptions,
	/** ADR-030 — effective repo (project repo ?? agent.repo) resolved at dispatch
	 *  time. Passed in so `gateStatusForDeliverable` uses the project-bound repo
	 *  rather than the agent's static `repo` when the artifact's project opts in. */
	effectiveRepo: string | undefined,
): Promise<void> {
	try {
		const finishedAt = Date.now();
		// ADR-026 D3 — extract the raw hand-back block from the full output so
		// the review card can parse gate_results/summary/follow_ups even when the
		// full output exceeds the 800-char result_excerpt limit.
		// soul-hub-agents ADR-016 — if the agent committed but emitted no trailer,
		// `resolveHandback` re-runs the gates against the branch and synthesizes one.
		const handback = await resolveHandback(result, mode, opts, startedAt, effectiveRepo);
		// ADR-012 P1 — downgrade a success-like coding dispatch that left no
		// reviewable artifact (no hand-back + no committed branch) so it doesn't
		// silently fall back to ready_for_ai.
		const status = gateStatusForDeliverable({
			rawStatus: result.status,
			handback,
			mode,
			repo: effectiveRepo,
			subjectPath: opts.subjectPath,
			startedAt,
		});
		const updated = finishAgentRun({
			runId: result.runId,
			finishedAt,
			durationMs: result.duration_ms || finishedAt - startedAt,
			status,
			costUsd: result.cost_usd,
			numTurns: result.num_turns,
			resultExcerpt: result.output,
			errorMessage: result.error,
			claudeSessionId: result.claude_session_id,
			handback,
		});
		if (updated === 0) await persistRun(result, agent, mode, task, startedAt, opts, effectiveRepo);
	} catch (err) {
		console.error('[agents/runs] failed to finish run:', (err as Error).message);
	}
}

async function persistRun(
	result: DispatchResult,
	agent: AgentSummary,
	mode: DispatchMode,
	task: string,
	startedAt: number,
	opts: DispatchAgentOptions,
	/** ADR-030 — effective repo (project repo ?? agent.repo) resolved at dispatch
	 *  time. Passed in so `gateStatusForDeliverable` uses the project-bound repo
	 *  rather than the agent's static `repo` when the artifact's project opts in. */
	effectiveRepo: string | undefined,
): Promise<void> {
	try {
		const finishedAt = Date.now();
		// ADR-026 D3 — same extraction as finishRun; this path is the fallback
		// insert when no `running` row was ever written (no `started` event).
		// soul-hub-agents ADR-016 — same auto-derive as finishRun (committed
		// branch + no trailer → re-run gates and synthesize the hand-back).
		const handback = await resolveHandback(result, mode, opts, startedAt, effectiveRepo);
		// ADR-012 P1 — same deliverable-gating as finishRun (fallback insert path).
		const status = gateStatusForDeliverable({
			rawStatus: result.status,
			handback,
			mode,
			repo: effectiveRepo,
			subjectPath: opts.subjectPath,
			startedAt,
		});
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
			status,
			costUsd: result.cost_usd,
			numTurns: result.num_turns,
			resultExcerpt: result.output,
			errorMessage: result.error,
			claudeSessionId: result.claude_session_id,
			handback,
			// ADR-031 P1 — fallback insert path: same repo as the dispatch-start row
			// would have written (used when the `started` event was never emitted).
			repo: effectiveRepo ?? undefined,
		});
	} catch (err) {
		// Persistence is best-effort — never fail a dispatch because the
		// audit log couldn't write. Surface the error in process logs so
		// it gets noticed.
		console.error('[agents/runs] failed to persist run:', (err as Error).message);
	}
}

export type { DispatchEvent, DispatchResult, DispatchMode } from './types.js';
