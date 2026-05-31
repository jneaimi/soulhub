/**
 * Lane A1 dispatcher — interactive Claude Code session over a PTY.
 *
 * Reuses `src/lib/pty/manager.ts` (`spawnSession`/`killSession`), which
 * handles workspace-trust prompts, prompt injection, and ANSI stripping.
 * On top of that we add:
 *   - **`--agent <id>` profile loading** so Claude Code pulls
 *     `system_prompt` from `~/.claude/agents/<id>.md` itself. Pre-pasting
 *     a >100-line system prompt as user input fragments into multiple
 *     `[Pasted text #N]` preview blocks that never auto-confirm — the
 *     agent stalls in the splash and never executes (see learning
 *     `2026-05-06-pty-paste-stall-and-agent-flag`). Typed input now
 *     stays short: just conversation context + the task.
 *   - **Adaptive stall detection** — `STALL_MS_DEFAULT` (30s) is fine for
 *     chat-shaped agents but too tight for tool-call-heavy work (image
 *     gen, web fetch). `resolveStallMs(budget)` scales to `timeout_ms/8`
 *     up to `STALL_MS_MAX` (120s).
 *   - Hard timeout from the resolved budget.
 *   - MCP isolation flags so the agent can't trip user-scoped auth prompts.
 *
 * Test mode delegates to `claude -p --agent <id>` for a clean text reply.
 * The agent definition lives in the same `.md` file in Lane A, so the test
 * exercises the same prompt; we just bypass the interactive TUI rendering
 * because chat-to-test users want readable output, not ANSI-coloured status
 * bars. Production dispatches still use the PTY path for parallel safety.
 *
 * Production v1 ships without worktree isolation; the agent runs in vaultDir
 * and writes there. Code-writing agents stay in the orchestration engine
 * until ADR-001's worktree mode lands.
 */

import { spawnSession, killSession } from '$lib/pty/manager.js';
import { config } from '$lib/config.js';
import type { AgentSummary } from '../types.js';
import type { BackendDispatcher, DispatchEvent, DispatchOptions, DispatchResult } from './types.js';
import { resolveBudget } from './budget.js';
import { claudeCliFlagDispatcher } from './claude-cli-flag.js';
import { loadAgentRunRecord } from '$lib/sessions/run-record.js';
import { createRunTail, type RunTail } from '$lib/sessions/run-tail.js';
import { getLiveGrant, clearLiveGrant } from '../budget-grants.js';
import { parseAskOperator, extractAskOperatorFromTranscript } from './ask-operator.js';
import { locateTranscript } from '$lib/sessions/run-record.js';
import { projectsAtCeiling } from './velocity-projection.js';

export { parseAskOperator } from './ask-operator.js';

/** Default silence-after-activity threshold before treating the session as
 *  done. 30s is fine for chat-shaped agents that emit progress text every
 *  few seconds; tool-call-heavy agents (image gen, web fetch) can sit idle
 *  for 30-60s on a single API call. Scaled per-agent below by
 *  `resolveStallMs(budget)` so a 600s-budget agent gets 75s before stall. */
const STALL_MS_DEFAULT = 30_000;
/** Cap on the scaled stall — past this, stall starts overlapping the hard
 *  timeout and we'd never preempt a genuinely stuck session. */
const STALL_MS_MAX = 120_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** ADR-031 v3 — Claude Code's TUI emits this marker when `/goal <condition>`
 *  has been satisfied. v1 assumed the agent would also emit our standard
 *  trailer (`✅ done`, `⚠️ partial`) so the existing stall-based termination
 *  would catch it. Live validation 2026-05-13 showed otherwise: the agent
 *  posts ONLY the TUI marker, then sits in the input prompt with the
 *  status-line spinner still animating — which keeps `lastActivity` fresh
 *  and prevents the stall timer from firing. Result: every goal-mode run
 *  burned its full budget even when convergence happened in 1/8 of it.
 *
 *  The capture group is the metrics tail — variations observed:
 *    Goal achieved (29s · 1 turn · 861 tokens)
 *    Goal achieved (7m ·1 turn · 22.9k tokens) (ctrl+o to expand)
 *    Goal achieved (1h 23m · 14 turns · 187k tokens)
 *  Spacing around the bullet is unreliable; the format() helper parses
 *  the captured string with looser sub-patterns. */
const GOAL_ACHIEVED_RE = /Goal achieved\s*\(([^)]+)\)/i;
/** Grace window after the achievement marker fires. Lets any final byte
 *  in flight (the parenthetical `(ctrl+o to expand)`, the input-prompt
 *  redraw) flush into the buffer before we kill the session. Tuned short
 *  because the marker is itself the terminal signal — anything after is
 *  scenery, not content. */
