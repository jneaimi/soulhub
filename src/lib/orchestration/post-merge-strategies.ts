/**
 * Repair strategies + cascade engine.
 *
 * Strategies are ordered, tier-tagged repair attempts. The cascade tries them
 * in priority order. Cheap deterministic fixes (Tier 1) run first; the generic
 * AI fix specialist (Tier 4) is the last resort.
 *
 * Design rules:
 *  - Strategies are idempotent: running twice on the same state yields the
 *    same result.
 *  - If a strategy creates a commit, the engine validates by re-running the
 *    step. If the step still fails, the commit is reverted before the next
 *    strategy runs.
 *  - Strategies that modify only gitignored state (caches, node_modules) may
 *    return 'applied' without a commit; validation re-runs the step.
 *  - Budget: 5 strategies or 10 minutes per step, whichever hits first.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '$lib/config.js';
import type { RepairAttempt } from './types.js';
import type { StepContext, StepDefinition, StepRunResult } from './post-merge-pipeline.js';

const execFileAsync = promisify(execFile);

const MAX_ATTEMPTS_PER_STEP = 5;
const MAX_TIME_PER_STEP_MS = 10 * 60 * 1000;
const AI_FIX_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_OUTPUT_CAPTURE = 3000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface StepFailure {
	stepId: string;
	stepName: string;
	output: string;
	citedFiles: string[];
}

export interface StrategyAction {
	/**
	 *  - 'no-action': strategy decided not to apply (predicate miss). Engine skips.
	 *  - 'applied':   strategy made changes (commit and/or side-effects). Engine
	 *                 validates by re-running the step.
	 */
	took: 'no-action' | 'applied';
	commitHash?: string;
	notes: string;
}

export interface RepairStrategy {
	id: string;
	name: string;
	tier: 0 | 1 | 2 | 3 | 4;
	/** Cheap predicate: should we even consider this strategy for this failure? */
	canHandle(failure: StepFailure): boolean;
	attempt(ctx: StepContext, failure: StepFailure): Promise<StrategyAction>;
}

export interface CascadeResult {
	success: boolean;
	attempts: RepairAttempt[];
	finalCommit?: string;
	finalOutput: string;
}

// ─── Allow-lists (safety guards) ───────────────────────────────────────────

const BUILD_CACHE_DIRS = [
	'.svelte-kit',
	'.next',
	'.turbo',
	'.nuxt',
	'dist',
	'build',
	'.cache',
	'target', // Rust
];

const MERGE_ARTIFACT_GLOBS = ['.git/MERGE_HEAD', '.git/MERGE_MSG'];

// ─── The cascade engine ────────────────────────────────────────────────────

export async function runRepairCascade(
	step: StepDefinition,
	ctx: StepContext,
	initialFailure: StepFailure,
): Promise<CascadeResult> {
	const attempts: RepairAttempt[] = [];
	const started = Date.now();
	let currentFailure = initialFailure;
	const triedStrategyIds = new Set<string>();

	while (attempts.length < MAX_ATTEMPTS_PER_STEP) {
		if (Date.now() - started > MAX_TIME_PER_STEP_MS) {
			ctx.log(`Repair cascade budget exhausted (${MAX_TIME_PER_STEP_MS / 60000} min)`);
			break;
		}

		// Pick next eligible strategy — tier ascending, skip already-tried
		const strategy = STRATEGIES
			.filter((s) => !triedStrategyIds.has(s.id))
			.filter((s) => {
				try {
					return s.canHandle(currentFailure);
				} catch {
					return false;
				}
			})
			.sort((a, b) => a.tier - b.tier)[0];

		if (!strategy) {
			ctx.log('No more applicable strategies');
			break;
		}

		triedStrategyIds.add(strategy.id);
		ctx.log(`Attempting ${strategy.name} (tier ${strategy.tier})...`);
		const headBefore = await currentHeadHash(ctx.projectPath);
		const attemptStart = Date.now();

		let action: StrategyAction;
		try {
			action = await strategy.attempt(ctx, currentFailure);
		} catch (err) {
			const msg = stringifyError(err).slice(0, 300);
			attempts.push({
				strategyId: strategy.id,
				strategyName: strategy.name,
				tier: strategy.tier,
				outcome: 'error',
				durationMs: Date.now() - attemptStart,
				notes: msg,
			});
			await safeResetHard(ctx.projectPath, headBefore);
			continue;
		}

		if (action.took === 'no-action') {
			attempts.push({
				strategyId: strategy.id,
				strategyName: strategy.name,
				tier: strategy.tier,
				outcome: 'no-action',
				durationMs: Date.now() - attemptStart,
				notes: action.notes,
			});
			continue;
		}

		// Strategy applied changes — validate by re-running the step
		const retry = await step.run().catch((err) => ({
			ok: false,
			output: stringifyError(err),
		}));

		if (retry.ok) {
			ctx.log(`${strategy.name}: FIXED`);
			attempts.push({
				strategyId: strategy.id,
				strategyName: strategy.name,
				tier: strategy.tier,
				outcome: 'applied-and-passed',
				commitHash: action.commitHash,
				durationMs: Date.now() - attemptStart,
				notes: action.notes,
			});
			return {
				success: true,
				attempts,
				finalCommit: action.commitHash,
				finalOutput: retry.output,
			};
		}

		// Step still fails — rollback and try next strategy
		ctx.log(`${strategy.name}: applied but step still fails; rolling back`);
		await safeResetHard(ctx.projectPath, headBefore);
		attempts.push({
			strategyId: strategy.id,
			strategyName: strategy.name,
			tier: strategy.tier,
			outcome: 'applied-but-still-failed',
			commitHash: action.commitHash,
			durationMs: Date.now() - attemptStart,
			notes: action.notes,
		});
		currentFailure = {
			stepId: step.id,
			stepName: step.name,
			output: retry.output,
			citedFiles: extractCitedFiles(retry.output),
		};
	}

	return {
		success: false,
		attempts,
		finalOutput: currentFailure.output,
	};
}

