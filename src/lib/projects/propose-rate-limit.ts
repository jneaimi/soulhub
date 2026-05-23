/**
 * project-phases ADR-005 S4 — per-agent tool-level rate limit for the
 * propose-* tool family (proposeAdr / proposeSlice / suggestAdrEdit).
 *
 * Layered ABOVE the ADR-046 chokepoint rate limit (50/hr per
 * `meta.source_agent`). This one is tighter: 5 PROPOSALS per hour per
 * `actor` across the three tools combined. The point is to stop a
 * runaway AI loop from drowning the operator in 20 ADR drafts in 5
 * minutes — the chokepoint's 50/hr cap is correct for slow operator-
 * driven writes but too generous for AI-burst dynamics.
 *
 * Pure-helper design: state lives in module scope (Map keyed by actor),
 * `now()` is injectable for tests. Reset helper exposed for tests too.
 * No I/O, no DB — in-memory only. Resets on PM2 reload, which is the
 * right window for an AI-burst guardrail (a fresh process is a fresh
 * start; operator-flagged drift wouldn't be cured by persistence anyway).
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CEILING = 5;

/** Allow operator-driven tools to override the cap when needed. Default
 *  stays tight (5/hr) — overrides should be rare + documented in the ADR
 *  follow-up that justifies them. */
const CEILING_OVERRIDES: Record<string, number> = {};

interface Bucket {
	count: number;
	windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface ProposeRateCheck {
	allowed: boolean;
	remaining: number;
	resetAt: string; // ISO timestamp
	ceiling: number;
}

function ceilingFor(actor: string): number {
	return CEILING_OVERRIDES[actor] ?? DEFAULT_CEILING;
}

/** Inspect (without incrementing) whether `actor` would be allowed to
 *  propose right now. Useful for dry-run / preview paths. */
export function peekProposeRate(actor: string, now: number = Date.now()): ProposeRateCheck {
	const ceiling = ceilingFor(actor);
	const entry = buckets.get(actor);
	if (!entry || now - entry.windowStart >= WINDOW_MS) {
		return {
			allowed: true,
			remaining: ceiling,
			resetAt: new Date(now + WINDOW_MS).toISOString(),
			ceiling,
		};
	}
	if (entry.count >= ceiling) {
		return {
			allowed: false,
			remaining: 0,
			resetAt: new Date(entry.windowStart + WINDOW_MS).toISOString(),
			ceiling,
		};
	}
	return {
		allowed: true,
		remaining: ceiling - entry.count,
		resetAt: new Date(entry.windowStart + WINDOW_MS).toISOString(),
		ceiling,
	};
}

/** Increment + check. Call this RIGHT BEFORE the proposal write. When
 *  `allowed: false`, the caller should refuse with a 429-shape error +
 *  the `resetAt` in the user-facing message. When `allowed: true`, the
 *  counter has already been bumped — DO NOT call again for the same
 *  proposal attempt. */
export function checkProposeRate(actor: string, now: number = Date.now()): ProposeRateCheck {
	const ceiling = ceilingFor(actor);
	const entry = buckets.get(actor);
	if (!entry || now - entry.windowStart >= WINDOW_MS) {
		// Fresh window — accept + start a new bucket.
		buckets.set(actor, { count: 1, windowStart: now });
		return {
			allowed: true,
			remaining: ceiling - 1,
			resetAt: new Date(now + WINDOW_MS).toISOString(),
			ceiling,
		};
	}
	if (entry.count >= ceiling) {
		// Already over — refuse, do not bump.
		return {
			allowed: false,
			remaining: 0,
			resetAt: new Date(entry.windowStart + WINDOW_MS).toISOString(),
			ceiling,
		};
	}
	entry.count += 1;
	return {
		allowed: true,
		remaining: ceiling - entry.count,
		resetAt: new Date(entry.windowStart + WINDOW_MS).toISOString(),
		ceiling,
	};
}

/** Test-only reset. Production code MUST NOT call this. */
export function __resetProposeRateLimitForTests(): void {
	buckets.clear();
}

/** Operator-facing introspection — returns current bucket counts for the
 *  /orchestration/tools page (S4 review surface). */
export function getProposeRateState(
	now: number = Date.now(),
): Array<{ actor: string; count: number; ceiling: number; resetAt: string }> {
	const out: Array<{ actor: string; count: number; ceiling: number; resetAt: string }> = [];
	for (const [actor, bucket] of buckets) {
		if (now - bucket.windowStart >= WINDOW_MS) continue; // window expired
		out.push({
			actor,
			count: bucket.count,
			ceiling: ceilingFor(actor),
			resetAt: new Date(bucket.windowStart + WINDOW_MS).toISOString(),
		});
	}
	return out.sort((a, b) => b.count - a.count);
}
