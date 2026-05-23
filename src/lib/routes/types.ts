/** Routes layer — types only. The route engine sits between channels
 *  ("a WhatsApp DM came in") and chat providers ("call Gemini Flash"). A
 *  channel resolves an inbound message to a route name (e.g. `vault-chat`,
 *  `vault-save-note`); this layer maps that name to a concrete provider
 *  chain with failover, retries, timeouts, and a circuit breaker. */

import type { ChatRequest, ChatResult, ProviderRef } from '../llm/types.js';

export type { ChatRequest, ChatResult, ProviderRef } from '../llm/types.js';

/** Categories of error that a route may opt into for failover. Per ADR-002:
 *  `timeout`, `5xx`, `rate_limit`, `network`. 4xx errors are explicitly NOT
 *  failover-eligible — they signal the caller's input is wrong and retrying
 *  on another provider won't help. */
export type FailoverTrigger = 'timeout' | '5xx' | 'rate_limit' | 'network';

export interface RouteConfig {
	/** Human description shown in the Settings → Routes section. */
	description?: string;
	/** First provider to try. */
	default: ProviderRef;
	/** Ordered list of fallbacks. Each is tried after the previous one
	 *  exhausts retries or trips the circuit breaker. */
	failover: ProviderRef[];
	/** Per-attempt timeout. Aborts the upstream request and treats it as a
	 *  `timeout` failover trigger. */
	timeoutMs: number;
	/** Per-provider retry count before moving to the next ref. Retries only
	 *  fire on errors that match `onError`. */
	retries: number;
	/** Which categories of error trigger a retry/failover. */
	onError: FailoverTrigger[];
}

/** Dispatch outcome — extends a normal `ChatResult` with the chain that
 *  was tried and the final ref that answered. The settings UI surfaces
 *  this as a "Recent activity" panel. */
export interface DispatchResult extends ChatResult {
	routeName: string;
	chain: ProviderRef[];
	attempts: AttemptRecord[];
	answeredBy: ProviderRef;
}

export interface AttemptRecord {
	ref: ProviderRef;
	status: 'ok' | 'unavailable' | 'circuit-open' | 'failed-retryable' | 'failed-fatal';
	error?: string;
	durationMs: number;
}

/** Snapshot of the circuit breaker — exposed for diagnostics. */
export interface CircuitState {
	ref: ProviderRef;
	open: boolean;
	failures: number;
	openUntil?: number;
}
