/** Scheduler handler: intent-mining (ADR-023 Phase 1.5).
 *
 *  Daily Claude analyst that reads recent intent_log + chat_history and
 *  proposes deterministic routing patterns for operator approval.
 *
 *  Settings shape:
 *    {
 *      id: 'intent-mining-daily',
 *      type: 'intent-mining',
 *      cron: '0 2 * * *',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        lookbackDays?: 7,    // default 7
 *        minNewRows?: 10,     // skip if fewer than N new rows since last run
 *      }
 *    }
 *
 *  The handler is a thin wrapper over `runIntentMining` from learner.ts;
 *  the bulk of the logic lives there and is reusable from API / smoke
 *  tests. The handler only adds:
 *    - param parsing
 *    - the "rows since last successful run" watermark gate
 *    - JSON-shaped result summary for `scheduler_runs.output_summary`
 */

import { runIntentMining } from '../../intent/learner.js';
import { lastSuccessfulRun } from '../db.js';
import type { TaskFn } from '../task-types.js';

interface IntentMiningParams {
	lookbackDays?: number;
	minNewRows?: number;
}

const TASK_ID = 'intent-mining-daily';

export function intentMiningFactory(rawParams: unknown): TaskFn {
	const params: IntentMiningParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as IntentMiningParams)
			: {};
	const lookbackDays = params.lookbackDays ?? 7;
	const minNewRows = params.minNewRows ?? 10;

	return async (ctx) => {
		// Watermark — last successful intent-mining run. Used to bail when
		// only a handful of new rows have arrived since the previous batch.
		const last = lastSuccessfulRun(TASK_ID);
		const lastRunAt = last ? Date.parse(last.startedAt) : 0;

		const result = await runIntentMining({
			lookbackDays,
			minNewRows,
			lastRunAt,
			signal: ctx?.signal,
		});

		return result;
	};
}
