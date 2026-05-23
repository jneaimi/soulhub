/**
 * Shared response shapes for ADR-011 human / gate steps.
 *
 * Kept in a tiny sibling module so the pause-registry, the runner, AND the
 * /respond endpoint can all import without a cycle.
 */

export interface HumanResponse {
	/** Free-form payload — runner exposes as `{{steps.<id>.outputs.response}}`. */
	response: Record<string, unknown> | string;
}

export interface GateResponse {
	decision: 'approved' | 'rejected';
	comment?: string;
}
