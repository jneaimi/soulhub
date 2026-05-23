/**
 * `invocation.kind === 'script'` runner — subprocess via `child_process.spawn`.
 *
 * The orchestrator validates user-supplied args via the skill's compiled Zod
 * schema BEFORE this runner sees them. Args are JSON-stringified and passed
 * as the final argv element so any argv-based skill (most of the seed
 * roster: `research`, `media`, `diagram`, `recipe`, `brain`) can parse it
 * with `process.argv[2]`. Skills that need a different convention can pre-
 * format the cmd in their overlay (the `cmd` array is taken verbatim).
 *
 * stdout is captured and returned to the model. stderr is captured separately
 * and surfaced in the `error` field on non-zero exit.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { skillsDir } from '../store.js';
import type { SkillInvocation, SkillRunResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Run a script-kind skill. `args` is the parsed (Zod-validated) input. */
export async function runScriptSkill(
	skillName: string,
	invocation: Extract<SkillInvocation, { kind: 'script' }>,
	args: unknown,
): Promise<SkillRunResult> {
	const startedAt = Date.now();
	const argsJson = JSON.stringify(args ?? {});

	const expanded = invocation.cmd.map(expandHome);
	if (expanded.length === 0) {
		return {
			ok: false,
			error: 'invocation.cmd is empty',
			durationMs: Date.now() - startedAt,
		};
	}
	const [command, ...rest] = expanded;
	const argv = [...rest, argsJson];
	const cwd = invocation.cwd ? expandHome(invocation.cwd) : resolve(skillsDir(), skillName);
	const timeout = invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS;

	return await new Promise<SkillRunResult>((resolveResult) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const child = spawn(command, argv, {
			cwd,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		child.stdout.on('data', (buf: Buffer) => {
			stdout += buf.toString('utf8');
		});
		child.stderr.on('data', (buf: Buffer) => {
			stderr += buf.toString('utf8');
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeout);

		child.on('error', (err) => {
			clearTimeout(timer);
			resolveResult({
				ok: false,
				error: `spawn failed: ${err.message}`,
				durationMs: Date.now() - startedAt,
			});
		});

		child.on('exit', (code) => {
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			if (timedOut) {
				return resolveResult({
					ok: false,
					error: `timeout after ${timeout}ms; partial stdout (${stdout.length} bytes)`,
					durationMs,
				});
			}
			if (code === 0) {
				return resolveResult({ ok: true, output: stdout.trim(), durationMs });
			}
			return resolveResult({
				ok: false,
				error:
					stderr.trim() ||
					stdout.trim() ||
					`subprocess exited with code ${code ?? 'null'}`,
				durationMs,
			});
		});
	});
}

function expandHome(p: string): string {
	if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
	if (p === '~') return homedir();
	return p;
}
