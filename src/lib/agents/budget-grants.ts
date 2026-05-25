/**
 * ADR-006 Phase 3 — in-process live-grant registry for IN-FLIGHT ceiling raises.
 *
 * When the velocity projection sees a run about to hit its hard ceiling, it
 * fires an early Telegram warning (`escalateVelocityWarning`). If the operator
 * pre-approves while the PTY is STILL RUNNING, the callback writes a live grant
 * here; the dispatch loop polls it each tick and raises its effective ceiling in
 * place — so the run sails past the old ceiling with NO kill/`--resume` cycle
 * (which would re-create ~35K cache tokens per turn).
 *
 * Deliberately in-process (a plain Map), not the persisted `pending_callbacks`
 * table: a live grant is only meaningful while the dispatch is running, and a
 * process restart loses the running PTY anyway. Keyed by Claude session UUID.
 */

export interface LiveGrant {
	/** Raised hard dollar ceiling (absolute, not a delta). */
	ceilingUsd: number;
	/** Raised hard turn ceiling (absolute). */
	ceilingTurns: number;
	addedAt: number;
}

const liveGrants = new Map<string, LiveGrant>();

/** Record/raise a live grant for a running session. Accumulates: a second tap
 *  adds to the already-granted ceiling, not the original base. Returns the new
 *  absolute ceilings (for the ack message). */
export function applyLiveGrant(
	sessionUuid: string,
	bump: { addUsd?: number; addTurns?: number },
	base: { ceilingUsd: number; ceilingTurns: number },
): { ceilingUsd: number; ceilingTurns: number } {
	const cur = liveGrants.get(sessionUuid);
	const ceilingUsd = (cur?.ceilingUsd ?? base.ceilingUsd) + (bump.addUsd ?? 0);
	const ceilingTurns = (cur?.ceilingTurns ?? base.ceilingTurns) + (bump.addTurns ?? 0);
	liveGrants.set(sessionUuid, { ceilingUsd, ceilingTurns, addedAt: Date.now() });
	return { ceilingUsd, ceilingTurns };
}

/** Read the current live grant for a session, if any. */
export function getLiveGrant(sessionUuid: string): LiveGrant | undefined {
	return liveGrants.get(sessionUuid);
}

/** Drop a session's live grant — the dispatch loop calls this once it has
 *  adopted the raised ceiling, and again in its `finally` so a finished run
 *  never leaks a grant for a reused session id (resume keeps the same UUID). */
export function clearLiveGrant(sessionUuid: string): void {
	liveGrants.delete(sessionUuid);
}
