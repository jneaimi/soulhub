/**
 * ADR-042 D1 — Phase-tracking field validators.
 * ADR-043 P1 — `phase_routing:` schema + validator extension.
 *
 * Pure functions with no runtime dependencies (VaultMeta is type-only).
 * Extracted to their own module so unit tests can import without
 * bootstrapping the full vault engine (which uses compiled-form `.js` imports).
 *
 * The vault engine re-exports `validatePhasedAdrFields` from here so callers
 * that already import from `$lib/vault/index.js` get the same function.
 */

import type { VaultMeta } from './types.js';

/** ADR-043 P1 — allowed keys inside a single `phase_routing` entry.
 *  Unknown keys are ignored with a soft warning rather than a hard reject,
 *  so future routing fields added to P2/P3 don't break existing validators. */
const ALLOWED_PHASE_ROUTING_KEYS = new Set(['owner', 'work_type', 'assignee', 'surface']);

/** ADR-042 D1 — validate `phases:` + `shipped_phases:` frontmatter fields on
 *  `type: decision` notes.
 *  ADR-043 P1 — extended to validate `phase_routing:` (optional per-phase override map).
 *
 *  Invariants enforced:
 *  - `phases` when present: non-empty string[], all elements non-empty, no duplicates.
 *  - `shipped_phases` without `phases`: rejected (subset requires a declared superset).
 *  - `shipped_phases` must be a strict subset of `phases`.
 *  - `phase_routing` without `phases`: rejected (keys require a declared superset).
 *  - Every key in `phase_routing` must appear in `phases`.
 *  - Every value in `phase_routing` must be an object with at least one allowed key.
 *  - Active phase = first element of `phases` not in `shipped_phases`; null when all shipped.
 *
 *  When `phases` is absent the ADR is single-shot — zero impact on existing ADRs. */
export function validatePhasedAdrFields(meta: VaultMeta): string | null {
	// Only decision notes carry phase tracking.
	if (meta.type !== 'decision') return null;

	const phasesRaw: unknown = meta.phases;
	const shippedRaw: unknown = meta.shipped_phases;
	const phaseRoutingRaw: unknown = meta.phase_routing;

	const phasesAbsent = phasesRaw === undefined || phasesRaw === null;

	// shipped_phases without phases: subset requires a declared superset.
	if (
		(shippedRaw !== undefined && shippedRaw !== null) &&
		phasesAbsent
	) {
		return 'shipped_phases requires phases to be declared (ADR-042 D1)';
	}

	// ADR-043 P1: phase_routing without phases: keys require a declared superset.
	if (
		(phaseRoutingRaw !== undefined && phaseRoutingRaw !== null) &&
		phasesAbsent
	) {
		return 'phase_routing requires phases to be declared (ADR-043 P1)';
	}

	// phases absent → single-shot ADR, nothing further to validate.
	if (phasesAbsent) return null;

	// phases must be a non-empty string[].
	if (!Array.isArray(phasesRaw)) {
		return 'phases must be an array of strings (ADR-042 D1)';
	}
	const phasesArr = phasesRaw as unknown[];
	if (phasesArr.length === 0) {
		return 'phases must be non-empty when declared (ADR-042 D1)';
	}
	for (const p of phasesArr) {
		if (typeof p !== 'string' || !(p as string).trim()) {
			return 'phases elements must be non-empty strings (ADR-042 D1)';
		}
	}
	// No duplicates.
	const phaseStrArr = phasesArr as string[];
	const phaseSet = new Set(phaseStrArr);
	if (phaseSet.size !== phaseStrArr.length) {
		return 'phases must not contain duplicates (ADR-042 D1)';
	}

	// ── shipped_phases validation ─────────────────────────────────────────────

	if (shippedRaw !== undefined && shippedRaw !== null) {
		// shipped_phases must be an array of strings.
		if (!Array.isArray(shippedRaw)) {
			return 'shipped_phases must be an array of strings (ADR-042 D1)';
		}
		for (const p of shippedRaw as unknown[]) {
			if (typeof p !== 'string') {
				return 'shipped_phases elements must be strings (ADR-042 D1)';
			}
		}

		// shipped_phases must be a subset of phases.
		for (const p of shippedRaw as string[]) {
			if (!phaseSet.has(p)) {
				return `shipped_phases "${p}" not declared in phases (phases: ${phaseStrArr.join(', ')}) — ADR-042 D1`;
			}
		}
	}

	// ── ADR-043 P1 — validate phase_routing: ─────────────────────────────────

	// phase_routing absent → valid (backward-compat; no change to existing ADRs).
	if (phaseRoutingRaw === undefined || phaseRoutingRaw === null) return null;

	// phase_routing must be a plain non-array object.
	if (typeof phaseRoutingRaw !== 'object' || Array.isArray(phaseRoutingRaw)) {
		return 'phase_routing must be an object mapping phase keys to routing overrides (ADR-043 P1)';
	}

	const phaseRoutingMap = phaseRoutingRaw as Record<string, unknown>;

	for (const [routeKey, routeValue] of Object.entries(phaseRoutingMap)) {
		// Every key must appear in the declared phases array.
		if (!phaseSet.has(routeKey)) {
			return `phase_routing key "${routeKey}" not declared in phases (phases: ${phaseStrArr.join(', ')}) — ADR-043 P1`;
		}

		// Every value must be a non-null, non-array object.
		if (
			routeValue === null ||
			typeof routeValue !== 'object' ||
			Array.isArray(routeValue)
		) {
			return `phase_routing value for "${routeKey}" must be an object (ADR-043 P1)`;
		}

		// Every value must have at least one of the allowed routing keys.
		// Unknown keys are silently accepted so future routing fields added in
		// later phases (P2/P3) don't break this validator.
		const routeObj = routeValue as Record<string, unknown>;
		const knownKeys = Object.keys(routeObj).filter((k) => ALLOWED_PHASE_ROUTING_KEYS.has(k));
		if (knownKeys.length === 0) {
			return (
				`phase_routing value for "${routeKey}" must have at least one of: ` +
				`${[...ALLOWED_PHASE_ROUTING_KEYS].join(', ')} (ADR-043 P1)`
			);
		}

		// Validate owner value when present — only "ai" | "human" are valid.
		if ('owner' in routeObj) {
			const ownerVal = routeObj['owner'];
			if (ownerVal !== 'ai' && ownerVal !== 'human') {
				return `phase_routing["${routeKey}"].owner must be "ai" or "human" (ADR-043 P1)`;
			}
		}
	}

	return null;
}

