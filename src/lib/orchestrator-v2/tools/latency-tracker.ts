/**
 * Per-tool latency rolling buffer (ADR-030 Decision 4, v2 ship).
 *
 * Every orchestrator-v2 tool's `execute()` is wrapped in `withLatencyTracking`
 * so we accumulate a per-tool sample list (last 50 calls). Stats power the
 * `/orchestration/tools` UI column: explicit-class badge + an "auto"
 * suggestion when the rolling p95 disagrees with the manifest (or when
 * the manifest is silent).
 *
 * The suggestion is informational only — it never auto-applies to the
 * manifest. Operator sees "fast (auto, suggest slow: p95 8.2s after 23
 * samples)" and decides whether to flip the manifest entry.
 *
 * In-memory + per-process. PM2 reload resets the buffer; takes 20 more
 * calls before a suggestion reappears. Acceptable — this is observability,
 * not audit.
 */

import type { ToolSet } from 'ai';

/** Default budget for fast-vs-slow split. Matches ADR-030 Decision 5. */
const DEFAULT_FAST_P95_MS = 5000;

/** Sliding-window size per tool. Matches the recent-calls ring buffer
 *  in `registry.ts`. */
const BUFFER_MAX = 50;

/** Minimum samples before a suggestion surfaces. Matches ADR-030
 *  Decision 4 — fewer than 20 samples is too noisy to bias on. */
const MIN_SAMPLES_FOR_SUGGESTION = 20;

const buffers = new Map<string, number[]>();

export function recordToolLatency(name: string, ms: number): void {
	let buf = buffers.get(name);
	if (!buf) {
		buf = [];
		buffers.set(name, buf);
	}
	buf.push(ms);
	if (buf.length > BUFFER_MAX) buf.shift();
}

export interface LatencyStats {
	samples: number;
	p95Ms: number | null;
	/** Suggested class based on p95 vs. the budget. Null when samples are
	 *  too few to bias on. */
	suggestedClass: 'fast' | 'slow' | null;
}

export function getLatencyStats(name: string, budgetMs = DEFAULT_FAST_P95_MS): LatencyStats {
	const buf = buffers.get(name);
	if (!buf || buf.length === 0) {
		return { samples: 0, p95Ms: null, suggestedClass: null };
	}
	const sorted = [...buf].sort((a, b) => a - b);
	const idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
	const p95 = sorted[idx];
	const suggestedClass =
		buf.length >= MIN_SAMPLES_FOR_SUGGESTION ? (p95 > budgetMs ? 'slow' : 'fast') : null;
	return { samples: buf.length, p95Ms: p95, suggestedClass };
}

/** Wrap a record of AI-SDK tool objects so every `execute()` records its
 *  wall-clock duration. Returns a new record with the same keys + shape;
 *  the wrapped tools are interchangeable with the originals from the
 *  SDK's perspective. Safe to call once at the end of `buildOrchestratorTools`. */
export function withLatencyTracking<T extends ToolSet>(tools: T): T {
	const wrapped: Record<string, unknown> = {};
	for (const [name, t] of Object.entries(tools)) {
		if (!t || typeof t.execute !== 'function') {
			wrapped[name] = t;
			continue;
		}
		// Forward EVERY argument (the AI SDK passes `(args, options)` where
		// options carries toolCallId / messages / abortSignal); the old
		// single-arg wrapper silently dropped `options`.
		const origExecute = t.execute.bind(t) as (...callArgs: unknown[]) => unknown;
		wrapped[name] = {
			...t,
			execute: async (...callArgs: unknown[]) => {
				const start = Date.now();
				try {
					return await origExecute(...callArgs);
				} finally {
					recordToolLatency(name, Date.now() - start);
				}
			},
		};
	}
	return wrapped as T;
}
