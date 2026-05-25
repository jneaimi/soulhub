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
		const sessionUuid = crypto.randomUUID();
		const runId = sessionUuid.slice(0, 8);
		const started = Date.now();
		// ADR-005 — per-call budget override (Naseej recipe step). Shallow merge:
		// any field set on `opts.budget_override` shadows the agent default;
		// undefined fields fall through to `agent.budget`, which itself falls
		// through to `PRODUCTION_DEFAULTS` inside `resolveBudget`.
		const mergedBudget = opts.budget_override
			? {
					max_usd: opts.budget_override.max_usd ?? agent.budget?.max_usd,
					max_turns: opts.budget_override.max_turns ?? agent.budget?.max_turns,
					timeout_sec: opts.budget_override.timeout_sec ?? agent.budget?.timeout_sec,
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
		// ADR-004 P1 — opt-in live transcript-driven termination + honest status.
		// Off by default (env unset) → behaviour identical to the legacy path.
		// Scoped to non-goal agents: goal-mode emits `end_turn` on every iteration,
		// so it keeps the `Goal achieved` marker as its termination signal.
		const liveTail = process.env.PTY_LIVE_TRANSCRIPT === '1' && !goalActive;
		const taskPayload = composePrompt(opts.task, opts.context);
		const initialPrompt = goalActive ? `/goal ${goalCondition}` : taskPayload;

		const model = agent.model || 'sonnet';

		let session;
		try {
			session = spawnSession({
				prompt: initialPrompt,
				agentId: agent.id, // Claude Code loads system_prompt from ~/.claude/agents/<id>.md
				cwd: config.resolved.vaultDir,
				shell: false,
				model,
				claudeSessionId: sessionUuid,
				// Dispatched agents are leaf workers — deny the sub-agent dispatch
				// tool so they do the work themselves instead of delegating. An
				// `--agent <id>` session also sees `<id>` as a callable sub-agent
				// (Claude Code auto-discovers ~/.claude/agents/), so without this
				// the analyst spawns itself and the work hides in a sidechain.
				extraArgs: [
					'--strict-mcp-config',
					'--mcp-config',
					'{"mcpServers":{}}',
					'--disallowedTools',
					'Task,Agent',
				],
			});
		} catch (err) {
			const msg = (err as Error).message;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', msg, { claude_session_id: sessionUuid });
		}

		yield { type: 'started', backend: 'claude-pty', model, runId, ts: started };
		if (goalActive) {
			console.log(
				`[agents/claude-pty] goal-mode active for ${agent.id}: "${goalCondition!.slice(0, 80)}${goalCondition!.length > 80 ? '…' : ''}"`,
			);
		}

		// ADR-004 D1 — begin tailing this run's transcript live (the
		// `--session-id` set on spawn makes it locatable immediately).
		let runTail: RunTail | undefined;
		if (liveTail) {
			runTail = createRunTail(sessionUuid, { cwd: config.resolved.vaultDir });
			console.log(`[agents/claude-pty] live-transcript termination active for ${agent.id}`);
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

			while (!exited) {
				while (queue.length > 0) {
					const chunk = queue.shift()!;
					yield { type: 'output', data: chunk, ts: Date.now() };
				}

				const elapsed = Date.now() - started;
				const idle = Date.now() - lastActivity;

				if (elapsed >= budget.timeout_ms) {
					timedOut = true;
					killSession(session.id);
					break;
				}
				// ADR-004 D2 — the transcript says the last turn ended cleanly with
				// no open tool call: the agent is genuinely done. Terminate now
				// instead of waiting out the idle-stall window.
				if (runTail?.snapshot().done) {
					transcriptDone = true;
					killSession(session.id);
					break;
				}
				if (promptInjected && idle >= stallMs) {
					stalled = true;
					killSession(session.id);
					break;
				}
				if (opts.signal?.aborted) break;

				await new Promise((r) => setTimeout(r, 200));
			}

			// Flush any final buffered chunks
			while (queue.length > 0) {
				const chunk = queue.shift()!;
				yield { type: 'output', data: chunk, ts: Date.now() };
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
			try {
				const record = await loadAgentRunRecord(sessionUuid, {
					cwd: config.resolved.vaultDir,
					timeoutMs: 3000,
				});
				if (record?.finalAssistantText) {
					finalOutput = record.finalAssistantText;
					transcriptTurns = record.assistantTurns;
				}
			} catch {
				/* keep the scrape */
			}

			if (opts.signal?.aborted) {
				return finish(runId, agent, started, 'cancelled', finalOutput, 'cancelled', {
					num_turns: transcriptTurns,
					claude_session_id: sessionUuid,
				});
			}
			// ADR-031 v3 — convergence wins over timeout/stall. If the
			// agent emitted `Goal achieved (...)` before the budget kill,
			// the dispatch was successful even if the session itself was
			// terminated by our grace timer or the budget timer.
			if (goalAchieved) {
				const { num_turns } = parseGoalMetrics(goalMetricsRaw);
				return finish(runId, agent, started, 'goal_achieved', finalOutput, undefined, {
					num_turns: num_turns || transcriptTurns,
					claude_session_id: sessionUuid,
				});
			}
			// ADR-004 D2 — transcript-confirmed completion is authoritative.
			if (transcriptDone) {
				return finish(runId, agent, started, 'success', finalOutput, undefined, {
					num_turns: transcriptTurns,
					claude_session_id: sessionUuid,
				});
			}
			if (timedOut) {
				const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'timeout', finalOutput, msg, {
					num_turns: transcriptTurns,
					claude_session_id: sessionUuid,
				});
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
						return finish(runId, agent, started, 'error', finalOutput, msg, {
							num_turns: transcriptTurns,
							claude_session_id: sessionUuid,
						});
					}
				}
				// Legacy path (flag off) or live-tail confirmed completion: a stall
				// is expected when the model is done and waiting for input.
				return finish(runId, agent, started, 'success', finalOutput, undefined, {
					num_turns: transcriptTurns,
					claude_session_id: sessionUuid,
				});
			}
			// 129 = SIGHUP on macOS, treated as success per orchestration engine.
			const ok = exitCode === 0 || exitCode === 129;
			if (!ok) {
				const msg = `PTY exited ${exitCode}`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'error', finalOutput, msg, {
					num_turns: transcriptTurns,
					claude_session_id: sessionUuid,
				});
			}
			return finish(runId, agent, started, 'success', finalOutput, undefined, {
				num_turns: transcriptTurns,
				claude_session_id: sessionUuid,
			});
		} finally {
			runTail?.stop();
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
	extras?: { num_turns?: number; claude_session_id?: string },
): DispatchResult {
	return {
		runId,
		agentId: agent.id,
		backend: agent.backend,
		status,
		output,
		cost_usd: 0, // PTY runs use Max subscription — no per-call cost
		num_turns: extras?.num_turns ?? 0,
		duration_ms: Date.now() - started,
		error,
		claude_session_id: extras?.claude_session_id,
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
