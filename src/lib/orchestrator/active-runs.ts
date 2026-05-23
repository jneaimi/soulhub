/**
 * In-process active-run registry.
 *
 * The agents module's `agent_runs` table only records terminal rows, so
 * "what's running right now" can't be answered from SQL. This Map fills
 * that gap. Reset on PM2 restart by design — see WhatsApp ADR-005
 * §Database for why we don't persist mid-run state.
 *
 * Keyed by `runId`. Each entry carries its `jid` so we can answer both
 * per-conversation queries ("how many runs on this jid?") and global
 * queries ("what's running fleet-wide?") without a second index. Phase
 * 1.5a allows up to N runs per jid (concurrency cap), so the previous
 * jid-keyed Map no longer fits.
 */

export interface ActiveRun {
	runId: string;
	agentId: string;
	jid: string;
	startedAt: number;
	abortController: AbortController;
}

const active = new Map<string, ActiveRun>();

/** Append a new active run. Caller produces the runId at dispatch start. */
export function setActive(run: ActiveRun): void {
	active.set(run.runId, run);
}

/** Clear by runId. Worker calls this from the dispatch generator's finally
 *  block, so we always have the runId in hand. */
export function clearActive(runId: string): void {
	active.delete(runId);
}

/** All currently-running entries — used by metrics + global cap check. */
export function listActive(): ActiveRun[] {
	return Array.from(active.values());
}

/** Per-conversation slice — used by per-jid cap check and the chat-side
 *  "still running" reply on a `cancel`. Sorted by start time so callers
 *  can present the oldest first. */
export function listActiveByJid(jid: string): ActiveRun[] {
	const out: ActiveRun[] = [];
	for (const run of active.values()) {
		if (run.jid === jid) out.push(run);
	}
	out.sort((a, b) => a.startedAt - b.startedAt);
	return out;
}

/** Cancel every active run on a JID. Returns the cancelled runs in start
 *  order. Cancel is idempotent: an empty list means nothing was running. */
export function cancelByJid(jid: string): ActiveRun[] {
	const cancelled = listActiveByJid(jid);
	for (const r of cancelled) {
		r.abortController.abort();
		active.delete(r.runId);
	}
	return cancelled;
}
