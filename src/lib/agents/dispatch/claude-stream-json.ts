/**
 * ADR-002 Layer 2 — headless stream-json dispatcher.
 *
 * `claude -p --input-format stream-json --output-format stream-json --verbose`.
 *
 * Structurally better than the `claude-pty` backend for single-pass agents:
 *   - The task is submitted as a stream-json **user message on stdin** — there
 *     is no interactive TUI input box, so the goal-mode injection race and the
 *     paste-stall that plagued the PTY path (see
 *     `feedback_goal_condition_chat_dispatch_race`) cannot occur.
 *   - Output is a structured JSONL event stream — no ANSI, ever. The terminal
 *     `result` event carries cost / turns / session_id / final text directly,
 *     so there's no scrape and no idle-stall "done" heuristic.
 *   - `--max-budget-usd` enforces the dollar cap natively.
 *   - `--session-id <uuid>` makes the transcript locatable (ADR-002 Layer 1).
 *
 * Concurrency: the historical `#18666` concurrent-`-p` hang did NOT reproduce
 * on Claude Code 2.1.145 in this isolated config (clean cwd, `--strict-mcp-config`,
 * empty MCP) — re-validated 2026-05-20 before this backend shipped.
 *
 * Like `claude-cli-flag`, this is a leaf-worker backend: `--disallowedTools
 * Task,Agent` prevents the dispatched agent from spawning sub-agents.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '$lib/config.js';
import type { AgentSummary } from '../types.js';
import type { BackendDispatcher, DispatchEvent, DispatchOptions, DispatchResult } from './types.js';
import { resolveBudget } from './budget.js';

/** A line of `--output-format stream-json`. Treat as external schema. */
interface StreamEvent {
	type?: string;
	subtype?: string;
	session_id?: string;
	model?: string;
	is_error?: boolean;
	result?: string;
	total_cost_usd?: number;
	num_turns?: number;
	message?: { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> };
}

/** Map the `result` event subtype to our DispatchResult status. */
function statusFromResult(ev: StreamEvent): DispatchResult['status'] {
	if (ev.subtype === 'success' && !ev.is_error) return 'success';
	const sub = ev.subtype ?? '';
	if (sub.includes('max_turns') || sub.includes('budget')) return 'budget-exceeded';
	return 'error';
}

