/** Task handler: notification-budget-falsifier (soul-hub-governance ADR-002).
 *
 *  Falsifier for the `notification-budget` contract — the runtime guard for
 *  soul-hub-hygiene ADR-005's hard NFR: the vault-hygiene keeper must send
 *  ≤ 1 Telegram message/day from the heartbeat shape (notification is owned by
 *  the once-daily `hygiene-digest`, action by `/hygiene`).
 *
 *  This exact invariant regressed silently for a day: the b732551 cutover
 *  retired the inline per-tick sender but left the keeper's own task-prompt
 *  instruction + keeper.md escalation snippet in place, so keeper kept pushing
 *  every 30 min (~tens/day). No falsifier existed to catch it. This is that
 *  falsifier: it counts keeper heartbeat runs in the trailing 24h whose output
 *  reports a Telegram send, and goes RED (errors → red on /hygiene) if > 1. */

import type { TaskFn } from '../task-types.js';
import { getHeartbeatDb } from '../../channels/whatsapp/heartbeat-state.js';

/** ≤ 1/day per ADR-005; the day-boundary slop of a trailing window means a
 *  single legitimate daily-digest-era send won't trip it, but the ~48×/day
 *  regression will, loudly. */
const MAX_KEEPER_TG_SENDS_24H = 1;

/** A budget falsifier should page on a *current* breach, not on a healed spike
 *  still inside the trailing 24h window. Anchored to the keeper's heartbeat
 *  cadence (every 30 min): pre-fix it pushed on nearly every tick that had
 *  escalations, so three consecutive clean ticks (90 min) with zero sends is
 *  unambiguous proof the regression is dead. If the 24h count exceeds budget but
 *  the newest send is older than this, we report green-with-`clearing` instead of
 *  throwing — the fix is in, the window is just rolling over. A real ≥2/day
 *  violation still trips it: the 2nd send is always recent at fire time. */
const RECENCY_GUARD_MS = 90 * 60_000;

/** Keeper's heartbeat output reports a push with phrasing like
 *  "Escalations sent to Telegram: N items". Match the send signal, not the
 *  (legitimate) "needs review … NOT pushed" summary the post-cutover keeper writes. */
const SENT_SIGNAL = /escalation[s]?\s+sent\s+to\s+telegram|sent\s+to\s+telegram\s*:/i;

interface RunRow {
	startedAt: number;
	excerpt: string | null;
}

export function notificationBudgetFalsifierFactory(_params: unknown): TaskFn {
	return async () => {
		const since = Date.now() - 24 * 3_600_000;
		const rows = getHeartbeatDb()
			.prepare(
				`SELECT started_at AS startedAt, result_excerpt AS excerpt
				 FROM agent_runs
				 WHERE agent_id LIKE '%keeper%'
				   AND source_message LIKE 'heartbeat:%'
				   AND started_at > ?
				 ORDER BY started_at DESC`,
			)
			.all(since) as RunRow[];

		const sends = rows.filter((r) => r.excerpt && SENT_SIGNAL.test(r.excerpt));
		const newestSendAt = sends[0]?.startedAt ?? null;
		const recentBreach = newestSendAt !== null && newestSendAt > Date.now() - RECENCY_GUARD_MS;
		const overBudget = sends.length > MAX_KEEPER_TG_SENDS_24H;
		const summary = {
			keeperHeartbeatRuns24h: rows.length,
			telegramSends24h: sends.length,
			budget: MAX_KEEPER_TG_SENDS_24H,
			lastSendAt: newestSendAt ? new Date(newestSendAt).toISOString() : null,
		};

		// RED only on a *current* breach: over budget AND a send within the recency
		// window. A spike that's over budget but already stopped is healing — report
		// green-with-`clearing` so the window can roll over without paging the operator.
		if (overBudget && recentBreach) {
			throw new Error(
				`notification-budget RED: keeper sent ${sends.length} Telegram escalations in 24h ` +
					`(budget ${MAX_KEEPER_TG_SENDS_24H}, ADR-005 P1), most recent at ${summary.lastSendAt}. ` +
					`The heartbeat-shape push is regressing NOW — check buildKeeperTask() + keeper.md.`,
			);
		}
		return { ok: true, clearing: overBudget && !recentBreach, ...summary };
	};
}
