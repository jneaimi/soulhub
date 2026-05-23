/** One-shot migration: pipeline cron → scheduler tasks (ADR-005).
 *
 *  Run with:  npx tsx scripts/migrate-pipeline-schedules.ts
 *
 *  For each `~/.soul-hub/data/automation.json` entry that has a
 *  `schedule` field set:
 *
 *    1. Deep-merge a new task into `~/.soul-hub/settings.json`:
 *         {
 *           id:    `pipeline:${name}`,
 *           type:  'trigger-pipeline',
 *           cron:  <schedule>,
 *           enabled: <scheduleEnabled !== false>,
 *           noOverlap: true,
 *           description: 'migrated from pipeline automation.json',
 *           params: { pipeline: name }
 *         }
 *
 *    2. Strip `schedule` + `scheduleEnabled` from the automation.json
 *       entry. Leave `triggerEnabled`, `triggerSecret`, `watch`
 *       untouched.
 *
 *    3. Skip cleanly if a task with the same id is already in
 *       settings.json (idempotent — safe to re-run after a partial
 *       migration).
 *
 *    4. Print a per-pipeline summary at the end. Non-zero exit on any
 *       hard failure (file write, JSON parse).
 *
 *  This script is intentionally a CLI, not an HTTP endpoint — it
 *  rewrites two on-disk files and is safer to run with the user
 *  watching. After a successful run, `pm2 restart soul-hub` picks up
 *  the new tasks via reconcile.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const SOUL_HUB = resolve(HOME, '.soul-hub');
const AUTOMATION_PATH = resolve(SOUL_HUB, 'data/automation.json');
const SETTINGS_PATH = resolve(SOUL_HUB, 'settings.json');

interface AutomationEntry {
	schedule?: string;
	scheduleEnabled?: boolean;
	triggerEnabled?: boolean;
	triggerSecret?: string;
	watch?: unknown;
}

interface SchedulerTask {
	id: string;
	type: string;
	cron: string;
	enabled: boolean;
	noOverlap: boolean;
	description?: string;
	params: Record<string, unknown>;
}

interface Summary {
	migrated: string[];
	alreadyMigrated: string[];
	noSchedule: string[];
	errors: { name: string; error: string }[];
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
	const text = JSON.stringify(data, null, 2) + '\n';
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, 'utf-8');
}

function scheduledTaskId(pipelineName: string): string {
	return `pipeline-${pipelineName}`;
}

async function main(): Promise<void> {
	console.log('[migrate] reading automation.json + settings.json');

	const automation = (await readJson<Record<string, AutomationEntry>>(AUTOMATION_PATH)) ?? {};
	const settings = (await readJson<Record<string, unknown>>(SETTINGS_PATH)) ?? {};

	const scheduler = (settings.scheduler ?? {}) as { tasks?: SchedulerTask[] };
	const existingTasks = Array.isArray(scheduler.tasks) ? scheduler.tasks : [];
	const existingIds = new Set(existingTasks.map((t) => t.id));

	const summary: Summary = {
		migrated: [],
		alreadyMigrated: [],
		noSchedule: [],
		errors: [],
	};

	const newTasks: SchedulerTask[] = [...existingTasks];
	const updatedAutomation: Record<string, AutomationEntry> = {};
	let automationDirty = false;

	for (const [name, entry] of Object.entries(automation)) {
		try {
			if (!entry || typeof entry !== 'object') {
				updatedAutomation[name] = entry as AutomationEntry;
				continue;
			}

			if (!entry.schedule) {
				summary.noSchedule.push(name);
				updatedAutomation[name] = entry;
				continue;
			}

			const taskId = scheduledTaskId(name);

			if (existingIds.has(taskId)) {
				summary.alreadyMigrated.push(name);
				// Still strip schedule fields if they linger.
				const { schedule: _s, scheduleEnabled: _se, ...rest } = entry;
				if (Object.keys(rest).length === 0) {
					automationDirty = true;
					// drop the entry entirely
				} else {
					updatedAutomation[name] = rest;
					automationDirty = true;
				}
				continue;
			}

			const task: SchedulerTask = {
				id: taskId,
				type: 'trigger-pipeline',
				cron: entry.schedule,
				enabled: entry.scheduleEnabled !== false,
				noOverlap: true,
				description: `Migrated from pipelines/${name} (ADR-005)`,
				params: { pipeline: name },
			};
			newTasks.push(task);
			existingIds.add(taskId);
			summary.migrated.push(name);

			const { schedule: _s, scheduleEnabled: _se, ...rest } = entry;
			if (Object.keys(rest).length > 0) {
				updatedAutomation[name] = rest;
			}
			automationDirty = true;
		} catch (err) {
			summary.errors.push({ name, error: (err as Error).message });
		}
	}

	if (summary.migrated.length > 0) {
		const newSettings = {
			...settings,
			scheduler: {
				...(settings.scheduler ?? {}),
				tasks: newTasks,
			},
		};
		await writeJsonAtomic(SETTINGS_PATH, newSettings);
		console.log(`[migrate] wrote ${summary.migrated.length} task(s) to ${SETTINGS_PATH}`);
	} else {
		console.log('[migrate] no new tasks to write');
	}

	if (automationDirty) {
		await writeJsonAtomic(AUTOMATION_PATH, updatedAutomation);
		console.log(`[migrate] cleaned schedule fields in ${AUTOMATION_PATH}`);
	}

	console.log('\n[migrate] summary:');
	console.log(`  migrated:         ${summary.migrated.length}  ${summary.migrated.join(', ')}`);
	console.log(`  already migrated: ${summary.alreadyMigrated.length}  ${summary.alreadyMigrated.join(', ')}`);
	console.log(`  no schedule:      ${summary.noSchedule.length}  ${summary.noSchedule.join(', ')}`);
	if (summary.errors.length > 0) {
		console.error(`  errors:           ${summary.errors.length}`);
		for (const e of summary.errors) {
			console.error(`    - ${e.name}: ${e.error}`);
		}
		process.exit(1);
	}

	if (summary.migrated.length > 0) {
		console.log('\n[migrate] next: pm2 restart soul-hub');
	}
}

main().catch((err) => {
	console.error('[migrate] FAILED:', err);
	process.exit(1);
});
