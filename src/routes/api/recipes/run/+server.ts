import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runRecipe, resolveRecipePath } from '$lib/naseej/runner.js';
import type { DispatchMode } from '$lib/agents/dispatch/index.js';

/** POST /api/recipes/run — execute a Naseej recipe.
 *
 *  Body: {
 *    recipe: string,                          // name or repo-relative .yaml path
 *    inputs?: Record<string, unknown>,
 *    mode?: 'production' | 'test' | 'oneshot', // ADR-005 CP2 + ADR-007 S3 —
 *                                             //   dispatch mode for agent
 *                                             //   steps. Default 'production'
 *                                             //   (claude-pty + /goal).
 *                                             //   'test' uses claude-cli-flag
 *                                             //   with hard budget caps for
 *                                             //   cheap CI smokes.
 *                                             //   'oneshot' uses claude-cli-
 *                                             //   flag with NO caps — for
 *                                             //   structurally single-pass
 *                                             //   agents in production
 *                                             //   (peer-brief-synth).
 *    run_id?: string                          // ADR-005 CP3 — caller-supplied
 *                                             //   runId (must be unique, kebab/
 *                                             //   uuid/hex). When omitted, an
 *                                             //   8-char id is generated and
 *                                             //   only known after the run
 *                                             //   completes (no cancel window).
 *  }
 *
 *  Response: { run_id, recipe, status, started_at, finished_at, duration_ms, steps, failed_step? }
 *
 *  Status: 200 on success, 422 on failed-run (recipe loaded but a step failed),
 *  400 on bad input, 500 on runner crash.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { recipe, inputs, mode, run_id: runId } = (body as Record<string, unknown>) ?? {};
	if (typeof recipe !== 'string' || !recipe) {
		return json({ error: 'recipe (string) is required' }, { status: 400 });
	}
	if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
		return json({ error: 'inputs must be an object' }, { status: 400 });
	}
	if (mode !== undefined && mode !== 'production' && mode !== 'test' && mode !== 'oneshot') {
		return json(
			{ error: 'mode must be "production", "test", or "oneshot"' },
			{ status: 400 },
		);
	}
	if (runId !== undefined) {
		if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
			return json(
				{ error: `run_id must match ${RUN_ID_RE.source} (4-64 alphanumerics, -, _)` },
				{ status: 400 },
			);
		}
	}

	let recipePath: string;
	try {
		recipePath = resolveRecipePath(recipe);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 400 });
	}

	try {
		const result = await runRecipe(
			recipePath,
			inputs as Record<string, unknown> | undefined,
			{
				mode: mode as DispatchMode | undefined,
				runId: runId as string | undefined,
			},
		);
		const status = result.status === 'success' ? 200 : 422;
		return json(result, { status });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
