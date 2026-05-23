/**
 * Naseej recipe-run event bus (ADR-018 v1).
 *
 * In-memory pub/sub keyed by runId. The runner publishes lifecycle events as
 * it executes; SSE subscribers (GET /api/recipes/runs/<run_id>/events) pull
 * them out. Persistent lifecycle state lives in `naseej_runs` (ADR-021); this
 * module is the **live** channel and a small reconnect buffer.
 *
 * v1 scope (per ADR-018 amendments 2026-05-18):
 *   - 8 event types: recipe_start, step_start, step_output, step_complete,
 *     step_failed, recipe_complete, recipe_failed, recipe_cancelled
 *   - In-memory ring buffer (last 200 events) per active run for late
 *     subscribers / reconnect-during-run. Buffer cleared on terminal event.
 *   - No persistence: ADR-021's `steps_json` covers finished-run replay.
 *   - Multi-subscriber via EventEmitter (multicasts natively).
 *
 * Deferred: human_required + gate_required (ADR-011), artefact_landed (ADR-009).
 */

import { EventEmitter } from 'node:events';

export const NASEEJ_EVENT_SCHEMA_VERSION = 1;

/** Discriminated union of all v1 event payloads. */
export type NaseejEvent =
	| { type: 'recipe_start'; runId: string; recipe: string; recipeVersion: string; project: string; mode: string; source: string; ts: number }
	| { type: 'step_start'; runId: string; stepId: string; stepKind: 'component' | 'agent'; componentSlug?: string; ts: number }
	| { type: 'step_output'; runId: string; stepId: string; payload: unknown; ts: number }
	| { type: 'step_complete'; runId: string; stepId: string; exitCode: number; durationMs: number; ts: number }
	| { type: 'step_failed'; runId: string; stepId: string; exitCode: number; durationMs: number; error?: string; ts: number }
	| { type: 'recipe_complete'; runId: string; durationMs: number; ts: number }
	| { type: 'recipe_failed'; runId: string; failedStep?: string; error?: string; durationMs: number; ts: number }
	| { type: 'recipe_cancelled'; runId: string; failedStep?: string; durationMs: number; ts: number }
	| {
			type: 'human_required';
			runId: string;
			stepId: string;
			prompt: string;
			fields?: Array<{ name: string; type: string; label?: string; required?: boolean; options?: string[] }>;
			timeoutSec: number;
			ts: number;
	  }
	| {
			type: 'gate_required';
			runId: string;
			stepId: string;
			prompt: string;
			allowComment: boolean;
			timeoutSec: number;
			ts: number;
	  };

const BUFFER_LIMIT = 200;

/** Per-runId state: a single EventEmitter for live multicast + a ring
 *  buffer for late-subscriber catch-up. Cleared on terminal event. */
interface RunState {
	emitter: EventEmitter;
	buffer: NaseejEvent[];
	terminated: boolean;
}

const runs = new Map<string, RunState>();

function ensure(runId: string): RunState {
	let state = runs.get(runId);
	if (!state) {
		state = {
			emitter: new EventEmitter(),
			buffer: [],
			terminated: false,
		};
		// Default 10 listeners is too tight if multiple browser tabs subscribe.
		state.emitter.setMaxListeners(100);
		runs.set(runId, state);
	}
	return state;
}

const TERMINAL_TYPES: ReadonlySet<NaseejEvent['type']> = new Set([
	'recipe_complete',
	'recipe_failed',
	'recipe_cancelled',
]);

/** Runner-side: publish an event for `runId`. Live subscribers see it
 *  immediately; late subscribers get it from the ring buffer up to terminal. */
export function publish(event: NaseejEvent): void {
	const state = ensure(event.runId);
	if (state.terminated) return; // Refuse post-terminal emissions.

	state.buffer.push(event);
	if (state.buffer.length > BUFFER_LIMIT) {
		state.buffer.shift();
	}
	state.emitter.emit('event', event);

	if (TERMINAL_TYPES.has(event.type)) {
		state.terminated = true;
		// Drop the buffer + emitter shortly after terminal — give late
		// subscribers a few seconds to catch up.
		setTimeout(() => {
			runs.delete(event.runId);
		}, 10_000);
	}
}

/** Subscriber-side: get current buffer (replay) + register a handler for
 *  future events. Returns an unsubscribe function. Handler is called once
 *  per future event; the buffer is delivered synchronously before subscribe
 *  returns so ordering is preserved. */
export function subscribe(
	runId: string,
	handler: (event: NaseejEvent) => void,
): { replay: NaseejEvent[]; unsubscribe: () => void; terminated: boolean } {
	const state = ensure(runId);
	const replay = [...state.buffer];
	state.emitter.on('event', handler);
	return {
		replay,
		terminated: state.terminated,
		unsubscribe: () => {
			state.emitter.off('event', handler);
		},
	};
}

/** Debug / introspection — used by smoke tests. */
export function activeRunIds(): string[] {
	return [...runs.keys()].filter((id) => !runs.get(id)!.terminated);
}
