/**
 * Shared zone-to-note-type derivation.
 * Used by playbook-bridge. (pipeline-bridge + chain-runner archived
 * per ADR-002 on 2026-05-16; the Naseej runner does its own derivation.)
 */
export function deriveNoteType(zone: string): string {
	if (zone.startsWith('content')) return 'draft';
	if (zone.startsWith('knowledge/research')) return 'research';
	if (zone.startsWith('knowledge/debugging')) return 'debugging';
	if (zone.startsWith('knowledge/decisions')) return 'decision';
	if (zone.startsWith('knowledge/patterns')) return 'pattern';
	if (zone.startsWith('knowledge/learnings')) return 'learning';
	if (zone.startsWith('knowledge')) return 'learning';
	return 'output';
}
