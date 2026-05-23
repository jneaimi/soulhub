import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { PlaybookHook, PlaybookPrerequisite } from './types.js';

const execFileAsync = promisify(execFile);

export interface HookResult {
	id: string;
	status: 'completed' | 'failed' | 'timeout';
	output?: Record<string, unknown>;  // parsed JSON output
	stdout?: string;
	error?: string;
	durationMs: number;
}

export interface PrerequisiteCheckResult {
	name: string;
	available: boolean;
	install?: string;
	required: boolean;
}

/**
 * Run a single hook script.
 * Hooks are regular shell commands — no LLM involved.
 */
export async function runHook(
	hook: PlaybookHook,
	playbookDir: string,
	resolvedInputs: Record<string, string | number>,
): Promise<HookResult> {
	const startMs = Date.now();
	const timeoutSec = hook.timeout || 30;

	// Resolve $inputs.X in the command
	let command = hook.run;
	for (const [key, value] of Object.entries(resolvedInputs)) {
		command = command.replace(new RegExp(`\\$inputs\\.${key}`, 'g'), String(value));
	}

	try {
		const { stdout } = await execFileAsync('bash', ['-c', command], {
			cwd: playbookDir,
			timeout: timeoutSec * 1000,
			maxBuffer: 1024 * 1024, // 1MB
			env: { ...process.env },
		});

		let output: Record<string, unknown> | undefined;

		// If hook declares an output file, read and parse it
		if (hook.output) {
			const outputPath = join(playbookDir, hook.output);
			if (existsSync(outputPath)) {
				try {
					const raw = await readFile(outputPath, 'utf-8');
					output = JSON.parse(raw);
				} catch {
					// Output file exists but isn't valid JSON — treat stdout as output
				}
			}
		}

		// If no file output, try parsing stdout as JSON
		if (!output && stdout.trim()) {
			try {
				output = JSON.parse(stdout.trim());
			} catch {
				// stdout isn't JSON — that's fine
			}
		}

		return {
			id: hook.id,
			status: 'completed',
			output,
			stdout: stdout.trim(),
			durationMs: Date.now() - startMs,
		};
	} catch (error: unknown) {
		const err = error as { killed?: boolean; code?: string; message?: string };
		if (err.killed || err.code === 'ETIMEDOUT') {
			return {
				id: hook.id,
				status: 'timeout',
				error: `Hook "${hook.id}" timed out after ${timeoutSec}s`,
				durationMs: Date.now() - startMs,
			};
		}
		return {
			id: hook.id,
			status: 'failed',
			error: err.message || String(error),
			durationMs: Date.now() - startMs,
		};
	}
}

/**
 * Run a list of hooks sequentially.
 * Returns all results. Failures are logged but don't stop execution.
 */
export async function runHooks(
	hooks: PlaybookHook[],
	playbookDir: string,
	resolvedInputs: Record<string, string | number>,
): Promise<HookResult[]> {
	const results: HookResult[] = [];
	for (const hook of hooks) {
		const result = await runHook(hook, playbookDir, resolvedInputs);
		results.push(result);
		if (result.status !== 'completed') {
			console.warn(`[playbook/hooks] Hook "${hook.id}" ${result.status}: ${result.error}`);
		} else {
			console.log(`[playbook/hooks] Hook "${hook.id}" completed in ${result.durationMs}ms`);
		}
	}
	return results;
}

/**
 * Check prerequisites — returns which are available and which are missing.
 */
export async function checkPrerequisites(
	prerequisites: PlaybookPrerequisite[],
): Promise<PrerequisiteCheckResult[]> {
	const results: PrerequisiteCheckResult[] = [];

	for (const prereq of prerequisites) {
		try {
			await execFileAsync('bash', ['-c', prereq.check], { timeout: 5000 });
			results.push({
				name: prereq.name,
				available: true,
				required: prereq.required !== false,
			});
		} catch {
			results.push({
				name: prereq.name,
				available: false,
				install: prereq.install,
				required: prereq.required !== false,
			});
		}
	}

	return results;
}

/**
 * Extract dynamic timeout from hook results.
 * Looks for 'estimated_timeout_sec' in any hook's JSON output.
 */
export function extractTimeout(hookResults: HookResult[]): number | null {
	for (const result of hookResults) {
		if (result.output && typeof result.output.estimated_timeout_sec === 'number') {
			return result.output.estimated_timeout_sec;
		}
	}
	return null;
}

/**
 * Extract scan summary from hook results.
 * Looks for 'summary' field in any hook's JSON output.
 */
export function extractScanSummary(hookResults: HookResult[]): string | null {
	for (const result of hookResults) {
		if (result.output && typeof result.output.summary === 'string') {
			return result.output.summary;
		}
	}
	return null;
}
