/** Task handler: notification-budget-falsifier (soul-hub-governance ADR-002).
 *
 *  Repointed per ADR-008 step 4 — keeper retirement (2026-05-26).
 *
 *  Original contract (pre-retirement): keeper heartbeat sends ≤ 1 Telegram/day.
 *  The contract was needed because keeper's own task-prompt + keeper.md
 *  escalation snippet caused ~48× Telegram pushes/day (the regression that
 *  triggered this falsifier in the first place).
 *
 *  Post-retirement contract: keeper is fully retired — zero `agent_runs` rows
 *  with `agent_id LIKE '%keeper%'` dated after the ADR-008 retirement date.
 *  Any hit means keeper's roster seed was re-added or a manual dispatch ran —
 *  both are regressions that need immediate operator attention.
 *
 *  This is NOT vacuously-green: it actively checks that keeper never runs
 *  after retirement (the "dark contract" failure mode ADR-008 §Migration 4
 *  explicitly guards against). The overall notification-budget invariant
 *  (hygiene system sends ≤ 1 Telegram/day) is now covered by the
 *  `operator-notification-budget-falsifier` task, which counts digest-tier
 *  `notifyOperator` sends. */

import type { TaskFn } from '../task-types.js';
import { getHeartbeatDb } from '../../channels/whatsapp/heartbeat-state.js';

/** ISO timestamp after which a keeper run is a regression, not history.
 *
 *  ADR-008 landed 2026-05-26, but keeper kept running on its 30-min heartbeat
 *  through that transition day until the cutover actually took effect — its
 *  final legitimate runs were 06:30–23:00 (Dubai) on 2026-05-26. Full
 *  de-registration (keeper.md deleted, roster seed removed) completed
 *  2026-05-27. A start-of-2026-05-26 cutoff therefore false-flagged those
 *  transition-day runs; the cutoff is the day AFTER keeper truly stopped, so
 *  only a genuine resurrection (a run on/after 2026-05-27) trips it. */
const RETIREMENT_DATE_MS = new Date('2026-05-27T00:00:00Z').getTime();

interface RunRow {
	startedAt: number;
	agentId: string;
	sourceMessage: string | null;
}

export function notificationBudgetFalsifierFactory(_params: unknown): TaskFn {
	return async () => {
		const rows = getHeartbeatDb()
			.prepare(
				`SELECT started_at AS startedAt, agent_id AS agentId, source_message AS sourceMessage
				 FROM agent_runs
				 WHERE agent_id LIKE '%keeper%'
				   AND started_at > ?
				 ORDER BY started_at DESC
				 LIMIT 5`,
			)
			.all(RETIREMENT_DATE_MS) as RunRow[];

		if (rows.length > 0) {
			const latest = new Date(rows[0].startedAt).toISOString();
			throw new Error(
				`keeper-retired RED: ${rows.length} agent_run(s) with agent_id LIKE '%keeper%' ` +
					`found after ADR-008 retirement date (${new Date(RETIREMENT_DATE_MS).toISOString().slice(0, 10)}). ` +
					`Latest at ${latest} (source: ${rows[0].sourceMessage ?? 'unknown'}). ` +
					`The keeper roster seed was re-added or a manual dispatch ran — ` +
					`check seed-roster.ts and ~/.claude/agents/keeper.md.`,
			);
		}

		return {
			ok: true,
			keeperRunsAfterRetirement: 0,
			retirementDate: new Date(RETIREMENT_DATE_MS).toISOString(),
			detail: 'keeper fully retired — zero agent_runs after ADR-008 retirement date',
		};
	};
}
