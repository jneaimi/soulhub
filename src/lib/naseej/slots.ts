/**
 * Slot taxonomy resolution (ADR-031 CP2).
 *
 * The human/AI collaboration boundary, made machine-readable. Every input of a
 * presentation component carries a slot class:
 *
 *   - `static`        — boilerplate set once, locked, never regenerated. The
 *                       value lives in config (the composition's `slots` block).
 *   - `deterministic` — computed each run by a pipeline step from data, no LLM.
 *   - `judgment`      — per-run LLM or human judgment. The only slots an LLM pass
 *                       should touch.
 *
 * `resolveSlots()` partitions a composition into these three buckets. It is the
 * single contract both the pipeline (which steps to run / skip) and the
 * collaboration UI (ADR-033: which fields a human edits vs AI drafts) read.
 *
 * Effective class precedence (highest first):
 *   1. composition entry `slots.<input>.class`  (per-instance override)
 *   2. component manifest input `slot_class`     (author default)
 *   3. `judgment`                                (safe default — never lock by accident)
 *
 * Effective value precedence (highest first):
 *   1. composition entry `slots.<input>.value`   (config-set static value)
 *   2. composition entry `inputs.<input>`        (inline input)
 */
import type { ComponentManifest, SlotClass } from './schemas/component.js';

/** One presentation-component instance in a composition. Superset of the
 *  doc-render composition entry: adds the optional `slots` config block. */
export interface SlotCompositionEntry {
	component: string;
	inputs?: Record<string, unknown>;
	variant?: string;
	slots?: Record<string, { class?: SlotClass; value?: unknown }>;
}

/** One resolved slot — an input of a composition entry with its effective class. */
export interface ResolvedSlot {
	entryIndex: number;
	component: string;
	input: string;
	class: SlotClass;
	/** Present when a value is known (static config value or inline input).
	 *  A `judgment` slot with no value is the normal "AI must draft this" case. */
	value?: unknown;
	hasValue: boolean;
}

export interface SlotResolution {
	static: ResolvedSlot[];
	deterministic: ResolvedSlot[];
	judgment: ResolvedSlot[];
	warnings: string[];
}

/** Compute the effective class + value for every declared input of every
 *  composition entry, partitioned by class.
 *
 *  `manifestsByName` maps a bare component name → its manifest (the source of
 *  the per-input `slot_class` default + the input list). Entries whose component
 *  is absent from the map are skipped with a warning (the caller's catalog is
 *  the authority on which components exist).
 */
export function resolveSlots(
	composition: SlotCompositionEntry[],
	manifestsByName: Map<string, ComponentManifest>,
): SlotResolution {
	const out: SlotResolution = { static: [], deterministic: [], judgment: [], warnings: [] };

	composition.forEach((entry, entryIndex) => {
		const manifest = manifestsByName.get(entry.component);
		if (!manifest) {
			out.warnings.push(
				`composition[${entryIndex}]: component "${entry.component}" not in catalog — slots not resolved`,
			);
			return;
		}
		const inputs = manifest.inputs ?? [];
		for (const field of inputs) {
			const override = entry.slots?.[field.name];
			const cls: SlotClass = override?.class ?? field.slot_class ?? 'judgment';

			// Value: explicit static config value wins, else the inline input.
			let value: unknown;
			let hasValue = false;
			if (override && 'value' in override && override.value !== undefined) {
				value = override.value;
				hasValue = true;
			} else if (entry.inputs && entry.inputs[field.name] !== undefined) {
				value = entry.inputs[field.name];
				hasValue = true;
			}

			// A static slot with no value is misconfigured — it can never be
			// regenerated, so its value must be supplied in config.
			if (cls === 'static' && !hasValue) {
				out.warnings.push(
					`composition[${entryIndex}].${entry.component}.${field.name}: class=static but no value supplied (static slots must carry their value)`,
				);
			}

			const resolved: ResolvedSlot = {
				entryIndex,
				component: entry.component,
				input: field.name,
				class: cls,
				hasValue,
				...(hasValue ? { value } : {}),
			};
			out[cls].push(resolved);
		}
	});

	return out;
}

/** Assemble the doc-render `inputs` object for one composition entry from the
 *  slots that already have a known value (static config + inline). Judgment
 *  slots without a value are omitted — the pipeline fills those via an LLM/human
 *  step before the final render. This is what lets a `static`-only section
 *  render straight from config with zero LLM call.
 */
export function staticInputsForEntry(
	resolution: SlotResolution,
	entryIndex: number,
): Record<string, unknown> {
	const inputs: Record<string, unknown> = {};
	for (const bucket of [resolution.static, resolution.deterministic, resolution.judgment]) {
		for (const slot of bucket) {
			if (slot.entryIndex === entryIndex && slot.hasValue) {
				inputs[slot.input] = slot.value;
			}
		}
	}
	return inputs;
}
