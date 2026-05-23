/** Task handler: operator-notification-budget-falsifier (soul-hub-governance ADR-004).
 *
 *  Falsifier for the `operator-notification-budget` contract — the runtime guard
 *  for ADR-004's core promise: convergence keeps the *scheduled* proactive
 *  message count bounded (≤2/day target; urgent exceptions uncounted). Counts
 *  `digest`-tier operator sends in the trailing 24h (from the
 *  `operator_notifications` ledger that `notifyOperator` writes) and errors red
 *  on /hygiene if it exceeds the budget — i.e. if the pile ever creeps back. */

import type { TaskFn } from '../task-types.js';
import { countOperatorSends } from '../../channels/_shared/notify-operator.js';

interface BudgetParams {
	/** Max digest-tier operator messages allowed in 24h before red. Default 3. */
	maxPerDay?: number;
}

export function operatorNotificationBudgetFalsifierFactory(rawParams: unknown): TaskFn {
	const params = (rawParams ?? {}) as BudgetParams;
	const budget = typeof params.maxPerDay === 'number' && params.maxPerDay > 0 ? params.maxPerDay : 3;
	return async () => {
		const count = countOperatorSends('digest');
		const summary = { digestSends24h: count, budget };
		if (count > budget) {
			throw new Error(
				`operator-notification-budget RED: ${count} digest-tier operator messages in 24h ` +
					`(budget ${budget}, ADR-004). The notification pile is creeping back — a converged ` +
					`source may be sending on its own cadence instead of contributing to the digest.`,
			);
		}
		return { ok: true, ...summary };
	};
}