/** ADR-042 D1 — derive the active phase from frontmatter.
 *  Returns the first element of `phases` not in `shipped_phases`.
 *  Returns `null` when all phases are shipped OR when `phases` is absent. */
export function activePhase(meta: VaultMeta): string | null {
	const phasesRaw: unknown = meta.phases;
	const shippedRaw: unknown = meta.shipped_phases;

	if (!Array.isArray(phasesRaw) || (phasesRaw as unknown[]).length === 0) return null;
	const phases = phasesRaw as string[];
	const shipped = new Set(
		Array.isArray(shippedRaw) ? (shippedRaw as string[]) : [],
	);
	return phases.find((p) => !shipped.has(p)) ?? null;
}

/** ADR-042 D4 / #62 (2026-05-30) — derive the unshipped-phases set + the
 *  shape both the CLI smart-ship guard (`cli/src/verbs/adr.ts`) and the UI
 *  ship-merge endpoint (`src/routes/api/agents/ship-merge/+server.ts`) need
 *  for a consistent structured warning/error.
 *
 *  Returns `phases`, `shippedPhases`, `unshippedPhases` as parallel arrays.
 *  When `phases` is absent → all three are `[]` (caller treats as single-shot,
 *  no guard applies).  When all phases shipped → `unshippedPhases` is `[]`
 *  (caller treats as safe to flip status: shipped).
 *
 *  Pure — same shape as `activePhase`; the CLI's current logic can adopt this
 *  in a future consolidation pass without runtime risk. */
export interface UnshippedPhasesReport {
	phases: string[];
	shippedPhases: string[];
	unshippedPhases: string[];
}
export function unshippedPhases(meta: VaultMeta): UnshippedPhasesReport {
	const phasesRaw: unknown = meta.phases;
	const shippedRaw: unknown = meta.shipped_phases;

	if (!Array.isArray(phasesRaw) || (phasesRaw as unknown[]).length === 0) {
		return { phases: [], shippedPhases: [], unshippedPhases: [] };
	}
	const phases = (phasesRaw as unknown[]).filter(
		(p): p is string => typeof p === 'string' && (p as string).trim().length > 0,
	);
	const shippedPhases = Array.isArray(shippedRaw)
		? (shippedRaw as unknown[]).filter((p): p is string => typeof p === 'string')
		: [];
	const shippedSet = new Set(shippedPhases);
	const unshippedPhases = phases.filter((p) => !shippedSet.has(p));
	return { phases, shippedPhases, unshippedPhases };
}