const GOAL_GRACE_MS = 1500;


function resolveStallMs(timeoutMs: number): number {
	const scaled = Math.floor(timeoutMs / 8);
	return Math.min(STALL_MS_MAX, Math.max(STALL_MS_DEFAULT, scaled));
}

export const claudePtyDispatcher: BackendDispatcher = {
	id: 'claude-pty',

	async *dispatch(
		agent: AgentSummary,
		opts: DispatchOptions,
	): AsyncGenerator<DispatchEvent, DispatchResult, void> {
		// Chat-to-test runs route through headless `claude -p` so the user sees
		// the agent's actual reply, not the full TUI. Same Max auth, same agent
		// definition file, same backend identity in the result envelope.
		//
		// `oneshot` is the production sibling of `test`: same cli-flag backend
		// (no PTY, no /goal loop), but budget caps are NOT applied (resolved in
		// budget.ts). For agents that are structurally single-pass and need
		// real production budgets — see DispatchMode docstring in types.ts.
		if (opts.mode === 'test' || opts.mode === 'oneshot') {
			const result = yield* claudeCliFlagDispatcher.dispatch(agent, opts);
			return { ...result, backend: 'claude-pty' };
		}

		// ADR-002 Layer 1 — set a deterministic Claude session id so the
		// transcript is locatable at finish. `runId` stays the 8-char prefix
		// for display continuity; the full UUID is what `--session-id` needs.
		// ADR-006 Phase 2 — on resume, reuse the prior session UUID: Claude Code
		// appends to the SAME `<uuid>.jsonl` (verified spike), so run-tail keeps
		// summing cost + turns across the resume seam when it tails from offset 0.
		const resuming = !!opts.resume_session_id;
		const sessionUuid = opts.resume_session_id ?? crypto.randomUUID();
		const runId = sessionUuid.slice(0, 8);
		const started = Date.now();
		// ADR-006 Phase 2 — pause-on-ceiling. The caller (index.ts) decides this
		// from the dispatch context: background runs (no chat jid) are pausable;
		// chat runs keep the hard kill since the operator is already present.
		const pausable = opts.pausable_on_ceiling === true;
		// ADR-005 — per-call budget override (Naseej recipe step). Shallow merge:
		// any field set on `opts.budget_override` shadows the agent default;
		// undefined fields fall through to `agent.budget`, which itself falls
		// through to `PRODUCTION_DEFAULTS` inside `resolveBudget`.
		// ADR-006 — the ceiling overrides ride the same merge so the resume path
		// can raise the hard ceiling for a granted run.
		const mergedBudget = opts.budget_override
			? {
					max_usd: opts.budget_override.max_usd ?? agent.budget?.max_usd,
					max_turns: opts.budget_override.max_turns ?? agent.budget?.max_turns,
					timeout_sec: opts.budget_override.timeout_sec ?? agent.budget?.timeout_sec,
					ceiling_usd: opts.budget_override.ceiling_usd ?? agent.budget?.ceiling_usd,
					ceiling_turns: opts.budget_override.ceiling_turns ?? agent.budget?.ceiling_turns,
				}
			: agent.budget;
		const budget = resolveBudget(opts.mode, mergedBudget);
		const stallMs = resolveStallMs(budget.timeout_ms);

		// ADR-031 — goal-mode: when the agent's frontmatter sets a
		// `goal_condition`, the dispatcher sends `/goal <condition>` into
		// the PTY FIRST (so Claude Code's session manager picks up the
		// convergence directive), then injects the task as a second turn
		// after a short wait for the "Goal set:" acknowledgment. The
		// `prompt_sent` event from spawnSession fires after the FIRST
		// injection; we use it as the cue to schedule the second.
		// ADR-005 — per-call override wins over the agent default so Naseej
		// recipe steps can specialise convergence per invocation.
		const goalCondition = (opts.goal_condition ?? agent.goal_condition)?.trim();
		const goalActive = !!goalCondition;
		// ADR-004 — live transcript-driven termination + honest status + budget
		// caps (D2/D3/D4). ON by default; set PTY_LIVE_TRANSCRIPT=0 to fall back
		// to the legacy idle-stall path. Scoped to non-goal agents: goal-mode
		// emits `end_turn` every iteration, so it keeps the `Goal achieved` marker
		// as its termination signal (it still reports transcript cost/turns).
		const liveTail = process.env.PTY_LIVE_TRANSCRIPT !== '0' && !goalActive;
		// ADR-026 follow-up — tail the transcript for COST/TURNS on ALL backends
		// (goal-mode included) so the board chip shows live progress. This is
		// decoupled from `liveTail`: `liveTail` still gates streaming + live
		// termination/budget kills (which stay non-goal-only); `transcriptTail`
		// only governs whether a `runTail` exists to read cost from.
		const transcriptTail = process.env.PTY_LIVE_TRANSCRIPT !== '0';
		const taskPayload = composePrompt(opts.task, opts.context);
		const initialPrompt = goalActive ? `/goal ${goalCondition}` : taskPayload;

		const model = agent.model || 'sonnet';

		let session;
		try {
			session = spawnSession({
				prompt: initialPrompt,
				agentId: agent.id, // Claude Code loads system_prompt from ~/.claude/agents/<id>.md
				// R5 fix (2026-05-30) — use the provisioned worktree cwd when set
				// (artifact dispatches), fall back to vaultDir otherwise. Before
				// this fix, ALL dispatches launched the PTY in vault and relied on
				// the agent to self-`cd` via the worktreeDirective in the prompt;
				// failure mode was silent (run 524: 22 min, $0 of new work, all
				// tool calls failed because relative paths didn't resolve).
				cwd: opts.cwd ?? config.resolved.vaultDir,
				shell: false,
				model,
				// ADR-006 Phase 2 — resume reuses the session via `--resume <id>`
				// (mutually exclusive with `--session-id`); a fresh run sets a
				// deterministic `--session-id` so its transcript is locatable.
				claudeSessionId: resuming ? undefined : sessionUuid,
				resumeSessionId: resuming ? sessionUuid : undefined,
				// Dispatched agents are leaf workers by default — deny the sub-agent
				// dispatch tool so they do the work themselves instead of delegating.
				// An `--agent <id>` session also sees `<id>` as a callable sub-agent
				// (Claude Code auto-discovers ~/.claude/agents/), so without this the
				// analyst spawns itself and the work hides in a sidechain.
				// Orchestrator agents opt in via `allow_subagents` to KEEP Task/Agent —
				// they fan out to named sub-agents (parallel, mixed models) and must
				// summarise the results into their own final response.
				extraArgs: [
					'--strict-mcp-config',
					'--mcp-config',
					'{"mcpServers":{}}',
					...(agent.allow_subagents ? [] : ['--disallowedTools', 'Task,Agent']),
				],
			});
		} catch (err) {
			const msg = (err as Error).message;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', msg, { claude_session_id: sessionUuid });
		}

		yield {
			type: 'started',
			backend: 'claude-pty',
			model,
			runId,
			ts: started,
			// ADR-020 P4 — surface the session UUID at start (not just finish)
			// so the dispatcher can persist it on the running row, giving
			// dispatch-scope-guard.sh a stable join key for the PreToolUse hook.
			claudeSessionId: sessionUuid,
		};
		if (goalActive) {
			console.log(
				`[agents/claude-pty] goal-mode active for ${agent.id}: "${goalCondition!.slice(0, 80)}${goalCondition!.length > 80 ? '…' : ''}"`,
			);
		}

		// ADR-004 D1 — begin tailing this run's transcript live (the
		// `--session-id` set on spawn makes it locatable immediately).
		// R5 fix — Claude saves the transcript under ~/.claude/projects/
		// <encoded-cwd>/<session>.jsonl, where encoded-cwd is the cwd at PTY
		// launch. The tail MUST use the same cwd or it reads nothing and the
		// live cost/turns chips stay zero (silent regression).
		let runTail: RunTail | undefined;
		if (transcriptTail) {
			runTail = createRunTail(sessionUuid, {
				cwd: opts.cwd ?? config.resolved.vaultDir,
			});
			console.log(
				`[agents/claude-pty] transcript tail active for ${agent.id}` +
					`${liveTail ? ' (live termination + budget)' : ' (cost/turns only — goal-mode)'}`,
			);
		}

		// Buffer stdout chunks and a stripped accumulator for the final result.
		const queue: string[] = [];
		let combined = '';
		let lastActivity = Date.now();
		let exited = false;
		let exitCode: number | null = null;
		let promptInjected = false;
		// ADR-031 v3 — goal-achieved detection. Set when GOAL_ACHIEVED_RE
		// matches the stripped output stream. Holds the captured metrics
		// tail so we can extract num_turns + token count for the result
		// envelope. The grace timer kills the session GOAL_GRACE_MS after
		// the marker so any trailing TUI bytes (the `(ctrl+o to expand)`
		// hint, the redrawn input prompt) flush into `combined`.
		let goalAchieved = false;
		let goalMetricsRaw: string | undefined;
		let goalGraceTimer: ReturnType<typeof setTimeout> | undefined;
		// ADR-026 P2 — ask-operator detection. Set when the transcript scan
		// finds the sentinel in an assistant text block. Non-null → session
		// is killed immediately (agent is blocked waiting for input).
		// ADR-019 P1 — detection moved from raw PTY scan (onOutput) to the
		// 200ms poll loop, reading the JSONL transcript instead of stripped
		// scrollback.  This eliminates the tool-use self-trigger trap.
		let operatorQuestion: string | null = null;
		// ADR-019 P1 — cached transcript path; avoids repeated filesystem scans
		// in the poll loop. Set to non-null once locateTranscript finds the file.
		let resolvedTranscriptPath: string | null = null;

		const onOutput = (data: string) => {
			lastActivity = Date.now();
			queue.push(data);
			combined += data;
			if (goalActive && !goalAchieved) {
				// Scan the accumulator (not just this chunk) — the marker
				// can straddle chunk boundaries, and the TUI is rendered
				// in many small writes. Match against the stripped form
				// so ANSI cursor moves around the line don't defeat the
				// regex.
				const m = GOAL_ACHIEVED_RE.exec(stripAnsi(combined));
				if (m) {
					goalAchieved = true;
					goalMetricsRaw = m[1].trim();
					console.log(
						`[agents/claude-pty] goal achieved for ${agent.id}: (${goalMetricsRaw}) — settling for ${GOAL_GRACE_MS}ms then closing`,
					);
					goalGraceTimer = setTimeout(() => {
						if (!exited) killSession(session.id);
					}, GOAL_GRACE_MS);
				}
			}
			// ADR-019 P1 — ask-operator detection was moved OUT of onOutput and
			// into the poll loop below.  It now reads the JSONL transcript so
			// tool_use payloads (e.g. an Edit writing the ASK_OPERATOR protocol
			// docs) can't self-trigger the sentinel.  No action here.
		};
		const onExit = (code: number) => {
			exited = true;
			exitCode = code;
		};
		const onPromptSent = () => {
			promptInjected = true;
			lastActivity = Date.now();
		};

		session.emitter.on('output', onOutput);
		session.emitter.on('exit', onExit);
		session.emitter.on('prompt_sent', onPromptSent);

		// ADR-031 — second-stage injection. Once spawnSession has typed
		// `/goal <condition>` and Enter, wait briefly for Claude Code to
		// acknowledge the goal (TUI prints "Goal set: …"), then write the
		// task as a fresh turn. If the session already exited (unlikely
		// in 1.5s) we no-op. The 1500ms is empirical — `/goal` registers
		// near-instantly in v2.1.139 but the TUI's input box needs a tick
		// to settle before accepting the next message.
		const goalTimers: { taskWrite?: ReturnType<typeof setTimeout>; enterWrite?: ReturnType<typeof setTimeout> } = {};
		if (goalActive) {
			session.emitter.once('prompt_sent', () => {
				goalTimers.taskWrite = setTimeout(() => {
					if (exited) return;
					session.pty.write(taskPayload);
					goalTimers.enterWrite = setTimeout(() => {
						if (!exited) session.pty.write('\r');
					}, 200);
				}, 1500);
			});
		}

		const onAbort = () => {
			killSession(session.id);
		};
		opts.signal?.addEventListener('abort', onAbort);

		try {
			let stalled = false;
			let timedOut = false;
			let transcriptDone = false;
			let budgetExceeded: 'max_turns' | 'max_usd' | null = null;
			// ADR-006 tier 1 — the soft cap is now an informational checkpoint, not
			// a kill. Latch so we log the crossing once; the run auto-extends to the
			// hard ceiling (the "auto-approve band": a near-done run isn't discarded
			// one turn short of its answer).
			let softCapLatched = false;
			// ADR-006 Phase 3 — the hard ceilings are MUTABLE: a live grant (operator
			// pre-approval from a velocity warning) raises them in-flight so the run
			// continues uninterrupted. `velocityWarned` latches the early warning,
			// re-armed after a raise so a second approach can warn again.
			let ceilingUsd = budget.ceiling_usd;
			let ceilingTurns = budget.ceiling_turns;
			let velocityWarned = false;
			// ADR-026 P3 — live progress dedup: only emit a `progress` event when
			// cost or turns actually changed since the last tick. Avoids flooding
			// index.ts with identical updates on idle ticks (200ms loop).
			let lastProgCost = -1;
			let lastProgTurns = -1;

			while (!exited) {
				if (liveTail && runTail) {
					// ADR-004 D5 — emit clean structured progress from the transcript
					// (tool_call / step) instead of raw ANSI. The scrollback chunks
					// still accrue in `combined` (via onOutput) as the fallback output
					// source; we just don't stream them.
					for (const p of runTail.drain()) {
						if (p.kind === 'tool') yield { type: 'tool_call', name: p.name, ts: p.ts };
						else yield { type: 'step', n: p.n, finishReason: p.finishReason, ts: p.ts };
					}
					queue.length = 0;
				} else {
					while (queue.length > 0) {
						const chunk = queue.shift()!;
						yield { type: 'output', data: chunk, ts: Date.now() };
					}
				}

				const elapsed = Date.now() - started;
				const idle = Date.now() - lastActivity;

				if (elapsed >= budget.timeout_ms) {
					timedOut = true;
					killSession(session.id);
					break;
				}
				// ADR-004 D2/D4 — consult the live transcript: terminate the instant
				// the last turn ended cleanly (D2), or enforce the turn / cost caps
				// the PTY path never had (D4). A clean finish wins over a cap hit —
				// an agent that lands its answer ON the last allowed turn succeeded.
				if (runTail) {
					const snap = runTail.snapshot();
					// ADR-026 P3 — emit a `progress` event whenever cost or turns
					// changed since the last loop tick. Additive yield only — no
					// control-flow change. index.ts persists these into the `running`
					// DB row so the board chip shows live cost/turns mid-run.
					const sc = snap.costUsd ?? 0;
					if (sc !== lastProgCost || snap.turns !== lastProgTurns) {
						lastProgCost = sc;
						lastProgTurns = snap.turns;
						yield { type: 'progress' as const, runId, costUsd: sc, numTurns: snap.turns, ts: Date.now() };
					}
					// ADR-021 — budget enforcement is decoupled from `liveTail`.  Goal-mode
					// agents (non-empty `goal_condition`) previously skipped ALL of the
					// checks below because `liveTail = !goalActive` (line 153), leaving
					// them with no cost/turns backstop.  The hard ceilings, soft-cap
					// auto-extend log, live-grant adoption, and velocity warning now fire
					// whenever `runTail` is available — independent of goal-mode.  Only
					// the transcript-driven termination (`snap.done`) remains liveTail-only
					// (moved to the tail of this block) because it would otherwise terminate
					// goal-mode runs before the `Goal achieved` marker fires.  The finish
					// cascade still checks `goalAchieved` BEFORE `budgetExceeded`, so a
					// goal-mode run that converges before the ceiling still reports
					// `goal_achieved`, not `awaiting-budget-approval`.

					// ADR-006 Phase 3 — adopt any operator live grant (pre-approval from
					// a velocity warning) BEFORE the ceiling checks, so the run never
					// trips a ceiling the operator already raised. Re-arm the warning
					// ONLY when BOTH axes project clear post-grant (Commit C, 2026-05-30).
					// A partial grant (operator raised cost but not turns, or vice-versa)
					// leaves the unaddressed axis still in warning territory, and an
					// unconditional re-arm would re-fire the warning on the next tick —
					// duplicate Telegram + run re-paused. Hit live on ADR-025 dispatch.
					const grant = getLiveGrant(sessionUuid);
					if (grant) {
						if (grant.ceilingUsd > ceilingUsd) ceilingUsd = grant.ceilingUsd;
						if (grant.ceilingTurns > ceilingTurns) ceilingTurns = grant.ceilingTurns;
						clearLiveGrant(sessionUuid);
						const post = projectsAtCeiling(
							{ costUsd: snap.costUsd, turns: snap.turns },
							ceilingUsd,
							ceilingTurns,
						);
						if (!post.willHitCost && !post.willHitTurns) {
							velocityWarned = false;
						}
						console.log(
							`[agents/claude-pty] ${agent.id} adopted live budget grant — ceiling now $${ceilingUsd}/${ceilingTurns}t (velocity ${velocityWarned ? 'still-warned' : 're-armed'})`,
						);
					}

					// ADR-006 tier 2 — HARD ceiling terminates the run (runaway /
					// recursion backstop). This is the only budget kill now; the soft
					// caps below just log + auto-extend.
					if (snap.turns >= ceilingTurns) {
						budgetExceeded = 'max_turns';
						killSession(session.id);
						break;
					}
					// cost is null when any turn had unknown pricing — don't enforce
					// a dollar ceiling we can't trust; ceiling_turns still bounds the run.
					if (snap.costUsd !== null && snap.costUsd >= ceilingUsd) {
						budgetExceeded = 'max_usd';
						killSession(session.id);
						break;
					}
					// ADR-006 tier 1 — soft cap crossing: log once, then auto-extend to
					// the ceiling. No kill.
					if (!softCapLatched) {
						const overTurns = snap.turns >= budget.max_turns;
						const overCost = snap.costUsd !== null && snap.costUsd >= budget.max_usd;
						if (overTurns || overCost) {
							softCapLatched = true;
							const detail = overCost
								? `$${snap.costUsd!.toFixed(4)} ≥ soft $${budget.max_usd} (ceiling $${ceilingUsd})`
								: `${snap.turns} turns ≥ soft ${budget.max_turns} (ceiling ${ceilingTurns})`;
							console.log(
								`[agents/claude-pty] ${agent.id} crossed soft budget cap — auto-extending to ceiling: ${detail}`,
							);
						}
					}
					// ADR-006 Phase 3 — velocity warning. Project one turn ahead from the
					// observed cost-per-turn: if the NEXT turn likely crosses the ceiling
					// (cost) or it's the last turn before the turn ceiling, fire ONE early
					// warning so the operator can raise the ceiling in-flight (no
					// pause/resume cycle). Pausable runs only; needs ≥2 turns for a stable
					// rate. index.ts turns the event into a Telegram message.
					if (pausable && !velocityWarned && snap.turns >= 2) {
						const { willHitCost, willHitTurns } = projectsAtCeiling(
							{ costUsd: snap.costUsd, turns: snap.turns },
							ceilingUsd,
							ceilingTurns,
						);
						if (willHitCost || willHitTurns) {
							velocityWarned = true;
							yield {
								type: 'budget_warning',
								runId,
								sessionUuid,
								ceilingUsd,
								ceilingTurns,
								spentUsd: snap.costUsd ?? 0,
								turns: snap.turns,
								reason: willHitCost ? 'max_usd' : 'max_turns',
								ts: Date.now(),
							};
						}
					}

					// ADR-021 — transcript-driven termination stays liveTail-only.
					// Goal-mode keeps its `Goal achieved` marker as the convergence
					// signal; `snap.done` would otherwise terminate goal-mode runs
					// prematurely.
					if (liveTail && snap.done) {
						transcriptDone = true;
						killSession(session.id);
						break;
					}
				}
				// ADR-019 P1 — transcript-based ask-operator detection.
				// Replaces the raw PTY accumulator scan from ADR-026 P2 (which
				// fired on tool_use echoes, causing the self-trigger trap).
				// The JSONL transcript distinguishes assistant text blocks from
				// tool_use input payloads, so a marker inside an Edit/Write
				// `new_string` field is silently skipped.  The transcript path
				// is resolved once and cached; the read is bounded to the
				// debounce window (≤200ms per cycle, file is append-only).
				if (pausable && !operatorQuestion) {
					if (!resolvedTranscriptPath) {
						resolvedTranscriptPath = locateTranscript(sessionUuid, config.resolved.vaultDir);
					}
					if (resolvedTranscriptPath) {
						const q = extractAskOperatorFromTranscript(resolvedTranscriptPath, taskPayload);
						if (q !== null) {
							operatorQuestion = q;
							console.log(
								`[agents/claude-pty] ask-operator (transcript) from ${agent.id}: "${q.slice(0, 120)}${q.length > 120 ? '…' : ''}" — killing session`,
							);
							killSession(session.id);
						}
					}
				}
				if (promptInjected && idle >= stallMs) {
					stalled = true;
					killSession(session.id);
					break;
				}
				if (opts.signal?.aborted) break;

				await new Promise((r) => setTimeout(r, 200));
			}

			// Flush final progress (D5) or buffered chunks.
			if (liveTail && runTail) {
				await runTail.pump();
				for (const p of runTail.drain()) {
					if (p.kind === 'tool') yield { type: 'tool_call', name: p.name, ts: p.ts };
					else yield { type: 'step', n: p.n, finishReason: p.finishReason, ts: p.ts };
				}
				queue.length = 0;
			} else {
				while (queue.length > 0) {
					const chunk = queue.shift()!;
					yield { type: 'output', data: chunk, ts: Date.now() };
				}
			}

			const cleaned = stripAnsi(combined).trim();

			// ADR-002 Layer 1 — prefer Claude Code's own transcript over the
			// scraped scrollback. The transcript is clean (no ANSI), carries an
			// honest assistant-turn count, and is the same record the session
			// viewer/replay reads. Fall back to the scrape only when the
			// transcript never materialised (e.g. session died before its first
			// write, or `--session-id` unsupported on an older CLI).
			let finalOutput = cleaned;
			let transcriptTurns: number | undefined;
			// ADR-004 D4 — cost is the API-equivalent priced from the transcript's
			// per-turn usage (the same notional pricing the cli-flag / stream-json
			// backends already report into agent_runs). Undefined when no transcript
			// → finish() falls back to 0.
			let transcriptCostUsd: number | undefined;
			try {
				const record = await loadAgentRunRecord(sessionUuid, {
					// R5 fix — match the cwd we launched the PTY with. Claude saves
					// each session's transcript under ~/.claude/projects/<encoded-cwd>/
					// so a worktree-launched session's transcript lives at the
					// worktree-encoded path, not the vault-encoded path. Lookup MUST
					// agree with launch or the record returns null and we fall back
					// to scraped scrollback (loses cost/turns + clean finalOutput).
					cwd: opts.cwd ?? config.resolved.vaultDir,
					timeoutMs: 3000,
					parentAgentId: agent.id, // ADR-008 — detect self-delegation
				});
				if (record) {
					if (record.finalAssistantText) finalOutput = record.finalAssistantText;
					transcriptTurns = record.assistantTurns;
					transcriptCostUsd = record.summary.cost.totalUsd ?? undefined;
					// ADR-008 — reactive self-delegation guard. Recursion is already
					// depth-capped by Claude Code + cost-bounded by ADR-006's ceiling,
					// so we don't abort — we flag it: warn in the log and append a
					// footer to the recorded result so it's visible in the runs UI.
					if (record.selfDelegatedTypes.length > 0) {
						const types = record.selfDelegatedTypes.join(', ');
						console.warn(
							`[agents/claude-pty] ⚠ self-delegation: ${agent.id} spawned a sub-agent of its own type (${types}) — work runs in a hidden sidechain (ADR-008). Prefer delegating to a different agent type.`,
						);
						finalOutput =
							`${finalOutput}\n\n---\n⚠ Self-delegation (ADR-008): this run spawned a sub-agent of its own type (${types}). Its work ran in a hidden sidechain; consider decomposing to a different agent type.`.trim();
					}
				}
			} catch {
				/* keep the scrape */
			}

			// Shared terminal metrics for every return below (ADR-004 D4).
			const termExtras = {
				num_turns: transcriptTurns,
				cost_usd: transcriptCostUsd,
				claude_session_id: sessionUuid,
			};

			if (opts.signal?.aborted) {
				return finish(runId, agent, started, 'cancelled', finalOutput, 'cancelled', termExtras);
			}
			// ADR-031 v3 — convergence wins over timeout/stall. If the
			// agent emitted `Goal achieved (...)` before the budget kill,
			// the dispatch was successful even if the session itself was
			// terminated by our grace timer or the budget timer.
			if (goalAchieved) {
				const { num_turns } = parseGoalMetrics(goalMetricsRaw);
				return finish(runId, agent, started, 'goal_achieved', finalOutput, undefined, {
					...termExtras,
					num_turns: num_turns || transcriptTurns,
				});
			}
			// ADR-004 D2 — transcript-confirmed completion is authoritative.
			if (transcriptDone) {
				return finish(runId, agent, started, 'success', finalOutput, undefined, termExtras);
			}
			// ADR-026 P2 — operator-input pause wins over a coincident budget
			// ceiling (question is a pending intent; ceiling is a resource gate).
			// pausable guard already checked in onOutput where the kill fired.
			if (operatorQuestion && pausable) {
				return finish(
					runId, agent, started,
					'awaiting-operator-input',
					finalOutput,
					`OPERATOR_QUESTION: ${operatorQuestion}`,
					{ ...termExtras, operator_pause: { question: operatorQuestion } },
				);
			}
			// ADR-004 D4 / ADR-006 — the HARD ceiling tripped mid-run (live-tail
			// only). If the run is pausable (background), preserve the session and
			// hand off to the operator budget-approval gate instead of terminating;
			// otherwise (chat) keep the terminal kill.
			if (budgetExceeded) {
				const msg =
					budgetExceeded === 'max_turns'
						? `Budget ceiling reached: ${transcriptTurns ?? '?'} turns ≥ ceiling ${ceilingTurns} (soft ${budget.max_turns})`
						: `Budget ceiling reached: $${(transcriptCostUsd ?? 0).toFixed(4)} ≥ ceiling $${ceilingUsd} (soft $${budget.max_usd})`;
				if (pausable) {
					// ADR-006 Phase 2 — the session lives on disk; index.ts escalates
					// to Telegram and the resume path picks up via `--resume`. Report the
					// effective (possibly live-grant-raised) ceilings so a bump from here
					// raises from the right base.
					return finish(runId, agent, started, 'awaiting-budget-approval', finalOutput, msg, {
						...termExtras,
						budget_pause: {
							reason: budgetExceeded,
							ceiling_usd: ceilingUsd,
							ceiling_turns: ceilingTurns,
						},
					});
				}
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'budget-exceeded', finalOutput, msg, termExtras);
			}
			if (timedOut) {
				const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'timeout', finalOutput, msg, termExtras);
			}
			if (stalled) {
				// ADR-004 D3 — under live-tail a stall that the transcript can't
				// confirm as a clean `end_turn` is a real hang, not a finished agent
				// idling for input. Flush the transcript once more first (end_turn
				// may have landed in the race between pumps), then refuse to score an
				// unconfirmed stall as success — the legacy bug this ADR retires.
				if (runTail) {
					await runTail.pump();
					if (!runTail.snapshot().done) {
						const msg = 'Stalled without a completing end_turn in the transcript';
						yield { type: 'error', message: msg, ts: Date.now() };
						return finish(runId, agent, started, 'error', finalOutput, msg, termExtras);
					}
				}
				// Legacy path (flag off) or live-tail confirmed completion: a stall
				// is expected when the model is done and waiting for input.
				return finish(runId, agent, started, 'success', finalOutput, undefined, termExtras);
			}
			// 129 = SIGHUP on macOS, treated as success per orchestration engine.
			const ok = exitCode === 0 || exitCode === 129;
			if (!ok) {
				const msg = `PTY exited ${exitCode}`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'error', finalOutput, msg, termExtras);
			}
			return finish(runId, agent, started, 'success', finalOutput, undefined, termExtras);
		} finally {
			runTail?.stop();
			// ADR-006 Phase 3 — never leak a live grant past the run that owns it
			// (resume reuses the same session UUID, so a stale grant would mis-raise).
			clearLiveGrant(sessionUuid);
			session.emitter.off('output', onOutput);
			session.emitter.off('exit', onExit);
			session.emitter.off('prompt_sent', onPromptSent);
			if (goalTimers.taskWrite) clearTimeout(goalTimers.taskWrite);
			if (goalTimers.enterWrite) clearTimeout(goalTimers.enterWrite);
			if (goalGraceTimer) clearTimeout(goalGraceTimer);
			opts.signal?.removeEventListener('abort', onAbort);
			killSession(session.id);
		}
	},
};

