/** GET /api/orchestration/heartbeat — read-only feed for the
 *  /orchestration/heartbeat inbox (ADR-001 P1 collaboration surface, ADR-003
 *  P1). Returns recent commitments (all statuses), the proactive run log, and
 *  the live voice-ack surface. No mutations — disposition lands in Phase 2.
 *
 *  Reads through `heartbeat-state.js` (the shared ops DB) directly; this
 *  import repoints when the DB relocates in ADR-001 P4. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	recentCommitments,
	recentLog,
	getRecentVoiceSurface,
} from '$lib/channels/whatsapp/heartbeat-state.js';

export const GET: RequestHandler = async ({ url }) => {
	const commitmentLimit = Math.max(1, Math.min(200, Number(url.searchParams.get('commitments')) || 50));
	const logLimit = Math.max(1, Math.min(200, Number(url.searchParams.get('log')) || 30));
	return json({
		ok: true,
		commitments: recentCommitments(commitmentLimit),
		log: recentLog(logLimit),
		voiceSurface: getRecentVoiceSurface(),
	});
};