export const claudeStreamJsonDispatcher: BackendDispatcher = {
	id: 'claude-stream-json' as AgentSummary['backend'],

	async *dispatch(
		agent: AgentSummary,
		opts: DispatchOptions,
	): AsyncGenerator<DispatchEvent, DispatchResult, void> {
		const sessionUuid = crypto.randomUUID();
		const runId = sessionUuid.slice(0, 8);
		const started = Date.now();

		const mergedBudget = opts.budget_override
			? {
					max_usd: opts.budget_override.max_usd ?? agent.budget?.max_usd,
					max_turns: opts.budget_override.max_turns ?? agent.budget?.max_turns,
					timeout_sec: opts.budget_override.timeout_sec ?? agent.budget?.timeout_sec,
				}
			: agent.budget;
		const budget = resolveBudget(opts.mode, mergedBudget);

		const claudeBinary = config.resolved.claudeBinary;
		if (!existsSync(claudeBinary)) {
			const msg = `Claude Code CLI not found at: ${claudeBinary}`;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', 0, 0, msg, sessionUuid);
		}

		yield { type: 'started', backend: 'claude-stream-json', model: agent.model, runId, ts: started };

		const args = [
			'-p',
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--verbose',
			'--agent', agent.id,
			'--session-id', sessionUuid,
			'--max-budget-usd', String(budget.max_usd),
			'--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
			'--disallowedTools', 'Task,Agent',
			'--dangerously-skip-permissions',
		];
		if (agent.model) args.push('--model', agent.model);

		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		const pathSep = process.platform === 'win32' ? ';' : ':';
		env.PATH = `${dirname(claudeBinary)}${pathSep}${env.PATH || ''}`;
		delete env.npm_config_prefix;
		env.CLAUDE_CODE_DISABLE_HOOKS = '1';

		const ac = new AbortController();
		const onAbort = () => ac.abort();
		opts.signal?.addEventListener('abort', onAbort);

		// R5 fix (2026-05-30) — use the provisioned worktree cwd when set.
		// Sibling of the claude-pty + cli-flag fixes; stream-json backend had
		// the same silent leak.
		const proc = spawn(claudeBinary, args, {
			cwd: opts.cwd ?? config.resolved.vaultDir,
			env,
			signal: ac.signal,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: true,
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
			} catch {
				/* already dead */
			}
			ac.abort();
		}, budget.timeout_ms);

		// Submit the task as a single stream-json user message, then close stdin.
		const taskText = opts.context?.trim()
			? `${opts.context.trim()}\n\n---\n\n# Task\n\n${opts.task}`
			: opts.task;
		const userMsg = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: taskText }] },
		});
		try {
			proc.stdin.write(userMsg + '\n');
			proc.stdin.end();
		} catch {
			/* process may have died immediately; handled by close below */
		}

		// Bridge child stdout (line-delimited JSON) into the generator via a queue.
		const queue: DispatchEvent[] = [];
		let stdoutBuf = '';
		let stderr = '';
		let closed = false;
		let exitCode: number | null = null;
		let finalResult: StreamEvent | null = null;
		// Annotate as plain string: crypto.randomUUID() returns the branded
		// `${string}-${string}-…` UUID template type, which would otherwise
		// reject the plain-string session_id pulled from the event stream.
		let sessionId: string = sessionUuid;

		const handleLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let ev: StreamEvent;
			try {
				ev = JSON.parse(trimmed) as StreamEvent;
			} catch {
				return; // skip non-JSON noise
			}
			if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
				sessionId = ev.session_id;
			} else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
				for (const b of ev.message!.content!) {
					if (b.type === 'text' && b.text) queue.push({ type: 'output', data: b.text, ts: Date.now() });
					else if (b.type === 'tool_use' && b.name) queue.push({ type: 'tool_call', name: b.name, ts: Date.now() });
				}
			} else if (ev.type === 'result') {
				finalResult = ev;
			}
		};

		proc.stdout.on('data', (chunk: Buffer) => {
			stdoutBuf += chunk.toString('utf-8');
			let nl: number;
			while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
				const line = stdoutBuf.slice(0, nl);
				stdoutBuf = stdoutBuf.slice(nl + 1);
				handleLine(line);
			}
		});
		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});
		proc.on('close', (code) => {
			if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush trailing partial line
			exitCode = code;
			closed = true;
		});
		proc.on('error', () => {
			closed = true;
		});

		try {
			while (!closed || queue.length > 0) {
				while (queue.length > 0) yield queue.shift()!;
				if (closed) break;
				await new Promise((r) => setTimeout(r, 50));
			}

			clearTimeout(timer);

			// `finalResult` is mutated only inside the stdout closure, so TS's
			// control-flow analysis narrows it to `null` in this linear flow
			// (it can't see the closure assignment). Re-widen via an asserted
			// local so the result-event fields read correctly.
			const result = finalResult as StreamEvent | null;

			if (timedOut) {
				const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'timeout', result?.result ?? '', result?.total_cost_usd ?? 0, result?.num_turns ?? 0, msg, sessionId);
			}
			if (opts.signal?.aborted) {
				return finish(runId, agent, started, 'cancelled', result?.result ?? '', result?.total_cost_usd ?? 0, result?.num_turns ?? 0, 'cancelled', sessionId);
			}
			if (result) {
				const status = statusFromResult(result);
				const errMsg = status !== 'success'
					? (result.result || stderr || `result subtype=${result.subtype}`)
					: undefined;
				if (errMsg) yield { type: 'error', message: errMsg, ts: Date.now() };
				return finish(runId, agent, started, status, result.result ?? '', result.total_cost_usd ?? 0, result.num_turns ?? 0, errMsg, result.session_id ?? sessionId);
			}
			// No result event — process died before producing one.
			const msg = `stream-json ended without a result event${exitCode != null ? ` (exit ${exitCode})` : ''}${stderr ? ': ' + stderr.trim().slice(0, 200) : ''}`;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', 0, 0, msg, sessionId);
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			try {
				if (proc.pid && !proc.killed) process.kill(-proc.pid, 'SIGTERM');
			} catch {
				/* already dead */
			}
		}
	},
};

function finish(
	runId: string,
	agent: AgentSummary,
	started: number,
	status: DispatchResult['status'],
	output: string,
	cost: number,
	turns: number,
	error: string | undefined,
	claudeSessionId: string,
): DispatchResult {
	return {
		runId,
		agentId: agent.id,
		backend: agent.backend,
		status,
		output,
		cost_usd: cost,
		num_turns: turns,
		duration_ms: Date.now() - started,
		error,
		claude_session_id: claudeSessionId,
	};
}
