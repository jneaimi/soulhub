/**
 * ADR-004 — Live transcript tail for PTY dispatch.
 *
 * ADR-002 Layer 1 (`run-record.ts`) reads a session transcript ONCE, after the
 * PTY is killed, for final text + turn count. This module reads it *live* while
 * the run is in flight, so the dispatcher can make the three decisions it
 * currently guesses at from scrollback + wall-clock:
 *
 *   - **completion** — a turn is genuinely done the instant the last assistant
 *     event has `stop_reason: 'end_turn'` AND no `tool_use` is still awaiting
 *     its `tool_result`. No idle-stall wait.
 *   - **status** — derived from that final state, so a hang (file stops growing
 *     mid-`tool_use`) is recorded as failure, not the stall-path `success`.
 *   - **budget/cost** — honest turn count (distinct `requestId`) and priced
 *     `usage`, enforceable mid-run.
 *
 * Mechanism: offset-based tail. Claude Code appends complete JSON lines to
 * `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. We track a byte offset, read
 * only the appended bytes on each pump, split on newlines, parse complete lines
 * (carrying a partial-line residual across pumps), and fold each event into a
 * running state. `fs.watch` triggers an early pump; a poll interval is the
 * fallback (watch is unreliable across platforms / network FS).
 *
 * Reuses `pricing.ts` for cost and `locateTranscript` for path discovery. No
 * new JSONL parser — events are the same `ClaudeEvent` shape `parser.ts` emits.
 *
 * This is the P1 building block; wiring into `claude-pty.ts` is a separate step
 * so the tail logic can be validated against real transcripts in isolation.
 */

import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClaudeEvent } from './types.js';
import { priceUsage } from './pricing.js';
import { locateTranscript } from './run-record.js';
import { rollupSubagentCost } from './subagent-cost.js';

export interface RunTailState {
	/** True once the transcript file has been located and opened. */
	found: boolean;
	/** Distinct assistant API turns (counted by `requestId`). */
	turns: number;
	/** `stop_reason` of the most recent assistant event, if any. */
	lastStopReason?: string;
	/** A `tool_use` was emitted whose matching `tool_result` hasn't arrived. */
	pendingToolUse: boolean;
	/** Grand total priced `usage`: parent thread + sub-agent (fan-out) spend
	 *  (ADR-005 gap #1). `null` if any priced turn — parent or sub-agent — had
	 *  unknown pricing (mirrors `summarize.ts`: caller shows `—`, never a wrong
	 *  dollar value). This is the honest signal ADR-006 budget enforces against. */
	costUsd: number | null;
	/** Sub-agent (fan-out) portion of `costUsd`. `0` for a non-orchestrator run. */
	subagentCostUsd: number | null;
	/** Distinct assistant turns across all sub-agent transcripts. */
	subagentTurns: number;
	/** Any assistant API error or `tool_result.is_error === true` seen. */
	sawError: boolean;
	/** `Date.now()` when the last event was folded in — freshness signal. */
	lastEventTs: number;
	/** Total events folded so far. */
	eventCount: number;
	/** Terminal completion: last turn ended cleanly with no open tool call. */
	done: boolean;
}

/** ADR-004 D5 — structured progress derived from the transcript, drained by the
 *  dispatcher to emit clean `tool_call` / `step` DispatchEvents instead of raw
 *  ANSI scrollback. Maps 1:1 onto the existing DispatchEvent union. */
export type RunTailProgress =
	| { kind: 'tool'; name: string; ts: number }
	| { kind: 'step'; n: number; finishReason?: string; ts: number };

export interface RunTail {
	/** Current authoritative state. Cheap — returns the live accumulator. */
	snapshot(): RunTailState;
	/** Pull + clear progress events accumulated since the last drain (D5). */
	drain(): RunTailProgress[];
	/** Force a synchronous-ish read of any appended bytes (awaitable). Useful
	 *  for a final flush right before the dispatcher reads the terminal state. */
	pump(): Promise<void>;
	/** Stop watching + polling. Idempotent. */
	stop(): void;
}

export interface RunTailOptions {
	/** cwd the session ran in — speeds up `locateTranscript` (canonical path
	 *  first, then a scan). The PTY dispatcher passes `config.resolved.vaultDir`. */
	cwd?: string;
	/** Poll fallback interval. Default 250ms (matches `run-record`'s settle loop). */
	pollMs?: number;
}

/**
 * Begin tailing the transcript for `sessionId`. Returns immediately; the file
 * may not exist yet (Claude Code writes it a tick after spawn) — `pump()` keeps
 * retrying `locateTranscript` until it appears, then tails from offset 0.
 */
