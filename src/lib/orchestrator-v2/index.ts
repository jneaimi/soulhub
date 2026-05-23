/**
 * Orchestrator v2 public surface (ADR-009).
 *
 * The inbound handler can env-flag swap between v1 (`./orchestrator/`)
 * and v2 (`./orchestrator-v2/`) via `ORCHESTRATOR=v2` so the new path
 * runs side-by-side with the existing one. v2 returns a v1-compatible
 * `DecideResult` so action handlers downstream don't need changes in
 * Phase 1; Phase 2 wires real tool bodies; Phase 7 may refactor the
 * inbound handler to consume tool results directly.
 */

export { decideV2 } from './decide-v2.js';
export type {
	DecideV2Options,
	DecideV2Telemetry,
	V2Output,
	ImgConfigSlice,
} from './types.js';
