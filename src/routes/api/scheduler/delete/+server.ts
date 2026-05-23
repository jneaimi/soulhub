import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile, writeFile } from 'node:fs/promises';
import { soulHubSettingsPath } from '$lib/paths.js';
import { ConfigSchema } from '$lib/config.schema.js';
import { config, reloadConfig } from '$lib/config.js';
import { reconcileFromSettings } from '$lib/scheduler/index.js';
import { freshCache } from '$lib/contracts/registry.js';

const SETTINGS_PATH = soulHubSettingsPath();

/** Shell-script tasks that must NOT be deletable even though the owner-gate
 *  would otherwise allow it (ADR-009 P3 protected denylist).
 *
 *  The two falsifier *probes* are hardcoded: they are shell-scripts but are not
 *  registered as contracts, so the registry pass below cannot find them, and
 *  deleting one silently drops a governance regression signal (e.g.
 *  `soul-cli-uptake-check` is the ADR-001 soul-CLI-uptake falsifier).
 *
 *  Every task id a contract names as its falsifier is added dynamically — today
 *  those are all non-shell-script types (already blocked by the owner-gate), but
 *  a future shell-script falsifier is then protected automatically without a
 *  code change. */
function protectedTaskIds(): Set<string> {
	const ids = new Set<string>(['soul-cli-uptake-check', 'claude-cli-goal-flag-probe']);
	const reg = freshCache();
	if (reg) {
		for (const c of reg.contracts) {
			const f = (c.falsifier ?? '').trim();
			if (f && !/[ /]/.test(f)) ids.add(f); // task-id-shaped, not a shell command
		}
	}
	return ids;
}

/** POST /api/scheduler/delete — remove an operator-owned task from settings.
 *
 *  Owner-gate (ADR-009 B1): only `type: shell-script` tasks are deletable; every
 *  other type is a code-wired engine task and is disable-only. Falsifier-probe
 *  shell-scripts are additionally protected by the denylist. Removal flows
 *  through the same write → reload → reconcile path as POST /api/settings, so
 *  the cron registration is torn down by `reconcileFromSettings`.
 *
 *  Body: { taskId: string }
 *  Response: { ok, removed, remaining, reconciled } or { error }. */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Body must be JSON.' }, { status: 400 });
	}
	const taskId = (body as { taskId?: unknown })?.taskId;
	if (typeof taskId !== 'string' || taskId.length === 0) {
		return json({ error: 'taskId is required (non-empty string).' }, { status: 400 });
	}

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
	} catch {
		return json({ error: 'Settings file not found.' }, { status: 500 });
	}

	const scheduler = (settings.scheduler ?? {}) as { tasks?: Array<Record<string, unknown>> };
	const tasks = Array.isArray(scheduler.tasks) ? scheduler.tasks : [];
	const target = tasks.find((t) => t.id === taskId);
	if (!target) {
		return json({ error: `Unknown task: ${taskId}` }, { status: 404 });
	}

	// Owner-gate: system (code-wired) tasks are disable-only.
	if (target.type !== 'shell-script') {
		return json(
			{ error: `'${taskId}' is a system task (type: ${target.type}) — disable-only, not deletable.` },
			{ status: 403 },
		);
	}
	// Denylist: falsifier probes / contract-named tasks.
	if (protectedTaskIds().has(taskId)) {
		return json(
			{
				error: `'${taskId}' is a protected falsifier — deleting it would drop a governance signal. Disable it instead.`,
			},
			{ status: 403 },
		);
	}

	const remaining = tasks.filter((t) => t.id !== taskId);
	const candidate = { ...settings, scheduler: { ...scheduler, tasks: remaining } };

	// Re-validate the whole config before writing — a delete should never be able
	// to leave settings.json in a shape the schema rejects.
	const parsed = ConfigSchema.safeParse(candidate);
	if (!parsed.success) {
		return json(
			{
				error: 'Resulting config failed validation',
				issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
			},
			{ status: 400 },
		);
	}

	await writeFile(SETTINGS_PATH, JSON.stringify(candidate, null, 2) + '\n', 'utf-8');
	reloadConfig();
	let reconciled = 0;
	try {
		const r = reconcileFromSettings(config.scheduler);
		reconciled = r.registered.length + r.unregistered.length + r.updated.length;
	} catch (err) {
		console.error('[scheduler/delete] reconcile failed:', err);
	}

	return json({ ok: true, removed: taskId, remaining: remaining.length, reconciled });
};
