/**
 * Headless Claude runner — `claude -p` fire-and-forget.
 *
 * Use for system-triggered one-shot tasks where we want:
 *   - No TUI / PTY / ANSI parsing
 *   - Deterministic completion (process exit)
 *   - Captured stdout/stderr
 *   - Hard timeout via AbortController
 *
 * Not a replacement for the interactive PTY manager — use this for healers,
 * validators, and small scripted fixes; keep the PTY for user-invoked sessions.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '$lib/config.js';

export interface HeadlessClaudeOptions {
	prompt: string;
	cwd?: string;
	/** Override model. Default: haiku-4-5 (cheap + fast for simple tasks). */
	model?: string;
	/** Timeout in ms. Default: 60_000. */
	timeoutMs?: number;
	/** Restrict tool access (e.g. ['Edit', 'Read', 'Glob']). Omit for default. */
	allowedTools?: string[];
}

export interface HeadlessClaudeResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export async function runClaudeHeadless(opts: HeadlessClaudeOptions): Promise<HeadlessClaudeResult> {
	const claudeBinary = config.resolved.claudeBinary;
	if (!existsSync(claudeBinary)) {
		throw new Error(
			`Claude Code CLI not found at: ${claudeBinary}. ` +
			`Install it (npm i -g @anthropic-ai/claude-code) or set paths.claudeBinary in settings.json.`
		);
	}

	const cwd = opts.cwd || process.env.HOME || '/';
	if (!existsSync(cwd)) {
		throw new Error(`cwd does not exist: ${cwd}`);
	}

	const timeoutMs = opts.timeoutMs ?? 60_000;
	const model = opts.model ?? 'claude-haiku-4-5';

	const args = [
		'-p', opts.prompt,
		'--model', model,
		'--dangerously-skip-permissions',
	];
	if (opts.allowedTools && opts.allowedTools.length > 0) {
		args.push('--allowed-tools', opts.allowedTools.join(','));
	}

	// Inherit env so ANTHROPIC_API_KEY / OAuth creds are available; scrub nvm noise.
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	const pathSep = process.platform === 'win32' ? ';' : ':';
	env.PATH = `${dirname(claudeBinary)}${pathSep}${env.PATH || ''}`;
	delete env.npm_config_prefix;
	env.CLAUDE_CODE_DISABLE_HOOKS = '1';

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const started = Date.now();

	return new Promise<HeadlessClaudeResult>((resolvePromise) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const proc = spawn(claudeBinary, args, {
			cwd,
			env,
			signal: ac.signal,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

		proc.on('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err.name === 'AbortError' || ac.signal.aborted) {
				timedOut = true;
			} else {
				stderr += `\nspawn error: ${err.message}`;
			}
			resolvePromise({
				ok: false,
				exitCode: null,
				stdout,
				stderr,
				durationMs: Date.now() - started,
				timedOut,
			});
		});

		proc.on('close', (code) => {
			clearTimeout(timer);
			if (ac.signal.aborted) timedOut = true;
			resolvePromise({
				ok: code === 0 && !timedOut,
				exitCode: code,
				stdout,
				stderr,
				durationMs: Date.now() - started,
				timedOut,
			});
		});
	});
}
