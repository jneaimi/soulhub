/**
 * Concurrency caps for orchestrator-initiated agent dispatches.
 *
 * Phase 1.5a — replaces the previous "one run per JID, hard-block all
 * other messages" behavior with a numeric cap so the user can keep
 * chatting while a delegate runs and even fire a second short delegate
 * without exhausting PTY / API / $ budget.
 *
 * Two limits enforced together:
 *   - PER_JID_CAP: max simultaneous runs originating from one chat. One
 *     long research can run while one quick task dispatches in parallel.
 *   - GLOBAL_CAP: backstop for the whole soul-hub process. Includes runs
 *     from heartbeat, scheduler, and other JIDs — anything that goes
 *     through `setActive`.
 *
 * Tuning: see ADR-001 §"Phase 1.5 cap numbers". These are config
 * constants today; revisit after a week of real usage.
 */

import { listActive, listActiveByJid, type ActiveRun } from './active-runs.js';

export const PER_JID_CAP = 2;
export const GLOBAL_CAP = 4;

export type CapacityResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'per-jid' | 'global';
			running: ActiveRun[];
	  };

/** Check whether a new orchestrator dispatch would respect both caps for
 *  the given JID. Returns the offending list when blocked so the caller
 *  can render a chat-friendly "I have N tasks already running…" reply
 *  with elapsed times. */
export function checkCapacity(jid: string): CapacityResult {
	const perJid = listActiveByJid(jid);
	if (perJid.length >= PER_JID_CAP) {
		return { ok: false, reason: 'per-jid', running: perJid };
	}
	const global = listActive();
	if (global.length >= GLOBAL_CAP) {
		return { ok: false, reason: 'global', running: global };
	}
	return { ok: true };
}

/** Render the capacity-exceeded reply in WhatsApp-friendly markdown. The
 *  caller sends this verbatim. Lists each running agent + elapsed time
 *  and tells the user how to free a slot. */
export function formatCapacityRejection(result: Extract<CapacityResult, { ok: false }>): string {
	const now = Date.now();
	const lines = result.running.map((r) => {
		const sec = Math.round((now - r.startedAt) / 1000);
		return `• *${r.agentId}* (${sec}s)`;
	});
	const header =
		result.reason === 'per-jid'
			? `I'm already running ${result.running.length} task${result.running.length === 1 ? '' : 's'} for this chat:`
			: `Global concurrency cap (${result.running.length} tasks) reached:`;
	return [
		header,
		...lines,
		'',
		`Reply *cancel* to abort ${result.running.length === 1 ? 'it' : 'them'}, or wait — I'll handle this once a slot frees up.`,
	].join('\n');
}
