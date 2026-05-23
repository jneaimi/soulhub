/** project-phases ADR-009 — vault-scout unblock-watch extractor (pure).
 *
 *  Walks decision-type notes with non-empty `blocked_by`, looks up each
 *  blocker's current `meta.status`, diffs against a snapshot store, and
 *  emits Candidates when the multi-blocker trigger fires:
 *
 *    1. ≥1 blocker transitioned to `shipped` or `superseded` THIS run, AND
 *    2. ALL blockers are NOW in `shipped` or `superseded` state.
 *
 *  First observation of a (dependent, blocker) pair is QUIET — the
 *  snapshot row is INSERTed with the current status and no candidate
 *  fires. This keeps the first post-deploy run noise-free even when the
 *  vault already has 30+ shipped blocker links.
 *
 *  Side effects: the function calls `store.upsert(...)` for any
 *  (dependent, blocker) pair whose status differs from the snapshot
 *  (including first-observation INSERT). Pure aside from that single
 *  injected dependency — exhaustively testable with a fake store.
 *
 *  Per ADR-009 G2 patch, the returned candidates carry a `triggerTrail`
 *  describing prev→new transitions; F2 (zero false-positives) is verified
 *  by walking this trail in tests + live observation.
 */

import { createHash } from 'node:crypto';
import type { VaultNote } from '../../vault/types.js';

export interface BlockerSnapshotStore {
	get(dependentPath: string, blockerPath: string): BlockerSnapshot | null;
	upsert(row: BlockerSnapshot): void;
}

export interface BlockerSnapshot {
	dependent_path: string;
	blocker_path: string;
	blocker_status: string;
	recorded_at: number;
}

export interface BlockerResolver {
	/** Resolve a wikilink as written (e.g. `[[adr-006-engine-templating]]`)
	 *  against the source note's path. Returns vault-relative path or null. */
	resolveLink(raw: string, sourcePath: string): string | null;
	/** Fetch a note by vault-relative path. Returns undefined when the
	 *  path isn't indexed (e.g. the blocker note was deleted). */
	getNote(path: string): VaultNote | undefined;
}

export type TriggerStatus = 'shipped' | 'superseded';

export interface BlockerTrigger {
	blockerPath: string;
	prevStatus: string;
	newStatus: string;
}

export interface UnblockCandidate {
	id: string;
	dependentPath: string;
	dependentSlug: string;
	projectFolder: string;
	/** Set of resolved blocker paths, sorted, that contributed to the ALL-
	 *  shipped check. Frozen-set view, not a diff log. */
	blockerPaths: string[];
	/** Transitions observed THIS run (prev≠new). Each row corresponds to
	 *  one snapshot UPDATE. */
	triggerTrail: BlockerTrigger[];
	/** ISO YYYY-MM-DD when the last-to-ship transition was OBSERVED. The
	 *  ADR spec asks for `blocker_shipped_on_iso`; in practice we record
	 *  the observation date (frontmatter rarely carries `shipped_on` for
	 *  every ADR). Matches `recordedAtIso` of the triggering snapshot row. */
	blockerShippedOn: string;
}

export interface UnblockExtractionStats {
	dependentsScanned: number;
	pairsExamined: number;
	pairsFirstObserved: number;
	transitionsObserved: number;
	unresolvedBlockers: number;
}

export interface UnblockExtractionResult {
	candidates: UnblockCandidate[];
	stats: UnblockExtractionStats;
}

const TRIGGER_STATUSES: ReadonlySet<string> = new Set(['shipped', 'superseded']);

function isTriggerStatus(s: string): s is TriggerStatus {
	return TRIGGER_STATUSES.has(s);
}

function normalizeStatus(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw.trim().toLowerCase();
}

function shortHash(input: string, len = 8): string {
	return createHash('sha256').update(input).digest('hex').slice(0, len);
}

function todayIsoUtc(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** Normalise a `blocked_by` frontmatter value to an array of raw strings.
 *  YAML may parse it as a single string, a list of strings, or a list
 *  containing wikilink-shaped strings. Empty/null returns []. */
export function blockedByToList(raw: unknown): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		return raw
			.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
	}
	if (typeof raw === 'string' && raw.trim() !== '') return [raw];
	return [];
}

/** Strip the surrounding `[[...]]` wrapper + optional `|alias` from a
 *  wikilink-shaped string so the resolver sees the same form it gets from
 *  the parser's extractLinks (inner target only). A bare slug or relative
 *  path passes through unchanged. */
