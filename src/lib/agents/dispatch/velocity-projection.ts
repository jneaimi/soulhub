/**
 * Pure projection: given the current run snapshot and the ceilings, would the
 * run project to cross either axis within `warningHorizonTurns` turns? Used by
 * claude-pty.ts's velocity warning emitter (ADR-006 P3) AND by the live-grant-
 * adoption block (Commit C — 2026-05-30) which uses it to decide whether to
 * re-arm the one-shot warning after a grant raises one or both ceilings.
 *
 * Re-arm rule: only when BOTH axes project clear post-grant. A partial grant
 * (operator raised cost but not turns, or vice-versa) leaves the un-raised axis
 * still in warning territory; re-arming would re-fire the warning on the next
 * loop tick, sending a duplicate Telegram and resetting the run to
 * awaiting-budget-approval. Hit live on ADR-025's dispatch 2026-05-29.
 *
 * Horizon (2026-05-30 — Commit D): the original projection looked ONE turn
 * ahead, which collapsed the velocity warning and the hard-ceiling kill into
 * adjacent ticks — operator got two Telegram messages ~10 s apart with nearly
 * identical buttons, and a velocity-warning grant tapped after the hard kill
 * would silently no-op (run already terminated, in-memory grant store had
 * nothing to apply to). Witnessed live on ADR-042 dispatch 2026-05-30 (run
 * 523 → 524). Widening the projection horizon to 3 turns gives the operator
 * meaningful response time before the hard ceiling fires, and the dual-
 * Telegram race goes away (velocity now fires well before the kill band).
 *
 * Snapshot fields mirror `runTail.snapshot()`:
 *   - costUsd: null when any turn had unknown pricing — don't project an
 *     untrusted cost; willHitCost stays false in that case.
 *   - turns: integer assistant-turn count so far. Zero allowed; willHitCost
 *     defaults false because per-turn cost rate is undefined.
 */

/** Default horizon: project 3 turns ahead. Tuned for a ~$0.16/turn rate
 *  against an $8-$12 ceiling — three turns ≈ $0.50 of headroom, which is
 *  enough Telegram response time before the hard ceiling fires. */
export const DEFAULT_WARNING_HORIZON_TURNS = 3;

export interface VelocitySnap {
	costUsd: number | null;
	turns: number;
}

export interface VelocityProjection {
	willHitCost: boolean;
	willHitTurns: boolean;
}

export function projectsAtCeiling(
	snap: VelocitySnap,
	ceilingUsd: number,
	ceilingTurns: number,
	warningHorizonTurns: number = DEFAULT_WARNING_HORIZON_TURNS,
): VelocityProjection {
	const costPerTurn =
		snap.costUsd !== null && snap.turns > 0 ? snap.costUsd / snap.turns : 0;
	const willHitCost =
		snap.costUsd !== null &&
		costPerTurn > 0 &&
		snap.costUsd < ceilingUsd &&
		snap.costUsd + costPerTurn * warningHorizonTurns >= ceilingUsd;
	const willHitTurns =
		snap.turns < ceilingTurns && snap.turns + warningHorizonTurns >= ceilingTurns;
	return { willHitCost, willHitTurns };
}
