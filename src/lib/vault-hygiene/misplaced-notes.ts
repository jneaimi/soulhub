/** Misplaced-note detector. Walks every note in the vault, runs the same
 *  `classifyZone` logic that `dispatchVaultSave` uses at save-time, and
 *  flags rows whose current zone disagrees with the classifier's
 *  recommendation.
 *
 *  Two-tier confidence:
 *    - HIGH: classifier returned a NON-inbox zone. The signals were strong
 *      enough at save time to route — anything else is misplacement that
 *      the keeper can auto-fix (move + reindex).
 *    - LOW: classifier returned `inbox` but the note has SOME signal that
 *      suggests it belongs elsewhere (project tag, recipe keywords). These
 *      are escalation candidates — the operator decides target.
 *
 *  The detector intentionally scans the whole vault, not just `inbox/`,
 *  so the keeper also catches notes saved into wrong zones by older code
 *  paths (e.g., pre-smart-routing). False-positive cost is low: a note
 *  flagged HIGH means classifier confidently disagrees with current zone,
 *  which is the operator's intent definition.
 */

import type { VaultEngine } from '../vault/index.js';
import { classifyZone, getKnownProjects } from '../vault-save/index.js';
import type { MisplacedNoteIssue } from './types.js';

/** Zones we don't auto-relocate FROM — they're either curated or system
 *  state where the operator's intent overrides classifier signals. */
const ZONES_NEVER_RELOCATE = new Set([
	'archive',  // operator-curated
	'operations/claude-soul',  // soul identity files
	'operations/agents',  // agent definitions
]);

/** Zones never auto-routed TO — only operator decides. */
const ZONES_NEVER_TARGET = new Set([
	'archive',
]);

export function getMisplacedNotes(engine: VaultEngine): MisplacedNoteIssue[] {
	const allNotes = engine.getAllNotes();
	const knownProjects = getKnownProjects();
	const issues: MisplacedNoteIssue[] = [];

	for (const note of allNotes) {
		const currentZone = currentZoneOf(note.path);
		// Scope: only check `inbox/` notes. Everything else is operator-
		// curated — disturbing it triggers more false positives than real
		// fixes (a "weekly-review" note in `knowledge/` is curated, even
		// though the word "review" matches the meeting heuristic). If we
		// later want broader sweeps, run them as one-shot scripts the
		// operator opts into, not on every heartbeat tick.
		if (currentZone !== 'inbox' && !currentZone.startsWith('inbox/')) continue;
		if (isImmutableZone(currentZone)) continue;
		if (note.path.endsWith('/CLAUDE.md') || note.path.endsWith('/index.md')) continue;
		if (note.meta?.type === 'session-log') continue;

		// Re-derive what the classifier would say today. Pull the same
		// fields dispatchVaultSave sees: title, content, type, tags,
		// sourceUrl, sourceAgent.
		const sourceUrl = (note.meta?.source as string | undefined) || undefined;
		const sourceAgent = (note.meta?.source_agent as string | undefined) || undefined;
		const tags = Array.isArray(note.meta?.tags) ? (note.meta.tags as string[]) : [];
		const type = (note.meta?.type as string | undefined) || undefined;

		const suggested = classifyZone(
			{
				title: note.title,
				content: note.content ?? '',
				type: type as 'reference' | 'draft' | 'learning' | 'idea' | undefined,
				tags,
				sourceUrl,
				sourceAgent,
			},
			{ knownProjects },
		);

		if (ZONES_NEVER_TARGET.has(suggested)) continue;
		if (zonesMatch(currentZone, suggested)) continue;

		// Classifier "low signal" → fallback to `inbox`. Never demote a
		// curated note (anything not already in inbox) back to inbox just
		// because no rule fired — operator's placement is the source of
		// truth in the absence of a stronger signal.
		const suggestionIsFallback = suggested === 'inbox' || suggested.startsWith('inbox/');
		if (suggestionIsFallback && !currentZone.startsWith('inbox')) continue;

		// HIGH confidence: classifier returned a specific non-inbox zone
		// that disagrees with the current zone. Auto-fixable.
		// LOW confidence: classifier still suggested inbox/<sub> for an
		// inbox-rooted note — minor cleanup, operator decides.
		const isHighConfidence = !suggestionIsFallback;

		issues.push({
			path: note.path,
			title: note.title,
			currentZone,
			suggestedZone: suggested,
			confidence: isHighConfidence ? 'high' : 'low',
			reason: explainSuggestion(suggested, sourceUrl, sourceAgent, tags),
			suggestedFix: isHighConfidence
				? `Move ${note.path} → ${suggested}/`
				: `Review and route to a specific zone — classifier signals are inconclusive.`,
		});
	}

	// Stable ordering: high-confidence first, then alphabetical by path.
	issues.sort((a, b) => {
		if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
		return a.path.localeCompare(b.path);
	});

	return issues;
}

function currentZoneOf(path: string): string {
	const parts = path.split('/').slice(0, -1);
	return parts.length === 0 ? '' : parts.join('/');
}

function isImmutableZone(zone: string): boolean {
	for (const prefix of ZONES_NEVER_RELOCATE) {
		if (zone === prefix || zone.startsWith(prefix + '/')) return true;
	}
	return false;
}

/** Whether `current` and `suggested` describe the same destination. Match
 *  is symmetric across the parent/child relationship — a note already in
 *  `inbox/shipping/` is "matched" when the classifier suggests the more
 *  general `inbox` (operator already curated to a more-specific subzone),
 *  and a note in `inbox/` is matched when the classifier suggests a more
 *  specific `inbox/<sub>` (the relocation decision is the operator's). */
function zonesMatch(current: string, suggested: string): boolean {
	if (current === suggested) return true;
	if (suggested.startsWith(current + '/')) return true;  // suggested is more specific
	if (current.startsWith(suggested + '/')) return true;  // current is more specific
	return false;
}

function explainSuggestion(zone: string, url?: string, agent?: string, tags?: string[]): string {
	if (agent === 'daily-focus') return 'source_agent=daily-focus → operations/daily-focus';
	if (agent === 'project-hygiene') return 'source_agent=project-hygiene → operations/hygiene';
	if (zone === 'knowledge/research') return `source URL is video/research-class (${url ?? '?'})`;
	if (zone === 'knowledge/cooking/recipes') return 'recipe content or recipe-host source URL';
	if (zone.startsWith('projects/')) return 'meeting-recap content + matching project folder';
	return 'classifier signal';
}
