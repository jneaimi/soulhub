import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { CronExpressionParser } from 'cron-parser';
import { list, runHistory } from '$lib/scheduler/index.js';
import { config } from '$lib/config.js';

/** GET /api/scheduler/tasks — list tasks with full UI metadata.
 *
 *  Merges three sources:
 *    - settings.scheduler.tasks  → type, enabled, params, description
 *    - registry (live)           → next-run, last-run, last-status
 *    - runHistory                → recent N runs for inline expand
 *
 *  Disabled tasks (enabled=false) are NOT in the registry but ARE in
 *  settings — they still surface here so the UI can render their gray
 *  row + "Enable" affordance. */
export const GET: RequestHandler = async ({ url }) => {
	const historyLimit = parseInt(url.searchParams.get('historyLimit') || '10', 10);
	const liveTasks = list();
	const liveById = new Map(liveTasks.map((t) => [t.id, t]));

	const settingsTasks = config.scheduler?.tasks ?? [];

	const merged = settingsTasks.map((spec) => {
		const live = liveById.get(spec.id);
		const recent = runHistory(spec.id, historyLimit);

		// For disabled tasks, compute next-run from the spec ourselves so
		// the UI can show "would fire …" greyed out.
		let nextRunAt: string | null = live?.nextRunAt ?? null;
		if (!nextRunAt && !spec.enabled && spec.cron) {
			try {
				const it = CronExpressionParser.parse(spec.cron, {
					tz: spec.timezone ?? 'Asia/Dubai',
					currentDate: new Date(),
				});
				nextRunAt = it.next().toDate().toISOString();
			} catch {
				/* invalid cron — leave null */
			}
		}

		return {
			id: spec.id,
			type: spec.type,
			cron: spec.cron,
			timezone: spec.timezone ?? null,
			enabled: spec.enabled !== false,
			noOverlap: spec.noOverlap !== false,
			description: spec.description ?? null,
			params: spec.params ?? {},
			nextRunAt,
			lastRunAt: live?.lastRunAt ?? recent[0]?.startedAt ?? null,
			lastStatus: live?.lastStatus ?? recent[0]?.status ?? null,
			recentHistory: recent,
		};
	});

	return json({ tasks: merged });
};