// ─── Strategies ────────────────────────────────────────────────────────────

/** Tier 1: wipe framework build caches and retry. No commit needed (caches are gitignored). */
const cleanRebuild: RepairStrategy = {
	id: 'clean-rebuild',
	name: 'Clean build caches',
	tier: 1,
	canHandle: (f) =>
		f.stepId === 'build' ||
		// Some typecheck errors are stale-cache artifacts from framework sync steps
		/\.svelte-kit|\.next|ENOENT.*\.svelte-kit/.test(f.output),
	async attempt(ctx) {
		const removed: string[] = [];
		for (const dir of BUILD_CACHE_DIRS) {
			const full = join(ctx.projectPath, dir);
			if (existsSync(full)) {
				await rm(full, { recursive: true, force: true }).catch(() => {});
				removed.push(dir);
			}
		}
		if (removed.length === 0) return { took: 'no-action', notes: 'no build caches found' };
		return { took: 'applied', notes: `wiped caches: ${removed.join(', ')}` };
	},
};

/** Tier 1: reinstall deps when a module listed in package.json is missing from node_modules. */
const reinstallDeps: RepairStrategy = {
	id: 'reinstall-deps',
	name: 'Reinstall dependencies',
	tier: 1,
	canHandle: (f) => /Cannot find (?:module|package) ['"][^'"]+['"]/.test(f.output),
	async attempt(ctx, failure) {
		const match = failure.output.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/);
		if (!match) return { took: 'no-action', notes: 'regex miss' };
		const missing = match[1];
		const baseName = missing.startsWith('@')
			? missing.split('/').slice(0, 2).join('/')
			: missing.split('/')[0];

		// Security: only auto-install if the package is already declared in
		// package.json. Prevents supply-chain attacks via typo'd imports.
		const pkg = await readPackageJson(ctx.projectPath);
		const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		if (!(baseName in deps)) {
			return {
				took: 'no-action',
				notes: `${baseName} not declared in package.json — won't auto-install`,
			};
		}

		// Clean slate install so lockfile + node_modules match package.json
		await rm(join(ctx.projectPath, 'node_modules'), { recursive: true, force: true }).catch(() => {});
		await rm(join(ctx.projectPath, 'package-lock.json'), { force: true }).catch(() => {});
		await execFileAsync('npm', ['install'], {
			cwd: ctx.projectPath,
			maxBuffer: 20 * 1024 * 1024,
			timeout: 3 * 60 * 1000,
			env: { ...process.env, NODE_ENV: 'development' },
		});

		const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ctx.projectPath });
		if (!dirty.trim()) {
			return { took: 'applied', notes: `reinstalled for ${baseName} (no lockfile change)` };
		}

		await execFileAsync('git', ['add', 'package-lock.json'], { cwd: ctx.projectPath });
		await execFileAsync(
			'git',
			['commit', '-m', `fix: reinstall deps for missing module ${baseName}`],
			{ cwd: ctx.projectPath },
		);
		const commit = await currentHeadHash(ctx.projectPath);
		return { took: 'applied', commitHash: commit, notes: `reinstalled for ${baseName}` };
	},
};

