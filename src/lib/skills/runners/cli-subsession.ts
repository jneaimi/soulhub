/**
 * `invocation.kind === 'cli-subsession'` runner — `claude -p "<prompt>"` for
 * skills that need the full Claude reasoning loop. Last-resort, heavyweight;
 * the seed roster doesn't use this kind, but it's available for power-user
 * overlays.
 *
 * Builds the prompt from the skill's `SKILL.md` body + a short args block,
 * the same shape as the prompt-injection runner. Then spawns `claude -p`
 * with that prompt and any extra_args, capturing stdout.
 */

import { spawn } from 'node:child_process';

import { readSkillBody } from '../prompt.js';
import type { SkillInvocation, SkillRunResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runCliSubsessionSkill(
	skillName: string,
	invocation: Extract<SkillInvocation, { kind: 'cli-subsession' }>,
	args: unknown,
): Promise<SkillRunResult> {
	const startedAt = Date.now();
	const body = readSkillBody(skillName);
	if (body.missing) {
		return {
			ok: false,
			error: `SKILL.md not found for "${skillName}"`,
			durationMs: Date.now() - startedAt,
		};
	}
	const argsLine = formatArgs(args);
	const prompt = argsLine
		? `${body.body}\n\n## Invocation args\n${argsLine}`
		: body.body;
	const argv = ['-p', prompt, ...(invocation.extra_args ?? [])];
	const timeout = invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS;

	return await new Promise<SkillRunResult>((resolveResult) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const child = spawn('claude', argv, {
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
				error: `claude -p spawn failed: ${err.message}`,
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
					`claude -p exited with code ${code ?? 'null'}`,
				durationMs,
			});
		});
	});
}

function formatArgs(args: unknown): string {
	if (args === undefined || args === null) return '';
	if (typeof args === 'string') return args.trim() ? args.trim() : '';
	try {
		const json = JSON.stringify(args, null, 2);
		return json === '{}' || json === '[]' ? '' : json;
	} catch {
		return String(args);
	}
}
