/** Scheduler handler: hygiene-button-escalator (ADR-042 pass 2).
 *
 *  Fires after the weekly project-hygiene script writes its digest.
 *  Calls `emitArchiveZoneEscalations()` so the operator receives one
 *  inline-keyboard Telegram message per `archive_zone_mismatch` row
 *  in the freshly-written digest.
 *
 *  Until pass 3 lands proper dedup, this handler is safe to fire
 *  repeatedly only if the operator hasn't yet tapped the buttons for
 *  the open anomalies — a fresh run will re-send messages for the
 *  same (slug, bucket) pairs. Mitigated for the autonomous run by
 *  cron timing: it fires once per week, one minute after the python
 *  script.
 *
 *  Settings shape:
 *    {
 *      id: 'hygiene-button-escalator',
 *      type: 'hygiene-button-escalator',
 *      cron: '1 9 * * 0',
 *      timezone: 'Asia/Dubai',
 *      params: {}
 *    }
 */

import { emitArchiveZoneEscalations } from '../../vault-hygiene/inline-escalator.js';
import type { TaskFn } from '../task-types.js';

export function hygieneButtonEscalatorFactory(_rawParams: unknown): TaskFn {
	return async () => {
		const result = await emitArchiveZoneEscalations();
		// Surface the result through scheduler logs so the operator can
		// see what happened without opening Telegram.
		if (!result.ok) {
			console.warn(
				`[hygiene-button-escalator] failed: ${result.error ?? 'unknown'}`,
			);
		} else if (result.totalRows === 0) {
			console.log('[hygiene-button-escalator] no archive_zone_mismatch rows');
		} else {
			console.log(
				`[hygiene-button-escalator] sent ${result.sent}/${result.totalRows}` +
					(result.failures && result.failures.length > 0
						? ` (${result.failures.length} failed)`
						: ''),
			);
		}
		return result;
	};
}
