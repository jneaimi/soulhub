/**
 * ADR-044 P1 — ADR Lint Rules.
 *
 * Pure functions. No I/O. The CLI (`soul adr lint`) calls this against the
 * vault API's note shape; the dispatcher endpoint (`/api/agents/<slug>/test`)
 * calls the same code with the same shape.
 *
 * Three high-signal rules derived from the 2026-05-30 corpus survey
 * (knowledge/learnings/2026-05-30-adr-corpus-lint-survey.md):
 *   R5  — shipped_phases without phases (hard fail)
 *   R9  — multi-surface phased ADR without phase_routing
 *   R11 — human/config phase body without phase_routing.<phase>
 *
 * Pass-through on clean ADRs; non-empty findings on the 6 known-dirty
 * ADRs from the corpus (validated by `npm run test:adr-lint`).
 */

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
	rule: string;
	severity: Severity;
	message: string;
}

export interface AdrNoteForLint {
	path: string;
	meta: Record<string, unknown>;
	content: string;
}

/** Surface tokens that suggest distinct dispatch surfaces when they appear
 *  in different phase sections. Drives R9 detection. Extensible per new
 *  surface — appending here is the only change needed when a new repo is
 *  bound (e.g. a future `naseej` surface). */
const SURFACE_TOKENS = [
	'soul-hub',
	'evaluate-session',
	'face/',
	'naseej',
	'signal-forge',
	'elevenlabs',
	'dashboard',
	'coffee-ops',
] as const;

/** Markers that suggest a phase is human-owned / config-only / manual work.
 *  Drives R11 detection. Conservative — matches explicit declarations the
 *  AI itself writes when authoring multi-discipline ADRs. */
const HUMAN_CONFIG_MARKERS = [
	'owner=human',
	'owner: human',
	'human-config',
	'human config',
	'work_type: config',
	'work_type=config',
	'(owner=human, manual)',
] as const;

/** Allowed top-level routing keys inside a single phase_routing entry.
 *  Same set as the runtime validator from ADR-043 P1. */
const ALLOWED_PHASE_ROUTING_KEYS = new Set(['owner', 'work_type', 'assignee', 'surface']);

function getPhasesArray(meta: Record<string, unknown>): string[] | null {
	const raw = meta.phases;
	if (!Array.isArray(raw)) return null;
	const phases = raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
	return phases.length > 0 ? phases : null;
}

function getShippedArray(meta: Record<string, unknown>): string[] | null {
	const raw = meta.shipped_phases;
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw)) return [];
	return raw.filter((p): p is string => typeof p === 'string');
}

function getPhaseRoutingMap(meta: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
	const raw = meta.phase_routing;
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) return null;
	return raw as Record<string, Record<string, unknown>>;
}

/** Split the body into one section per declared phase, keyed by phase ID.
 *  Each value is the phase body text (everything from the `### Pn —` heading
 *  to the NEXT heading at depth 3 or 2 — whichever comes first). Phases
 *  declared in `phases:` but missing from the body produce empty strings.
 *
 *  Lookahead `(?=^###\\s|^##\\s|\\Z)` is the critical bit: without the
 *  `^###` alternative, P1's section would leak into P2/P3 prose and cause
 *  R11 false positives when later phases declare human/config work
 *  (observed 2026-05-30 on ADR-043 self-lint). */
function splitPhaseSections(body: string, phases: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const phase of phases) {
		const re = new RegExp(`^### ${phase}\\b[^\\n]*$([\\s\\S]*?)(?=^###\\s|^##\\s|\\Z)`, 'm');
		const m = re.exec(body);
		out[phase] = m ? m[1] : '';
	}
	return out;
}

function surfacesInSection(sectionLower: string): Set<string> {
	const hits = new Set<string>();
	for (const token of SURFACE_TOKENS) {
		if (sectionLower.includes(token)) hits.add(token);
	}
	return hits;
}

function sectionMentionsHumanConfig(sectionLower: string): boolean {
	return HUMAN_CONFIG_MARKERS.some((m) => sectionLower.includes(m));
}

function phaseRoutingClaimsHuman(entry: Record<string, unknown> | undefined): boolean {
	if (!entry) return false;
	const owner = String(entry.owner ?? '').toLowerCase();
	const workType = String(entry.work_type ?? '').toLowerCase();
	return owner === 'human' || workType === 'config' || workType === 'manual' || workType === 'governance';
}

/** ADR-044 R5 — shipped_phases without phases.
 *  Already enforced by the ADR-042 D1 runtime validator on writes, but lint
 *  surfaces it at the CLI for ADRs already in this state (corpus pass). */
export function lintR5(note: AdrNoteForLint): Finding[] {
	const meta = note.meta;
	const shipped = meta.shipped_phases;
	const hasShipped = shipped !== undefined && shipped !== null;
	const hasPhases = meta.phases !== undefined && meta.phases !== null && Array.isArray(meta.phases) && (meta.phases as unknown[]).length > 0;
	if (hasShipped && !hasPhases) {
		return [{
			rule: 'R5_shipped_without_phases',
			severity: 'high',
			message: `shipped_phases is set (${JSON.stringify(shipped)}) but phases is null/empty — invalid by ADR-042 D1.`,
		}];
	}
	return [];
}

