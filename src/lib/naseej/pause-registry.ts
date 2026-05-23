/**
 * Naseej pause-registry (ADR-011 v1).
 *
 * In-process registry of paused human/gate steps. The runner registers a
 * resolver when entering a `human:` or `gate:` step; `POST /api/recipes/runs/<id>/respond`
 * looks up the resolver and fires it with the operator's payload. The runner
 * is currently awaiting the returned Promise; it resumes the moment we resolve.
 *
 * v1 is in-process only — paused runs do NOT survive PM2 restart. Per ADR-011
 * v1 resolution: single-operator local system, restart-mid-pause is rare,
 * operator re-runs in that case. Durable snapshots are a follow-up if real
 * pain emerges.
 *
 * Keyed on `<runId>:<stepId>` so multiple paused steps in the same run (rare
 * — depends_on serialises by default) are individually addressable.
 */

import type { HumanResponse, GateResponse } from './pause-types.js';

export type PauseResponse =
	| { kind: 'human'; response: HumanResponse }
	| { kind: 'gate'; response: GateResponse };

interface PendingPause {
	resolve: (value: PauseResponse) => void;
	reject: (reason: Error) => void;
	kind: 'human' | 'gate';
	createdAt: number;
}

const registry = new Map<string, PendingPause>();

function key(runId: string, stepId: string): string {
	return `${runId}:${stepId}`;
}

/** Runner-side: register a pause and return a Promise that resolves when
 *  someone POSTs the response (or rejects on timeout / cancellation). */
export function registerPause(
	runId: string,
	stepId: string,
	kind: 'human' | 'gate',
	timeoutSec: number,
	signal?: AbortSignal,
): Promise<PauseResponse> {
	const k = key(runId, stepId);
	if (registry.has(k)) {
		return Promise.reject(new Error(`pause already registered for ${k}`));
	}
	return new Promise<PauseResponse>((resolve, reject) => {
		const pending: PendingPause = { resolve, reject, kind, createdAt: Date.now() };
		registry.set(k, pending);

		const timer = setTimeout(() => {
			if (registry.get(k) === pending) {
				registry.delete(k);
				reject(new Error(`${kind} step timed out after ${timeoutSec}s`));
			}
		}, timeoutSec * 1000);

		if (signal) {
			const onAbort = () => {
				if (registry.get(k) === pending) {
					registry.delete(k);
					clearTimeout(timer);
					reject(new Error('cancelled'));
				}
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		const wrappedResolve = pending.resolve;
		pending.resolve = (value: PauseResponse) => {
			clearTimeout(timer);
			registry.delete(k);
			wrappedResolve(value);
		};
	});
}

/** Endpoint-side: resolve a pause with the operator's payload.
 *  Returns false if no such pause is registered (already resolved, timed out,
 *  or never paused), true on successful fire. */
export function resolvePause(runId: string, stepId: string, payload: PauseResponse): boolean {
	const pending = registry.get(key(runId, stepId));
	if (!pending) return false;
	if (pending.kind !== payload.kind) {
		pending.reject(new Error(`pause kind mismatch: expected ${pending.kind}, got ${payload.kind}`));
		return false;
	}
	pending.resolve(payload);
	return true;
}

/** Introspection — used by the audit page / smoke tests. */
export function activePauses(): Array<{ runId: string; stepId: string; kind: 'human' | 'gate'; createdAt: number }> {
	const out: ReturnType<typeof activePauses> = [];
	for (const [k, pending] of registry.entries()) {
		const colon = k.indexOf(':');
		out.push({
			runId: k.slice(0, colon),
			stepId: k.slice(colon + 1),
			kind: pending.kind,
			createdAt: pending.createdAt,
		});
	}
	return out;
}
