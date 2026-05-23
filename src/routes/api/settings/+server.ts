import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { soulHubSettingsPath } from '$lib/paths.js';
import { ConfigSchema } from '$lib/config.schema.js';
import { config, reloadConfig } from '$lib/config.js';
import { reconcileFromSettings } from '$lib/scheduler/index.js';

const SETTINGS_PATH = soulHubSettingsPath();

/** Deep-merge `patch` into `base`, mutating a fresh copy. Object values
 *  recurse; arrays and primitives are full-replaced (merging arrays by
 *  index is a footgun — `allowFrom: ["+971..."]` would silently union
 *  with the schema-default `[]`).
 *
 *  Existed because the previous shallow `{...existing, ...patch}` let a
 *  partial POST silently wipe untouched siblings: posting `{paths: …}`
 *  would replace `channels` with the schema-default channels, flipping
 *  `worker.enabled`, `heartbeat.enabled`, `commitments.enabled` back to
 *  false. */
function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === null || patch === undefined) return base;
	if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
	if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;

	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		out[k] = deepMerge(out[k], v);
	}
	return out as T;
}

/** GET /api/settings — read current settings */
export const GET: RequestHandler = async () => {
	try {
		const raw = await readFile(SETTINGS_PATH, 'utf-8');
		return json(JSON.parse(raw));
	} catch {
		return json({ error: 'Settings file not found' }, { status: 404 });
	}
};

/** POST /api/settings — validate and save settings.
 *
 *  Flow: parse body as raw JSON → deep-merge into existing settings →
 *  validate the merged object against the full `ConfigSchema`. The
 *  earlier design ran user input through `ConfigSchema.partial().safeParse()`
 *  *before* merging, which let the schema's `.prefault({})` fire on
 *  fields the user never sent (top-level `channels`, `paths`, etc.) and
 *  the subsequent shallow merge then **replaced** the existing block,
 *  silently flipping unrelated fields like `worker.enabled` back to
 *  schema defaults. Validating after the merge means missing fields
 *  default only when neither the existing settings nor the patch
 *  supplied them. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const patch = await request.json();
		if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
			return json({ error: 'Body must be a JSON object.' }, { status: 400 });
		}

		let existing: Record<string, unknown> = {};
		try {
			const raw = await readFile(SETTINGS_PATH, 'utf-8');
			existing = JSON.parse(raw);
		} catch {
			/* start fresh */
		}

		const candidate = deepMerge(existing, patch);

		const result = ConfigSchema.safeParse(candidate);
		if (!result.success) {
			return json(
				{
					error: 'Validation failed',
					issues: result.error.issues.map((i) => ({
						path: i.path.join('.'),
						message: i.message,
					})),
				},
				{ status: 400 },
			);
		}

		await mkdir(dirname(SETTINGS_PATH), { recursive: true });
		await writeFile(SETTINGS_PATH, JSON.stringify(candidate, null, 2) + '\n', 'utf-8');

		// Hot-reload the in-memory config so live consumers (channel adapters,
		// route registries, etc.) see the new values without a restart. Path
		// fields are mutated too but downstream watchers typically cached
		// absolute paths at startup — those still need a restart.
		const reload = reloadConfig();

		// Pull scheduler tasks back into the live registry. Add/remove/update
		// happen idempotently — already-correct tasks stay running.
		let schedulerReconciled: number | null = null;
		try {
			const r = reconcileFromSettings(config.scheduler);
			schedulerReconciled =
				r.registered.length + r.unregistered.length + r.updated.length;
		} catch (err) {
			console.error('[settings] scheduler reconcile failed:', err);
		}

		return json({
			ok: true,
			settings: candidate,
			reloaded: reload.ok,
			reloadError: reload.error,
			schedulerReconciled,
		});
	} catch (err) {
		return json({ error: `Failed to save: ${(err as Error).message}` }, { status: 500 });
	}
};
