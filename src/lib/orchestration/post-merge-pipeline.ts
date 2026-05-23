/**
 * Post-merge developer checklist pipeline.
 *
 * Mimics what a senior developer does after landing a merge:
 *   install → typecheck → lint → test → build
 *
 * Language-agnostic: the step list comes from a per-language adapter (see
 * ./post-merge-adapters.ts). The runner is identical across languages — only
 * the commands each step invokes change.
 *
 * Each step is blocking or advisory. Advisory failures log and continue.
 * Blocking failures engage the tiered repair cascade (./post-merge-strategies.ts)
 * — cheap deterministic strategies first, AI fallback last.
 */

import { emitRunEvent } from './events.js';
import { detectAdapter } from './post-merge-adapters.js';
import { runRepairCascade, extractCitedFiles } from './post-merge-strategies.js';
import type { PostMergeStepResult } from './types.js';

const MAX_OUTPUT_CAPTURE = 3000;

// ─── Public types (also used by adapters + strategies) ────────────────────

export interface StepContext {
	runId: string;
	projectPath: string;
	/** Append-only log that bubbles back into run.mergeLog */
	log: (line: string) => void;
}

export interface StepRunResult {
	ok: boolean;
	output: string;
}

export interface StepDefinition {
	id: string;
	name: string;
	blocking: boolean;
	/** Return true to skip the step (status becomes 'skipped'). Optional. */
	shouldSkip?: () => boolean | Promise<boolean>;
	run: () => Promise<StepRunResult>;
}

// ─── Entry point ───────────────────────────────────────────────────────────

export interface PipelineOptions {
	/**
	 * If true, a blocking step failure does NOT engage the repair cascade —
	 * the step is simply marked failed. Used for pre-merge worker validation
	 * where we want to *detect* problems, not mutate the worker's branch.
	 */
	skipRepair?: boolean;
	/** SSE event name to emit per step. Defaults to 'post_merge_step'. */
	eventName?: string;
}

export async function runPostMergePipeline(
	runId: string,
	projectPath: string,
	log: (line: string) => void,
	options: PipelineOptions = {},
): Promise<{ allPassed: boolean; results: PostMergeStepResult[] }> {
	const adapter = detectAdapter(projectPath);
	log(`Project type: ${adapter.type}`);

	const ctx: StepContext = { runId, projectPath, log };
	const steps = await adapter.buildSteps(ctx);
	const results: PostMergeStepResult[] = [];
	const eventName = options.eventName ?? 'post_merge_step';

	for (const step of steps) {
		const r = await runStep(step, ctx, options, eventName);
		results.push(r);
		emitRunEvent(runId, eventName, r);

		// Blocking failure halts the pipeline — downstream steps would run on
		// a broken tree (e.g. test after install failed).
		if (r.blocking && r.status === 'failed') break;
	}

	const allPassed = results.every(
		(r) => r.status === 'passed' || r.status === 'fixed' || r.status === 'skipped' || !r.blocking,
	);
	return { allPassed, results };
}

// ─── Per-step runner ───────────────────────────────────────────────────────

async function runStep(
	step: StepDefinition,
	ctx: StepContext,
	options: PipelineOptions,
	eventName: string,
): Promise<PostMergeStepResult> {
	const base: PostMergeStepResult = {
		id: step.id,
		name: step.name,
		status: 'running',
		blocking: step.blocking,
		startedAt: new Date().toISOString(),
	};

	if (step.shouldSkip && (await step.shouldSkip())) {
		return {
			...base,
			status: 'skipped',
			completedAt: new Date().toISOString(),
			durationMs: 0,
			output: 'step not applicable to this project',
		};
	}

	emitRunEvent(ctx.runId, eventName, base);
	ctx.log(`${step.name}: running...`);

	const started = Date.now();
	const first = await step.run().catch((err) => ({
		ok: false,
		output: (err as Error).message || String(err),
	}));

	if (first.ok) {
		const dur = Date.now() - started;
		ctx.log(`${step.name}: PASSED (${Math.round(dur / 1000)}s)`);
		return {
			...base,
			status: 'passed',
			output: truncate(first.output),
			completedAt: new Date().toISOString(),
			durationMs: dur,
		};
	}

	// Advisory failure — no cascade, just log and continue
	if (!step.blocking) {
		const dur = Date.now() - started;
		ctx.log(`${step.name}: FAILED (advisory, continuing)`);
		return {
			...base,
			status: 'failed',
			output: truncate(first.output),
			completedAt: new Date().toISOString(),
			durationMs: dur,
		};
	}

	// Validation mode: don't engage the repair cascade — just report the failure.
	// Callers want to *detect* problems, not mutate the target tree.
	if (options.skipRepair) {
		const dur = Date.now() - started;
		ctx.log(`${step.name}: FAILED (validation mode, no repair)`);
		return {
			...base,
			status: 'failed',
			output: truncate(first.output),
			completedAt: new Date().toISOString(),
			durationMs: dur,
		};
	}

	// Blocking failure — engage the repair cascade
	ctx.log(`${step.name}: FAILED, engaging repair cascade...`);
	const cascade = await runRepairCascade(step, ctx, {
		stepId: step.id,
		stepName: step.name,
		output: first.output,
		citedFiles: extractCitedFiles(first.output),
	});

	const dur = Date.now() - started;

	if (cascade.success) {
		ctx.log(`${step.name}: FIXED by cascade (${cascade.attempts.length} attempts, ${Math.round(dur / 1000)}s)`);
		return {
			...base,
			status: 'fixed',
			output: truncate(cascade.finalOutput),
			fixCommit: cascade.finalCommit,
			repairAttempts: cascade.attempts,
			completedAt: new Date().toISOString(),
			durationMs: dur,
		};
	}

	ctx.log(`${step.name}: cascade exhausted — manual intervention needed (${cascade.attempts.length} attempts tried)`);
	return {
		...base,
		status: 'failed',
		output: truncate(
			`original failure:\n${first.output}\n\ncascade exhausted after ${cascade.attempts.length} strategies.`,
		),
		repairAttempts: cascade.attempts,
		completedAt: new Date().toISOString(),
		durationMs: dur,
	};
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT_CAPTURE) return s;
	return `...[truncated ${s.length - MAX_OUTPUT_CAPTURE} chars]...\n${s.slice(-MAX_OUTPUT_CAPTURE)}`;
}
