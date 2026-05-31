/** Pure body-validation for POST /api/agents/runs/[runId]/approve-budget.
 *
 *  Extracted so the endpoint stays a thin wiring layer and the rules can be
 *  unit-tested without the SvelteKit handler + DB + Telegram dependencies. */

export interface ApproveBudgetBody {
	stop: boolean;
	addUsd: number;
	addTurns: number;
	reason?: string;
}

export interface ParseOk {
	ok: true;
	value: ApproveBudgetBody;
}

export interface ParseErr {
	ok: false;
	error: string;
}

export type ParseResult = ParseOk | ParseErr;

/** Per-call caps. The cumulative ADR cap (ADR-020 P3) is enforced downstream
 *  by the dispatcher on resume — this is just a sanity bound to catch UI bugs
 *  / typos that would otherwise pass a 9-digit bump straight to the budget. */
export const MAX_BUMP_USD = 50;
export const MAX_BUMP_TURNS = 200;
/** Audit-trail truncation — the reason is persisted to error_message which is
 *  itself truncated to 1000 chars upstream; 500 keeps headroom for the prefix
 *  "stopped by operator at budget ceiling: ". */
export const MAX_REASON_LEN = 500;

export function parseApproveBudgetBody(raw: unknown): ParseResult {
	if (raw === null || typeof raw !== 'object') {
		return { ok: false, error: 'Body must be a JSON object' };
	}
	const body = raw as Record<string, unknown>;

	const stop = body.stop === true;
	const addUsd = typeof body.addUsd === 'number' ? body.addUsd : 0;
	const addTurns = typeof body.addTurns === 'number' ? body.addTurns : 0;
	const reason =
		typeof body.reason === 'string' && body.reason.trim().length > 0
			? body.reason.trim().slice(0, MAX_REASON_LEN)
			: undefined;

	if (!stop) {
		if (Number.isNaN(addUsd) || Number.isNaN(addTurns)) {
			return { ok: false, error: 'addUsd and addTurns must be finite numbers' };
		}
		if (addUsd < 0 || addTurns < 0) {
			return { ok: false, error: 'addUsd and addTurns must be non-negative' };
		}
		if (addUsd <= 0 && addTurns <= 0) {
			return {
				ok: false,
				error: 'At least one of addUsd or addTurns must be > 0 (or pass stop:true)',
			};
		}
		if (addUsd > MAX_BUMP_USD || addTurns > MAX_BUMP_TURNS) {
			return {
				ok: false,
				error: `Bump exceeds per-call cap (addUsd ≤ $${MAX_BUMP_USD}, addTurns ≤ ${MAX_BUMP_TURNS})`,
			};
		}
	}

	return { ok: true, value: { stop, addUsd, addTurns, reason } };
}