/** Tier 1: scoped `eslint --fix` on cited files only. */
const formatterAutofix: RepairStrategy = {
	id: 'formatter-autofix',
	name: 'Run eslint --fix on cited files',
	tier: 1,
	canHandle: (f) => f.stepId === 'lint' && f.citedFiles.length > 0,
	async attempt(ctx, failure) {
		// Prefer eslint via npm exec so project's pinned version is used
		try {
			await execFileAsync('npx', ['eslint', '--fix', ...failure.citedFiles], {
				cwd: ctx.projectPath,
				maxBuffer: 10 * 1024 * 1024,
				timeout: 60_000,
			});
		} catch {
			// eslint exits non-zero when it can't fix everything — that's still progress
		}

		const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ctx.projectPath });
		if (!dirty.trim()) return { took: 'no-action', notes: 'eslint --fix made no changes' };

		await execFileAsync('git', ['add', ...failure.citedFiles], { cwd: ctx.projectPath }).catch(() => {});
		await execFileAsync(
			'git',
			['commit', '-m', 'fix: eslint --fix post-merge'],
			{ cwd: ctx.projectPath },
		);
		const commit = await currentHeadHash(ctx.projectPath);
		return { took: 'applied', commitHash: commit, notes: `autofix applied to ${failure.citedFiles.length} files` };
	},
};

/** Tier 1: clean stale merge artifacts (MERGE_HEAD, .orig files). */
const cleanMergeArtifacts: RepairStrategy = {
	id: 'clean-merge-artifacts',
	name: 'Remove stale merge artifacts',
	tier: 1,
	canHandle: () => true, // cheap check; attempt() gates on actual presence
	async attempt(ctx) {
		const removed: string[] = [];
		for (const rel of MERGE_ARTIFACT_GLOBS) {
			const full = join(ctx.projectPath, rel);
			if (existsSync(full)) {
				await rm(full, { force: true }).catch(() => {});
				removed.push(rel);
			}
		}
		// Remove any *.orig files at root (common leftover from conflicted merges)
		try {
			const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ctx.projectPath });
			const origFiles = stdout.split('\n').filter((f) => f.endsWith('.orig'));
			for (const f of origFiles) {
				await rm(join(ctx.projectPath, f), { force: true }).catch(() => {});
				removed.push(f);
			}
		} catch { /* best effort */ }

		if (removed.length === 0) return { took: 'no-action', notes: 'no merge artifacts found' };
		return { took: 'applied', notes: `cleaned ${removed.length} artifacts` };
	},
};

/** Tier 4: fallback — the existing claude -p AI fix specialist, with lockfile-dodge guards. */
const aiFixSpecialist: RepairStrategy = {
	id: 'ai-fix-specialist',
	name: 'AI fix specialist (claude -p)',
	tier: 4,
	canHandle: () => true, // always eligible as last resort
	async attempt(ctx, failure) {
		const claudeBinary = config.resolved.claudeBinary;
		const headBefore = await currentHeadHash(ctx.projectPath);
		const prompt = buildFixPrompt(failure);

		try {
			await execFileAsync(
				claudeBinary,
				[
					'--print',
					'--dangerously-skip-permissions',
					'--strict-mcp-config',
					'--mcp-config', '{"mcpServers":{}}',
					'--no-session-persistence',
					'--output-format', 'text',
					prompt,
				],
				{
					cwd: ctx.projectPath,
					timeout: AI_FIX_TIMEOUT_MS,
					maxBuffer: 20 * 1024 * 1024,
				},
			);
		} catch (err) {
			ctx.log(`ai fix specialist exited: ${stringifyError(err).slice(0, 150)}`);
		}

		const headAfter = await currentHeadHash(ctx.projectPath);
		const isSourceStep = failure.stepId !== 'install';

		// Case A: AI committed something
		if (headAfter && headAfter !== headBefore) {
			if (isSourceStep && (await isLockfileOnlyFix(ctx.projectPath, headAfter))) {
				ctx.log(`Rejecting lockfile-only fix ${headAfter.slice(0, 7)} — ${failure.stepId} fixes source, not deps`);
				await safeResetHard(ctx.projectPath, headBefore);
				return { took: 'no-action', notes: 'rejected lockfile-only fix' };
			}
			return { took: 'applied', commitHash: headAfter, notes: 'AI committed a fix' };
		}

		// Case B: AI left dirty state — apply same lockfile-only gate
		const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ctx.projectPath });
		const dirtyFiles = dirty.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
		if (dirtyFiles.length === 0) return { took: 'no-action', notes: 'AI made no changes' };

		const dirtyIsLockOnly = dirtyFiles.every((f) => LOCKFILE_NAMES.has(f));
		if (isSourceStep && dirtyIsLockOnly) {
			ctx.log(`Discarding lockfile-only dirty state — ${failure.stepId} fixes source, not deps`);
			await execFileAsync('git', ['checkout', '--', ...dirtyFiles], { cwd: ctx.projectPath }).catch(() => {});
			return { took: 'no-action', notes: 'discarded lockfile-only dirty state' };
		}

		await execFileAsync('git', ['add', '-A'], { cwd: ctx.projectPath });
		await execFileAsync(
			'git',
			['commit', '-m', `fix: post-merge ${failure.stepId} repair (ai)`],
			{ cwd: ctx.projectPath },
		);
		const hash = await currentHeadHash(ctx.projectPath);
		return { took: 'applied', commitHash: hash, notes: 'AI modified files; committed for it' };
	},
};