export function createRunTail(sessionId: string, opts: RunTailOptions = {}): RunTail {
	const pollMs = opts.pollMs ?? 250;

	// ── accumulator ──────────────────────────────────────────────────────────
	let path: string | null = null;
	let offset = 0;
	let residual = '';
	const requestIds = new Set<string>();
	const pendingTools = new Set<string>();
	let costUsd = 0;
	let unknownPricing = false;
	// ADR-005 gap #1 — sub-agent (fan-out) spend lives in separate
	// `<uuid>/subagents/agent-*.jsonl` files, not the parent transcript. We sweep
	// them on a throttle (full re-read; the files are small and few) and cache the
	// result so `snapshot()` stays cheap + synchronous.
	let subagentCostUsd = 0;
	let subagentUnknownPricing = false;
	let subagentTurns = 0;
	let lastSubagentSweep = 0;
	const subagentSweepMs = 2000;
	let lastStopReason: string | undefined;
	let sawError = false;
	let lastEventTs = 0;
	let eventCount = 0;
	const progress: RunTailProgress[] = [];

	let stopped = false;
	let pumping = false;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function ingest(e: ClaudeEvent): void {
		eventCount++;
		lastEventTs = Date.now();

		if (e.type === 'assistant') {
			if (e.requestId) requestIds.add(e.requestId);
			const stop = (e.message as { stop_reason?: string } | undefined)?.stop_reason;
			if (stop) lastStopReason = stop;

			const usage = e.message?.usage;
			if (usage) {
				const usd = priceUsage(e.message?.model, usage);
				if (usd === null) unknownPricing = true;
				else costUsd += usd;
			}

			const content = e.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'tool_use' && typeof block.id === 'string') {
						pendingTools.add(block.id);
						// D5 — surface the tool name as live progress.
						if (typeof block.name === 'string') {
							progress.push({ kind: 'tool', name: block.name, ts: lastEventTs });
						}
					}
				}
			}
			// D5 — a completed assistant turn is a step boundary.
			if (stop) progress.push({ kind: 'step', n: requestIds.size, finishReason: stop, ts: lastEventTs });
			// An assistant error event flips the error flag (parser exposes these
			// as forward-compat fields on ClaudeEvent).
			if (e.isApiErrorMessage || e.error) sawError = true;
		} else if (e.type === 'user') {
			// tool_result blocks close out pending tool_use ids. They live in the
			// user message content array; a bare string user message has none.
			const content = e.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
						pendingTools.delete(block.tool_use_id);
						if (block.is_error === true) sawError = true;
					}
				}
			}
		}
	}

	async function pump(): Promise<void> {
		if (stopped || pumping) return;
		pumping = true;
		try {
			if (!path) {
				path = locateTranscript(sessionId, opts.cwd);
				if (!path) return; // not written yet — try again next tick
			}
			// Sub-agent sweep (throttled) — independent of parent growth, since a
			// fan-out parent sits idle on `tool_use` while its sub-agents write.
			const now = Date.now();
			if (now - lastSubagentSweep >= subagentSweepMs) {
				lastSubagentSweep = now;
				try {
					const sa = await rollupSubagentCost(path);
					subagentCostUsd = sa.totalUsd ?? 0;
					subagentUnknownPricing = sa.totalUsd === null;
					subagentTurns = sa.turns;
				} catch {
					/* leave last-known sub-agent figures */
				}
			}
			let size: number;
			try {
				size = (await stat(path)).size;
			} catch {
				return; // vanished mid-run (rotated?) — give up this tick
			}
			if (size < offset) {
				// Truncated/rotated — restart from the top.
				offset = 0;
				residual = '';
			}
			if (size <= offset) return; // no new bytes

			const fh = await open(path, 'r');
			try {
				const len = size - offset;
				const buf = Buffer.allocUnsafe(len);
				const { bytesRead } = await fh.read(buf, 0, len, offset);
				offset += bytesRead;
				residual += buf.subarray(0, bytesRead).toString('utf8');
			} finally {
				await fh.close();
			}

			let nl: number;
			while ((nl = residual.indexOf('\n')) !== -1) {
				const line = residual.slice(0, nl);
				residual = residual.slice(nl + 1);
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					ingest(JSON.parse(trimmed) as ClaudeEvent);
				} catch {
					// Partial/garbled line — skip. JSONL writers occasionally flush
					// mid-line; the next pump re-reads from the same offset only if
					// we hadn't advanced, but we have, so a truly split final line
					// stays in `residual` (no trailing newline) and completes later.
				}
			}
		} finally {
			pumping = false;
		}
	}

	function snapshot(): RunTailState {
		const pending = pendingTools.size > 0;
		// Grand total is null if EITHER part is unpriceable — an honest "—" beats
		// a wrong number, and the dollar cap simply doesn't fire (max_turns still
		// bounds the run, per ADR-004 D4).
		const totalCost =
			unknownPricing || subagentUnknownPricing ? null : costUsd + subagentCostUsd;
		return {
			found: path !== null,
			turns: requestIds.size,
			lastStopReason,
			pendingToolUse: pending,
			costUsd: totalCost,
			subagentCostUsd: subagentUnknownPricing ? null : subagentCostUsd,
			subagentTurns,
			sawError,
			lastEventTs,
			eventCount,
			done: lastStopReason === 'end_turn' && !pending,
		};
	}

	function drain(): RunTailProgress[] {
		return progress.splice(0);
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		if (watcher) {
			try {
				watcher.close();
			} catch {
				/* already closed */
			}
		}
	}

	// Poll fallback drives correctness; fs.watch just shortens latency. We watch
	// the directory (the file may not exist yet) and pump on any change. Failures
	// to watch (ENOENT on a not-yet-created dir) degrade silently to polling.
	timer = setInterval(() => void pump(), pollMs);
	try {
		const dir = dirname(locateTranscript(sessionId, opts.cwd) ?? `${opts.cwd ?? ''}/x`);
		watcher = watch(dir, () => void pump());
	} catch {
		/* polling-only */
	}
	// Kick an immediate first pump so a fast/short run isn't missed before the
	// first interval fires.
	void pump();

	return { snapshot, drain, pump, stop };
}