export function unwrapWikilink(raw: string): string {
	const trimmed = raw.trim();
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?(?:#[^\]]*)?\]\]$/.exec(trimmed);
	return m ? m[1].trim() : trimmed;
}

const PROJECT_FOLDER_RE = /^projects\/([^/]+)\//;
function projectFolderFor(path: string): string {
	const m = PROJECT_FOLDER_RE.exec(path);
	return m ? m[1] : '';
}

function slugFromPath(path: string): string {
	const last = path.split('/').pop() ?? path;
	return last.replace(/\.md$/i, '');
}

/** Pure extractor. Walks the supplied decision notes, diffs against the
 *  store, mutates the store with new/updated snapshot rows, and returns
 *  the candidate list + stats.
 *
 *  Multi-blocker trigger semantics (per ADR-009 G1 patch):
 *
 *    emit IF (≥1 blocker transitioned to shipped/superseded this run)
 *          AND (ALL blockers are now in shipped/superseded state)
 *
 *  Behaviour for unresolved blockers: the blocker is skipped (no snapshot
 *  write) AND the dependent cannot satisfy ALL-shipped because we can't
 *  prove the unresolved blocker is shipped. The unresolvedBlockers stat
 *  tracks how many pairs we saw. Operators can audit via the stats field
 *  if a dependent unexpectedly fails to fire. */
export function extractUnblockCandidates(
	decisionNotes: VaultNote[],
	store: BlockerSnapshotStore,
	resolver: BlockerResolver,
	now: number,
): UnblockExtractionResult {
	const candidates: UnblockCandidate[] = [];
	const stats: UnblockExtractionStats = {
		dependentsScanned: 0,
		pairsExamined: 0,
		pairsFirstObserved: 0,
		transitionsObserved: 0,
		unresolvedBlockers: 0,
	};

	const today = todayIsoUtc(now);

	for (const note of decisionNotes) {
		const rawBlockedBy = blockedByToList(note.meta.blocked_by);
		if (rawBlockedBy.length === 0) continue;

		stats.dependentsScanned += 1;

		const resolvedPairs: Array<{ blockerPath: string; currentStatus: string }> = [];
		const triggerTrail: BlockerTrigger[] = [];
		let anyUnresolved = false;

		for (const rawLink of rawBlockedBy) {
			const inner = unwrapWikilink(rawLink);
			const blockerPath = resolver.resolveLink(inner, note.path);
			if (!blockerPath) {
				anyUnresolved = true;
				stats.unresolvedBlockers += 1;
				continue;
			}

			const blockerNote = resolver.getNote(blockerPath);
			if (!blockerNote) {
				anyUnresolved = true;
				stats.unresolvedBlockers += 1;
				continue;
			}

			const currentStatus = normalizeStatus(blockerNote.meta.status);
			stats.pairsExamined += 1;

			const prior = store.get(note.path, blockerPath);
			if (!prior) {
				// Quiet first-observation: snapshot only, no trigger.
				store.upsert({
					dependent_path: note.path,
					blocker_path: blockerPath,
					blocker_status: currentStatus,
					recorded_at: now,
				});
				stats.pairsFirstObserved += 1;
			} else if (prior.blocker_status !== currentStatus) {
				// Transition: update snapshot, record on trail.
				store.upsert({
					dependent_path: note.path,
					blocker_path: blockerPath,
					blocker_status: currentStatus,
					recorded_at: now,
				});
				stats.transitionsObserved += 1;
				triggerTrail.push({
					blockerPath,
					prevStatus: prior.blocker_status,
					newStatus: currentStatus,
				});
			}

			resolvedPairs.push({ blockerPath, currentStatus });
		}

		if (anyUnresolved) {
			// Cannot prove ALL-shipped — skip emission.
			continue;
		}

		// Trigger check:
		//   - at least one transition this run was to shipped/superseded
		//   - AND every blocker is now in shipped/superseded
		const transitionsToShipped = triggerTrail.filter((t) => isTriggerStatus(t.newStatus));
		if (transitionsToShipped.length === 0) continue;

		const allShipped = resolvedPairs.every((p) => isTriggerStatus(p.currentStatus));
		if (!allShipped) continue;

		const sortedBlockerPaths = resolvedPairs
			.map((p) => p.blockerPath)
			.sort();

		const id =
			'unblock-' +
			shortHash(note.path) +
			'-' +
			shortHash(sortedBlockerPaths.join('|'));

		candidates.push({
			id,
			dependentPath: note.path,
			dependentSlug: slugFromPath(note.path),
			projectFolder: projectFolderFor(note.path),
			blockerPaths: sortedBlockerPaths,
			triggerTrail,
			blockerShippedOn: today,
		});
	}

	return { candidates, stats };
}
