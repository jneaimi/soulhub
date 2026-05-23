/** In-memory circuit breaker — parks a provider ref after repeated
 *  failures so the failover chain skips it for a cooldown window.
 *  Per ADR-002: 3 failures within 5 minutes → 5-minute park.
 *
 *  Module-scoped state. Resets on process restart (PM2 reload). The
 *  Settings → Routes section surfaces the live snapshot per provider. */

import type { ProviderRef } from '../llm/types.js';
import type { CircuitState } from './types.js';

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const PARK_DURATION_MS = 5 * 60 * 1000;

interface RefState {
	failures: number[];
	openUntil?: number;
}

const state = new Map<ProviderRef, RefState>();

export function recordFailure(ref: ProviderRef, now: number = Date.now()): void {
	const slot = state.get(ref) ?? { failures: [] };
	const cutoff = now - FAILURE_WINDOW_MS;
	slot.failures = slot.failures.filter((t) => t >= cutoff);
	slot.failures.push(now);
	if (slot.failures.length >= FAILURE_THRESHOLD) {
		slot.openUntil = now + PARK_DURATION_MS;
	}
	state.set(ref, slot);
}

export function recordSuccess(ref: ProviderRef): void {
	state.delete(ref);
}

export function isOpen(ref: ProviderRef, now: number = Date.now()): boolean {
	const slot = state.get(ref);
	if (!slot?.openUntil) return false;
	if (slot.openUntil <= now) {
		// Park expired — clear and allow another attempt.
		state.delete(ref);
		return false;
	}
	return true;
}

export function snapshot(now: number = Date.now()): CircuitState[] {
	const out: CircuitState[] = [];
	for (const [ref, slot] of state) {
		out.push({
			ref,
			open: isOpen(ref, now),
			failures: slot.failures.length,
			openUntil: slot.openUntil,
		});
	}
	return out;
}

/** Reset everything — for tests and the future "reset providers" admin button. */
export function reset(): void {
	state.clear();
}
