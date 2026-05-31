/** Pure helper — classify a paused run's spend trajectory into a single
 *  one-line recommendation note for operator UX.
 *
 *  No LLM call. The signal is just the same numbers the dispatcher already
 *  tracked (spendUsd / ceilingUsd / turns / ceilingTurns). The job here is to
 *  give the operator a fast intuition pump so they can read the Telegram
 *  message at a glance and decide whether to tap Stop or Approve without
 *  opening the workbench.
 *
 *  Inputs are all `number`. Output is a stable enum + a humanised string. */

export type VelocityClass =
	| 'near-ceiling-spend'
	| 'near-ceiling-turns'
	| 'high-cost-per-turn'
	| 'steady';

export interface VelocityInput {
	spentUsd: number;
	ceilingUsd: number;
	turns: number;
	ceilingTurns: number;
	/** Optional: spend on the most recent turn. When provided, used to detect
	 *  "burning fast" mid-run (cost-per-turn jumped above the average). */
	lastTurnSpend?: number;
}

export interface VelocityNote {
	klass: VelocityClass;
	/** One-line note suitable for inlining in a Telegram message (no markdown,
	 *  no trailing punctuation). */
	text: string;
}

/** Thresholds chosen conservatively — we'd rather mis-classify a borderline
 *  run as `steady` than scare the operator with false "burning fast" alarms.
 *  Tune in production if the signal isn't sharp enough. */
const NEAR_CEILING_SPEND_PCT = 0.95;
const NEAR_CEILING_TURNS_PCT = 0.9;
/** A turn that burned >2× the running average is the "burning fast" signal. */
const HIGH_COST_PER_TURN_MULT = 2;

export function classifyVelocity(input: VelocityInput): VelocityNote {
	const { spentUsd, ceilingUsd, turns, ceilingTurns, lastTurnSpend } = input;

	const safeCeilingUsd = ceilingUsd > 0 ? ceilingUsd : 1;
	const safeCeilingTurns = ceilingTurns > 0 ? ceilingTurns : 1;
	const spendPct = spentUsd / safeCeilingUsd;
	const turnsPct = turns / safeCeilingTurns;

	if (spendPct >= NEAR_CEILING_SPEND_PCT) {
		return {
			klass: 'near-ceiling-spend',
			text: `Near the $ ceiling (${(spendPct * 100).toFixed(0)}% spent in ${turns} turns)`,
		};
	}

	if (turnsPct >= NEAR_CEILING_TURNS_PCT) {
		return {
			klass: 'near-ceiling-turns',
			text: `Near the turn ceiling (${turns}/${ceilingTurns}, $${spentUsd.toFixed(2)} spent)`,
		};
	}

	if (typeof lastTurnSpend === 'number' && lastTurnSpend > 0 && turns > 1) {
		const avgPerTurn = spentUsd / turns;
		if (avgPerTurn > 0 && lastTurnSpend > avgPerTurn * HIGH_COST_PER_TURN_MULT) {
			return {
				klass: 'high-cost-per-turn',
				text: `Last turn burned $${lastTurnSpend.toFixed(2)} (avg $${avgPerTurn.toFixed(2)}) — costs jumping`,
			};
		}
	}

	return {
		klass: 'steady',
		text: `Steady — $${spentUsd.toFixed(2)} over ${turns} turns ($${(spentUsd / Math.max(turns, 1)).toFixed(2)}/turn)`,
	};
}
