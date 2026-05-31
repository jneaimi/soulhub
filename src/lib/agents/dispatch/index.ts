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
import {
	recordAgentRun,
	startAgentRun,
	finishAgentRun,
	updateRunProgress,
	updateRunSessionId,
	listRunningSubjectPaths,
	derivePhase,
	cumulativeAdrSpend,
} from '../runs.js';
import { resolveAdrBudget } from './resolve-adr-budget.js';
import { resolveAdrScope, type AdrScope } from './resolve-adr-scope.js';
import { extractHandBackBlock } from '../handback.js';
import { gateStatusForDeliverable } from './deliverable-gate.js';
import { deriveHandbackFromBranch } from './gate-runner.js';
import { escalateBudgetApproval, escalateVelocityWarning, escalateOperatorInput } from '../budget-escalation.js';
import {
	provisionAgentWorktree,
	provisionAdrWorktree,
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
	/** ADR-020 P1 — phase tag for this run.  Persisted to `agent_runs.phase`
	 *  so the drawer can group runs by phase.  Conventional values: 'initial' |
	 *  'P1' | 'P2' | 'finish' | 'falsifier' | 'iterate-N'.  Descriptive, not
	 *  validated.  Endpoints (e.g. `bump-continue`) inject `'iterate-N'`;
	 *  the workbench's Re-dispatch action will inject `'finish'` (post P2). */
	phase?: string;
	/** ADR-020 P3 — bypass the per-ADR cumulative budget gate. Operator-driven
	 *  override surfaced as `?force=true` on dispatch endpoints (or the
	 *  workbench "Spend anyway" button, post-P3 UI). Logged on the run so the
	 *  override is auditable. Backward-compat: undefined = honour the gate. */
	forceOverBudget?: boolean;
	/** ADR-020 P4 — per-dispatch scope override. When set, REPLACES the ADR's
	 *  `scope:` frontmatter for THIS dispatch only (the ADR's authored scope
	 *  is untouched). Default: scope is snapshotted from the ADR at dispatch
	 *  start. Used by ad-hoc dispatches (workbench "dispatch with custom
	 *  scope", falsifier runs with different allowed paths). null = caller
	 *  explicitly disables enforcement for this run; undefined = honour ADR. */
	scope?: AdrScope | null;
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

	// ADR-020 P1 — resolve once: caller-supplied phase wins; otherwise derive
	// from prior runs of the same artifact (no priors → 'initial';
	// prior success → 'follow-up'; only failures → 'retry-N'). Without this
	// fallback the column went NULL for ~7 call sites that never injected
	// a value (chat/scheduler/hygiene/orchestrator/intent/inbox/inline-actions),
	// defeating workbench grouping and ADR-020 P3 cumulative-budget aggregation.
	// `?? undefined` normalises derive-returns-null to the optional-field shape
	// expected by AgentRunInput / AgentRunStartInput.
	const effectivePhase = opts.phase ?? derivePhase(opts.subjectPath) ?? undefined;

	// ADR-020 P4 — snapshot the dispatch scope at start time so the
	// dispatch-scope-guard.sh PreToolUse hook can look it up by claude_session_id
	// during the run.  Resolution order:
	//   1. opts.scope === null              → explicit disable (no enforcement)
	//   2. opts.scope set + non-null        → per-dispatch override
	//   3. otherwise                        → resolve from ADR's frontmatter
	//   4. ADR has no scope: block          → null (no enforcement, backward-compat)
	// Serialised to JSON for the SQLite column; the hook parses it back.
	const effectiveScope: AdrScope | null =
		opts.scope === null
			? null
			: (opts.scope ?? resolveAdrScope(opts.subjectPath, (p) => getVaultEngine()?.getNote(p)));
	const effectiveScopeJson = effectiveScope ? JSON.stringify(effectiveScope) : undefined;

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
	//
	// ADR-022 — D3 concurrent-dispatch guard.  If another `running` agent_run
	// already targets this artifact, refuse before provisioning so two dispatches
	// can't step on each other's commits in the (now-shared) worktree.  Only
	// fires when `subjectPath` is set; non-artifact dispatches are unaffected.
	if (opts.subjectPath) {
		const inFlight = listRunningSubjectPaths();
		if (inFlight.has(opts.subjectPath)) {
			const msg = `concurrent dispatch refused — another run is already in flight for ${opts.subjectPath}`;
			yield { type: 'error', message: msg, ts: Date.now() };
			return {
				runId: 'concurrent-dispatch-refused',
				agentId: id,
				backend: agent.backend,
				status: 'error',
				output: '',
				cost_usd: 0,
				num_turns: 0,
				duration_ms: 0,
				error: msg,
			};
		}
	}

	// ADR-020 P3 — Per-ADR cumulative budget gate.  Sums `cost_usd` across all
	// terminal runs of `subjectPath` and refuses fresh dispatch when the cap
	// (set on the ADR via `dispatch_budget_usd: number` frontmatter) would be
	// exceeded by THIS run's nominal `max_usd`.  Backward-compatible: ADRs
	// without `dispatch_budget_usd` skip the gate entirely.  Operator override
	// via `opts.forceOverBudget` (surfaced as `?force=true` on dispatch
	// endpoints) bypasses + logs an audit trail.
	//
	// Composes with ADR-006 per-run budgets: a single run can still pause +
	// bump-continue at its OWN ceiling, but if ADR-cumulative is already past
	// the cap the bump-continue itself refuses on entry.
	if (opts.subjectPath && !opts.forceOverBudget) {
		const adrCap = resolveAdrBudget(opts.subjectPath, (p) => getVaultEngine()?.getNote(p));
		if (adrCap !== undefined) {
			const cumulative = cumulativeAdrSpend(opts.subjectPath);
			// Use the resolved per-run max: override beats agent default.
			const thisRunMax = opts.budget_override?.max_usd ?? agent.budget?.max_usd ?? 0;
			const projected = cumulative + thisRunMax;
			if (projected > adrCap) {
				const msg =
					`per-ADR budget refused — ${opts.subjectPath} cumulative ` +
					`$${cumulative.toFixed(2)} + this run's max $${thisRunMax.toFixed(2)} ` +
					`= $${projected.toFixed(2)} > cap $${adrCap.toFixed(2)}. ` +
					`Raise dispatch_budget_usd on the ADR or pass forceOverBudget=true to override.`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return {
					runId: 'adr-budget-refused',
					agentId: id,
					backend: agent.backend,
					status: 'error',
					output: '',
					cost_usd: 0,
					num_turns: 0,
					duration_ms: 0,
					error: msg,
				};
			}
		}
	}

	let effectiveTask = task;
	// R5 fix (2026-05-30) — hoist worktree cwd so it can be passed to the
	// backend dispatcher. Previously `wt` lived only inside the try block, so
	// the PTY spawn fell through to its hardcoded `config.resolved.vaultDir`
	// and run 524 sat idle for 22min with cwd=vault.
	let effectiveCwd: string | undefined;
	if (effectiveRepo) {
		try {
			let wt: AgentWorktree;
			if (opts.resumeSessionId && opts.resumeBranch) {
				wt = await provisionResumeWorktree(effectiveRepo, opts.resumeBranch);
				console.log(
					`[agents/worktree] ${agent.id} → resume ${wt.branch} @ ${wt.worktreePath}`,
				);
			} else if (opts.subjectPath) {
				// ADR-022 — default for any vault-artifact dispatch: ADR-keyed worktree.
				// Idempotent — subsequent dispatches against the same ADR re-enter the
				// same worktree on the same branch, so the agent sees the previous
				// dispatch's commits at HEAD without explicit operator routing.
				wt = await provisionAdrWorktree(effectiveRepo, opts.subjectPath);
				console.log(`[agents/worktree] ${agent.id} → adr ${wt.branch} @ ${wt.worktreePath}`);
			} else {
				// Non-artifact dispatches (orchestrator background jobs, CLI tests):
				// keep the per-run isolation since there's no ADR to key on.
				wt = await provisionAgentWorktree(effectiveRepo, `run-${startedAt}`, opts.subjectPath);
				console.log(`[agents/worktree] ${agent.id} → ${wt.branch} @ ${wt.worktreePath}`);
			}
			effectiveTask = worktreeDirective(wt) + task;
			effectiveCwd = wt.worktreePath;
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
		// R5 fix — PTY spawn cwd. Undefined for non-artifact dispatches; the
		// backend falls back to its historical default (vaultDir for claude-pty).
		cwd: effectiveCwd,
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
					// ADR-020 P1 — phase tag: caller wins (bump-continue injects
					// 'iterate-N'; Re-dispatch injects 'finish'); otherwise
					// derived from prior runs of this subject_path so the column
					// populates even when the call site didn't think to label.
					phase: effectivePhase,
					// ADR-020 P4 — JSON-serialised scope snapshot. The
					// dispatch-scope-guard.sh PreToolUse hook reads this back by
					// claude_session_id to refuse out-of-scope writes mid-run.
					scopeJson: effectiveScopeJson,
				});
				// ADR-020 P4 — claude-pty surfaces the session UUID at start
				// (not just finish). Stamp it on the running row immediately so
				// the PreToolUse hook can join on a real value rather than NULL.
				// Backward-compat: other backends omit claudeSessionId from the
				// event; updateRunSessionId is a no-op when arg is undefined.
				if (ev.claudeSessionId) {
					try {
						updateRunSessionId(ev.runId, ev.claudeSessionId);
					} catch (err) {
						console.error(
							'[agents/runs] failed to stamp claude_session_id at start:',
							(err as Error).message,
						);
					}
				}
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
				// 2026-05-30 — forward the subject path so the Telegram body can
				// show ADR cumulative spend vs the per-ADR dispatch_budget_usd cap.
				// Operator decides on a tap with full per-ADR context, not just
				// the per-dispatch numbers.
				subjectPath: opts.subjectPath,
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
			// Bug fix 2026-05-29 — capture the artifact + repo at pause time
			// so `resumeWithRaisedBudget` can forward them to dispatchAgent on
			// the Telegram-approval resume path. Without this, the resumed
			// dispatch ran with subjectPath=undefined → start row subject_path
			// NULL → ADR-022 D3 missed the in-flight run → concurrent dispatch
			// leak (witnessed: run 0f885fb0 paused, df910cef sailed through).
			// Also: no subjectPath meant no project repo lookup, so the
			// resumed PTY ran in cwd=vault instead of the per-ADR worktree.
			subjectPath: opts.subjectPath,
			repo: effectiveRepo ?? undefined,
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
			// ADR-020 P1 — same phase tag the start row would have written.
			// Re-derive here (vs. threading `effectivePhase` through 4 call sites)
			// because this path fires only when the `started` event never emitted
			// — at most once per dispatch, on early failure paths.
			phase: opts.phase ?? derivePhase(opts.subjectPath) ?? undefined,
			// ADR-020 P4 — same scope snapshot the start row would have written.
			// On the early-failure path, no tool_use ever fires so this is a
			// belt-and-braces audit value — preserves the scope-at-dispatch-time
			// even when no enforcement happens.
			scopeJson:
				opts.scope === null
					? undefined
					: opts.scope
						? JSON.stringify(opts.scope)
						: (() => {
								const s = resolveAdrScope(opts.subjectPath, (p) =>
									getVaultEngine()?.getNote(p),
								);
								return s ? JSON.stringify(s) : undefined;
							})(),
		});
	} catch (err) {
		// Persistence is best-effort — never fail a dispatch because the
		// audit log couldn't write. Surface the error in process logs so
		// it gets noticed.
		console.error('[agents/runs] failed to persist run:', (err as Error).message);
	}
}

export type { DispatchEvent, DispatchResult, DispatchMode } from './types.js';