/** Compose the user-message-shaped prompt that gets typed into Claude Code's
 *  TUI. The agent's `system_prompt` is loaded by Claude Code from
 *  `~/.claude/agents/<id>.md` via the `--agent <id>` flag — DO NOT
 *  pre-paste it here. Pasting >100 lines fragments into multiple
 *  `[Pasted text #N]` preview blocks that never auto-confirm and the
 *  agent stalls until the idle timer kicks in.
 *
 *  Keep this short: just the conversational context (when present) and
 *  the task instruction. ~600-1000 chars typical. */
function composePrompt(task: string, context?: string): string {
	const ctx = context?.trim();
	if (!ctx) return task;
	return `${ctx}\n\n---\n\n# Task\n\n${task}`;
}

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}

function finish(
	runId: string,
	agent: AgentSummary,
	started: number,
	status: DispatchResult['status'],
	output: string,
	error?: string,
	extras?: {
		num_turns?: number;
		cost_usd?: number;
		claude_session_id?: string;
		budget_pause?: DispatchResult['budget_pause'];
		operator_pause?: DispatchResult['operator_pause'];
	},
): DispatchResult {
	return {
		runId,
		agentId: agent.id,
		backend: agent.backend,
		status,
		output,
		// ADR-004 D4 — API-equivalent cost priced from the transcript (matches the
		// cli-flag / stream-json backends). 0 when no transcript materialised;
		// PTY runs bill nothing on the Max subscription either way.
		cost_usd: extras?.cost_usd ?? 0,
		num_turns: extras?.num_turns ?? 0,
		duration_ms: Date.now() - started,
		error,
		claude_session_id: extras?.claude_session_id,
		budget_pause: extras?.budget_pause,
		operator_pause: extras?.operator_pause,
	};
}

/** ADR-031 v3 — parse the metrics tail captured from a `Goal achieved (…)`
 *  marker into structured fields. Format is loose; the upstream regex
 *  captures everything inside the parens. Sub-patterns here pick out the
 *  pieces we want, with defaults when something is missing. Token count
 *  is intentionally NOT returned today — Claude Code's `Xk tokens`
 *  rendering is approximate and the orchestration system stores tokens
 *  per call elsewhere; conflating displayed-tokens with real-tokens hurts
 *  more than it helps. Revisit if a goal-mode billing surface lands. */
function parseGoalMetrics(raw: string | undefined): { num_turns: number } {
	if (!raw) return { num_turns: 0 };
	const turnsMatch = /(\d+)\s*turns?/i.exec(raw);
	return {
		num_turns: turnsMatch ? Number(turnsMatch[1]) : 0,
	};
}
