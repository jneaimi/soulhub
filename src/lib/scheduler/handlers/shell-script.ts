/** Task handler: shell-script.
 *
 *  Spawns an arbitrary command as a child process. Captures stdout +
 *  stderr (tail-truncated to keep `scheduler_runs.output_summary`
 *  small), times out after `timeoutMs`, and throws on non-zero exit
 *  so the run lands as `error` in run history.
 *
 *  Settings shape:
 *
 *      {
 *        id: 'project-hygiene',
 *        type: 'shell-script',
 *        cron: '0 9 * * 0',
 *        params: {
 *          command: ['python3', '/path/to/script.py'],
 *          cwd: '/optional/working/dir',     // default: $HOME
 *          env: { FOO: 'bar' },              // merged over process.env
 *          timeoutMs: 600000                 // default 10 min
 *        }
 *      }
 *
 *  This handler is intentionally generic — Phase 5 will use it for
 *  signal-forge daily/weekly too.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import type { TaskFn } from '../task-types.js';

/** Standard system bin dirs that must always be resolvable when we spawn a
 *  task. A PM2 daemon resurrected at boot by launchd can inherit a stripped
 *  environment whose PATH lacks `/bin` — then Node can't even find `bash` to
 *  launch a shell-script task and fails with `spawn bash ENOENT`. We append
 *  these to whatever PATH was inherited (operator-set entries keep priority)
 *  so every install's shell-script tasks survive a bad-context restart. */
const SYSTEM_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Return a PATH string that's guaranteed to contain the system bin dirs,
 *  preserving the caller's existing entries and their order — we only append
 *  the standard dirs that aren't already present. */
export function hardenPath(inheritedPath: string | undefined): string {
	const entries = (inheritedPath ?? '').split(delimiter).filter(Boolean);
	const seen = new Set(entries);
	for (const dir of SYSTEM_PATH_DIRS) {
		if (!seen.has(dir)) {
			entries.push(dir);
			seen.add(dir);
		}
	}
	return entries.join(delimiter);
}

interface ShellScriptParams {
	command: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const TAIL_BYTES = 2048;

function isParams(value: unknown): value is ShellScriptParams {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.command)) return false;
	if (v.command.length === 0) return false;
	for (const arg of v.command) {
		if (typeof arg !== 'string') return false;
	}
	return true;
}

function tail(buf: string): string {
	if (buf.length <= TAIL_BYTES) return buf;
	return '…(truncated)…\n' + buf.slice(buf.length - TAIL_BYTES);
}

export class ShellScriptError extends Error {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdoutTail: string;
	stderrTail: string;
	timedOut: boolean;
	constructor(opts: {
		message: string;
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		stdoutTail: string;
		stderrTail: string;
		timedOut: boolean;
	}) {
		super(opts.message);
		this.name = 'ShellScriptError';
		this.exitCode = opts.exitCode;
		this.signal = opts.signal;
		this.stdoutTail = opts.stdoutTail;
		this.stderrTail = opts.stderrTail;
		this.timedOut = opts.timedOut;
	}
}

export function shellScriptFactory(params: unknown): TaskFn {
	if (!isParams(params)) {
		throw new Error(
			`shell-script: params.command must be a non-empty string[], got ${JSON.stringify(params)}`,
		);
	}
	const command = params.command;
	const cwd = params.cwd ?? homedir();
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const extraEnv = params.env ?? {};

	return async (ctx) => {
		const startMs = Date.now();
		const [bin, ...args] = command;
		const externalSignal = ctx?.signal;

		return await new Promise((resolvePromise, rejectPromise) => {
			// Merge env, then guarantee PATH carries the system bin dirs so the
			// interpreter (and the tools the script calls) resolve even under a
			// minimal PM2-inherited PATH. An explicit PATH in `extraEnv` still
			// wins — we only append what's missing.
			const childEnv = { ...process.env, ...extraEnv };
			childEnv.PATH = hardenPath(childEnv.PATH);

			const child = spawn(bin, args, {
				cwd,
				env: childEnv,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf-8');
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf-8');
			});

			let timedOut = false;
			let cancelled = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGTERM');
				// Hard-kill if SIGTERM doesn't take in 5s.
				setTimeout(() => {
					if (!child.killed) child.kill('SIGKILL');
				}, 5000);
			}, timeoutMs);

			// External cancel via `killRun(taskId)` — same SIGTERM → SIGKILL
			// escalation as the timeout path. Done as a one-shot listener so
			// re-aborting after the first kill is a no-op.
			const onAbort = () => {
				cancelled = true;
				child.kill('SIGTERM');
				setTimeout(() => {
					if (!child.killed) child.kill('SIGKILL');
				}, 5000);
			};
			if (externalSignal) {
				if (externalSignal.aborted) onAbort();
				else externalSignal.addEventListener('abort', onAbort, { once: true });
			}

			const settle = (err: Error | null, exitCode: number | null, signal: NodeJS.Signals | null) => {
				clearTimeout(timer);
				if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
				const durationMs = Date.now() - startMs;
				const stdoutTail = tail(stdout);
				const stderrTail = tail(stderr);

				if (err) {
					rejectPromise(
						new ShellScriptError({
							message: `shell-script spawn failed: ${err.message}`,
							exitCode,
							signal,
							stdoutTail,
							stderrTail,
							timedOut,
						}),
					);
					return;
				}

				if (cancelled) {
					rejectPromise(
						new ShellScriptError({
							message: 'shell-script cancelled by user',
							exitCode,
							signal,
							stdoutTail,
							stderrTail,
							timedOut: false,
						}),
					);
					return;
				}

				if (timedOut) {
					rejectPromise(
						new ShellScriptError({
							message: `shell-script timed out after ${timeoutMs}ms`,
							exitCode,
							signal,
							stdoutTail,
							stderrTail,
							timedOut: true,
						}),
					);
					return;
				}

				if (exitCode !== 0) {
					rejectPromise(
						new ShellScriptError({
							message: `shell-script exit ${exitCode}${signal ? ` (signal=${signal})` : ''}`,
							exitCode,
							signal,
							stdoutTail,
							stderrTail,
							timedOut: false,
						}),
					);
					return;
				}

				resolvePromise({
					exitCode,
					durationMs,
					stdoutTail,
					stderrTail,
					command,
				});
			};

			child.once('error', (err) => settle(err, null, null));
			child.once('close', (code, signal) => settle(null, code, signal));
		});
	};
}