// Registry — order matters only within same tier; engine sorts by tier
const STRATEGIES: RepairStrategy[] = [
	cleanMergeArtifacts,
	cleanRebuild,
	reinstallDeps,
	formatterAutofix,
	aiFixSpecialist,
];

// ─── Shared helpers (also used by pipeline.ts) ─────────────────────────────

export function extractCitedFiles(output: string): string[] {
	const pattern = /[\w+$./\-\[\]]+\.(?:ts|tsx|js|jsx|mjs|cjs|svelte|vue|py|rs|go|json|toml|yaml|yml)(?=[:(])/g;
	const matches = output.match(pattern) || [];
	const unique = Array.from(new Set(matches));
	return unique.filter((f) => !f.includes('node_modules/') && !f.startsWith('/')).slice(0, 10);
}

const LOCKFILE_NAMES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'Cargo.lock',
	'go.sum',
	'Pipfile.lock',
	'poetry.lock',
	'uv.lock',
]);

async function isLockfileOnlyFix(projectPath: string, commitHash: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			'git',
			['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash],
			{ cwd: projectPath },
		);
		const files = stdout.split('\n').map((f) => f.trim()).filter(Boolean);
		if (files.length === 0) return false;
		return files.every((f) => LOCKFILE_NAMES.has(f));
	} catch {
		return false;
	}
}

async function currentHeadHash(projectPath: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
		return stdout.trim();
	} catch {
		return '';
	}
}

async function safeResetHard(projectPath: string, commitHash: string): Promise<void> {
	if (!commitHash) return;
	await execFileAsync('git', ['reset', '--hard', commitHash], { cwd: projectPath }).catch(() => {});
}

async function readPackageJson(projectPath: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf-8'));
	} catch {
		return {};
	}
}

function stringifyError(err: unknown): string {
	const e = err as { stdout?: string; stderr?: string; message?: string };
	return (e.stderr || e.stdout || e.message || String(err)).toString();
}

function buildFixPrompt(failure: StepFailure): string {
	const scopeHint = fixScopeHint(failure.stepId);
	const fileDirective = failure.citedFiles.length > 0
		? `\nFILES YOU MUST EDIT (cited in error output):\n${failure.citedFiles.map((f) => `  - ${f}`).join('\n')}\n\nYour fix MUST modify at least one of these files.\n`
		: '';

	return `You are a POST-MERGE FIX SPECIALIST. Fix the broken step with the MINIMUM change possible.

FAILING STEP: ${failure.stepName} (${failure.stepId})

FAILURE OUTPUT (last ~3KB):
\`\`\`
${failure.output.slice(-MAX_OUTPUT_CAPTURE)}
\`\`\`
${fileDirective}
RULES:
1. ${scopeHint}
2. When the error cites a source file (*.ts, *.tsx, *.svelte, *.py, *.rs, *.go), you MUST edit that source file. It's where the bug is.
3. Regenerating a lockfile is NEVER a valid fix for a type/syntax error. Lockfile-only commits will be rejected and reverted.
4. Make the smallest possible change. No refactoring. No reformatting.
5. Do NOT run the failing step yourself — the orchestrator re-runs to verify.
6. After fixing: git add -A && git commit -m "fix: post-merge ${failure.stepId} repair"
7. If you cannot determine a safe fix, do nothing and exit. Never guess.`;
}

function fixScopeHint(stepId: string): string {
	switch (stepId) {
		case 'install':
			return 'Fix dependency manifest issues only (package.json, pyproject.toml, Cargo.toml, go.mod). Never add deps not already referenced by imports.';
		case 'typecheck':
			return 'Fix type errors. Edit the exact files and lines cited. Prefer type fixes over logic changes.';
		case 'build':
			return 'Fix build configuration or the exact files cited. Do not touch unrelated code.';
		case 'lint':
			return 'Run the linter with --fix if supported, otherwise edit only flagged lines.';
		case 'test':
			return 'Fix obvious regressions (imports, signatures). Do not alter assertions unless clearly broken pre-merge.';
		default:
			return 'Fix only the specific error reported. Minimal change, no refactoring.';
	}
}

// Exported for unit tests
export const __test__ = {
	STRATEGIES,
	cleanRebuild,
	reinstallDeps,
	formatterAutofix,
	cleanMergeArtifacts,
	aiFixSpecialist,
	isLockfileOnlyFix,
};
