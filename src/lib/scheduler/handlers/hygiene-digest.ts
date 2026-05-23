/** Task handler: hygiene-digest (soul-hub-hygiene ADR-005 P1).
 *
 *  Sends the once-daily batched vault-health digest instead of per-item
 *  escalation spam. Silent on clean days (the emitter returns `sent:false`).
 *  Cadence + enable/disable live in the scheduler task definition. */

import type { TaskFn } from '../task-types.js';
import { emitDailyHygieneDigest } from '../../vault-hygiene/daily-digest.js';

export function hygieneDigestFactory(_params: unknown): TaskFn {
	return async () => {
		return await emitDailyHygieneDigest();
	};
}