/** ADR-044 R9 — multi-surface phased ADR without phase_routing.
 *  Fires when phases.length >= 2 AND distinct phase bodies mention different
 *  surface tokens AND phase_routing is absent. */
export function lintR9(note: AdrNoteForLint): Finding[] {
	const phases = getPhasesArray(note.meta);
	if (!phases || phases.length < 2) return [];
	const phaseRouting = getPhaseRoutingMap(note.meta);
	if (phaseRouting !== null) return []; // operator declared per-phase routing; rule satisfied

	const sections = splitPhaseSections(note.content, phases);
	const surfaceSets: Set<string>[] = phases.map((p) => surfacesInSection(sections[p].toLowerCase()));
	const allSurfaces = new Set<string>();
	for (const s of surfaceSets) for (const v of s) allSurfaces.add(v);
	if (allSurfaces.size < 2) return [];

	// Detect if at least two phases name *different* surface sets — not just
	// the same surface mentioned across all phases.
	const signatures = new Set(surfaceSets.map((s) => [...s].sort().join('|')).filter((sig) => sig.length > 0));
	if (signatures.size < 2) return [];

	return [{
		rule: 'R9_multi_surface_no_routing',
		severity: 'high',
		message: `Multi-phase ADR mentions distinct surfaces (${[...allSurfaces].sort().join(', ')}) across phases but has no phase_routing. Each phase's dispatch will fall back to top-level routing — guaranteed misroute for at least one phase. Add phase_routing: { ${phases.map((p) => `${p}: { ... }`).join(', ')} }.`,
	}];
}

/** ADR-044 R11 — human/config phase body without phase_routing override.
 *  Fires per-phase: if a phase body declares owner=human / work_type=config
 *  and the matching phase_routing.<phase> entry doesn't carry that
 *  override, the dispatcher will route the phase as a coding job. */
export function lintR11(note: AdrNoteForLint): Finding[] {
	const phases = getPhasesArray(note.meta);
	if (!phases) return [];
	const phaseRouting = getPhaseRoutingMap(note.meta) ?? {};
	const sections = splitPhaseSections(note.content, phases);
	const findings: Finding[] = [];

	for (const phase of phases) {
		const sectionLower = sections[phase].toLowerCase();
		if (!sectionMentionsHumanConfig(sectionLower)) continue;
		if (phaseRoutingClaimsHuman(phaseRouting[phase])) continue;
		findings.push({
			rule: 'R11_human_phase_no_routing',
			severity: 'high',
			message: `Phase ${phase}'s body declares human-owned / config work but phase_routing.${phase} doesn't override the top-level routing. Without phase_routing.${phase} = { owner: 'human', work_type: 'config' (or similar) }, dispatch will route this phase as coding to the top-level assignee.`,
		});
	}

	return findings;
}

/** Run the full ADR lint suite. Order is stable for reproducible CI output. */
export function lintAdr(note: AdrNoteForLint): Finding[] {
	return [
		...lintR5(note),
		...lintR9(note),
		...lintR11(note),
	];
}

/** Convenience for dispatcher hooks: returns the high-severity findings only.
 *  The dispatcher refuses on high-severity; medium/low are surfaced in CLI
 *  output but don't block dispatch. */
export function lintAdrHighSeverity(note: AdrNoteForLint): Finding[] {
	return lintAdr(note).filter((f) => f.severity === 'high');
}

/** Validate that a phase_routing object's structure is internally consistent.
 *  Mirrors the ADR-043 P1 runtime validator (for use at CLI propose-time when
 *  the note hasn't been written yet). */
export function validatePhaseRoutingShape(meta: Record<string, unknown>): Finding[] {
	const phases = getPhasesArray(meta);
	const phaseRouting = getPhaseRoutingMap(meta);
	if (!phaseRouting) return [];
	if (!phases) {
		return [{
			rule: 'R10_phase_routing_no_phases',
			severity: 'high',
			message: 'phase_routing is set but phases is missing — phase_routing requires a phases superset.',
		}];
	}
	const phaseSet = new Set(phases);
	const findings: Finding[] = [];
	for (const [phaseKey, entry] of Object.entries(phaseRouting)) {
		if (!phaseSet.has(phaseKey)) {
			findings.push({
				rule: 'R10_phase_routing_bad_key',
				severity: 'high',
				message: `phase_routing key "${phaseKey}" is not in phases: ${phases.join(', ')}.`,
			});
			continue;
		}
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			findings.push({
				rule: 'R10_phase_routing_bad_value',
				severity: 'high',
				message: `phase_routing.${phaseKey} must be an object (got ${typeof entry}).`,
			});
			continue;
		}
		const keys = Object.keys(entry).filter((k) => ALLOWED_PHASE_ROUTING_KEYS.has(k));
		if (keys.length === 0) {
			findings.push({
				rule: 'R10_phase_routing_empty_value',
				severity: 'high',
				message: `phase_routing.${phaseKey} must have at least one of: ${[...ALLOWED_PHASE_ROUTING_KEYS].join(', ')}.`,
			});
		}
		if ('owner' in entry) {
			const o = (entry as Record<string, unknown>).owner;
			if (o !== 'ai' && o !== 'human') {
				findings.push({
					rule: 'R10_phase_routing_bad_owner',
					severity: 'high',
					message: `phase_routing.${phaseKey}.owner must be "ai" or "human" (got ${JSON.stringify(o)}).`,
				});
			}
		}
	}
	return findings;
}
