/**
 * Lane A2 dispatcher — `claude -p --agent <id> <task>`.
 *
 * Single-call wrapper around the Claude Code CLI. The CLI reads the agent's
 * frontmatter+body from `~/.claude/agents/<id>.md` itself, so we just hand it
 * the id and the task. Output is captured as JSON when `--output-format json`
 * is supported; otherwise we fall back to plain text.
 *
 * Per ADR-001 §3b: avoid concurrent dispatch (anthropics/claude-code#18666).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '$lib/config.js';
import type { AgentSummary } from '../types.js';
import type { BackendDispatcher, DispatchEvent, DispatchOptions, DispatchResult } from './types.js';
import { resolveBudget } from './budget.js';

interface CliEnvelope {
	type?: string;
	subtype?: string;
	result?: string;
	is_error?: boolean;
	num_turns?: number;
	total_cost_usd?: number;
	duration_ms?: number;
	session_id?: string;
}

export const claudeCliFlagDispatcher: BackendDispatcher = {
	id: 'claude-cli-flag',

	async *dispatch(
		agent: AgentSummary,
		opts: DispatchOptions,
	): AsyncGenerator<DispatchEvent, DispatchResult, void> {
		const runId = crypto.randomUUID().slice(0, 8);
		const started = Date.now();
		// ADR-005 parity fix (2026-05-17): honour opts.budget_override the
		// same way claude-pty does. Previously this backend used agent.budget
		// only — recipe-level budget overrides were silently dropped, which
		// surfaced as a 60s cap on peer-brief-synth oneshot dispatches during
		// ADR-007 S3 testing.
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
			return finish(runId, agent, started, 'error', '', 0, 0, msg);
		}

		yield { type: 'started', backend: 'claude-cli-flag', model: agent.model, runId, ts: started };

		const promptArg = opts.context?.trim()
			? `${opts.context.trim()}\n\n---\n\n# Task\n\n${opts.task}`
			: opts.task;
		const args = [
			'-p', promptArg,
			'--agent', agent.id,
			'--output-format', 'json',
			'--dangerously-skip-permissions',
			// Leaf worker — deny sub-agent dispatch so it can't delegate to a
			// same-named sub-agent and hide its work in a sidechain.
			'--disallowedTools', 'Task,Agent',
		];
		if (agent.model) args.push('--model', agent.model);

		// Build env — explicit, with claude on PATH
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		const pathSep = process.platform === 'win32' ? ';' : ':';
		env.PATH = `${dirname(claudeBinary)}${pathSep}${env.PATH || ''}`;
		delete env.npm_config_prefix;
		env.CLAUDE_CODE_DISABLE_HOOKS = '1';

		const cwd = config.resolved.vaultDir;
		const ac = new AbortController();
		const onAbort = () => ac.abort();
		opts.signal?.addEventListener('abort', onAbort);

		const proc = spawn(claudeBinary, args, {
			cwd,
			env,
			signal: ac.signal,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});

		const timer = setTimeout(() => {
			try {
				if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
			} catch { /* already dead */ }
			ac.abort();
		}, budget.timeout_ms);

		let stdout = '';
		let stderr = '';

		// `claude -p --output-format json` returns one JSON envelope at the end
		// of the run, not incremental text — so we accumulate stdout silently
		// and emit a single clean `output` event with `envelope.result` once
		// parsing succeeds. Streaming raw JSON chunks would just confuse the UI.
		proc.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8');
		});
		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		try {
			const procState: { closed: boolean; exitCode: number | null; exitErr: Error | null } = {
				closed: false,
				exitCode: null,
				exitErr: null,
			};

			await new Promise<void>((resolveClose) => {
				proc.on('close', (code) => {
					procState.exitCode = code;
					procState.closed = true;
					resolveClose();
				});
				proc.on('error', (err: NodeJS.ErrnoException) => {
					procState.exitErr = err;
					procState.closed = true;
					resolveClose();
				});
			});

			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);

			const aborted = ac.signal.aborted;
			const timedOut = aborted && Date.now() - started >= budget.timeout_ms - 100;

			if (procState.exitErr && procState.exitErr.name !== 'AbortError') {
				const msg = `spawn error: ${procState.exitErr.message}`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'error', stdout, 0, 0, msg);
			}

			if (timedOut) {
				const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'timeout', stdout, 0, 0, msg);
			}
			if (aborted) {
				return finish(runId, agent, started, 'cancelled', stdout, 0, 0, 'cancelled');
			}

			// Try to parse JSON envelope
			let envelope: CliEnvelope | null = null;
			try {
				envelope = JSON.parse(stdout.trim());
			} catch {
				// Plain text fallback
			}

			if (envelope && typeof envelope === 'object') {
				if (envelope.is_error) {
					const errMsg = envelope.result ?? (stderr || 'CLI returned is_error=true');
					yield { type: 'error', message: errMsg, ts: Date.now() };
					return finish(
						runId,
						agent,
						started,
						'error',
						envelope.result ?? '',
						envelope.total_cost_usd ?? 0,
						envelope.num_turns ?? 0,
						errMsg,
						envelope.session_id,
					);
				}
				const replyText = envelope.result ?? '';
				if (replyText) {
					yield { type: 'output', data: replyText, ts: Date.now() };
				}
				return finish(
					runId,
					agent,
					started,
					'success',
					replyText,
					envelope.total_cost_usd ?? 0,
					envelope.num_turns ?? 0,
					undefined,
					envelope.session_id,
				);
			}

			if (procState.exitCode !== 0) {
				const msg = `CLI exited ${procState.exitCode}${stderr ? ': ' + stderr.trim().slice(0, 200) : ''}`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'error', stdout, 0, 0, msg);
			}

			// Plain-text fallback (no JSON envelope) — emit stdout as one event.
			if (stdout) {
				yield { type: 'output', data: stdout, ts: Date.now() };
			}
			return finish(runId, agent, started, 'success', stdout, 0, 0);
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			try {
				if (proc.pid && !proc.killed) process.kill(-proc.pid, 'SIGTERM');
			} catch { /* already dead */ }
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
	error?: string,
	claudeSessionId?: string,
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
