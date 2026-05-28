/** projects-graph ADR-019 — proactive prep action layer (pure).
 *
 *  Post-step action layer on vault-scout-unblock candidates. When
 *  vault-scout-unblock emits "X is now unblocked," this extractor
 *  optionally dispatches a prep agent to pre-stage material for the
 *  human-owned task before the operator's turn comes.
 *
 *  Build Option B (ADR-019 decision 2026-05-28): pure action layer on the
 *  existing unblock candidate; does NOT perform an independent scan. Option A
 *  (independent extractor for tasks ready from the start) is deferred.
 *
 *  Snapshot semantics (mirrors vault-scout-unblock.ts pattern exactly):
 *
 *    - No snapshot row → QUIET first-observation: INSERT snapshot (prep_path=null),
 *      emit NO DispatchIntent. This keeps the first post-deploy run noise-free
 *      even when a backlog of unblocked tasks exists.
 *    - Snapshot row with prep_path=null → second encounter: DISPATCH — emit
 *      DispatchIntent and update snapshot (prep_path set to dispatch timestamp).
 *    - Snapshot row with prep_path set → DEDUP: already dispatched, skip.
 *
 *  Guardrails (non-negotiable per ADR-019):
 *    1. Opt-in per project — read `proactive_prep_enabled` from project index.md.
 *    2. One prep per task — snapshot-store dedup.
 *    3. Quiet first-observation — as above.
 *    4. Skip terminal states — `parked` and `superseded` never prep-eligible.
 *    5. Ready-for-you only — skip AI-owned tasks (lane = `ready_for_ai`).
 *    6. Agent-selection heuristic — type/work_type → researcher | author; else skip.
 *
 *  The returned DispatchIntents carry a prompt that explicitly discourages
 *  `ask_operator` (proactive prep is fire-and-forget by design per ADR-019).
 */

import { createHash } from 'node:crypto';
import type { VaultNote } from '../../vault/types.js';
import type { UnblockCandidate } from './vault-scout-unblock.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface PrepSnapshot {
	task_path: string;
	/** null = first-observation recorded (quiet, dispatch not yet emitted).
	 *  non-null = dispatch was emitted; value is 'dispatched:<ms epoch>'. */
	prep_path: string | null;
	recorded_at: number;
}

export interface PrepSnapshotStore {
	get(taskPath: string): PrepSnapshot | null;
	upsert(row: PrepSnapshot): void;
}

export interface PrepResolver {
	/** True when the project has proactive_prep_enabled: true in its index.md. */
	isProjectOptedIn(projectFolder: string): boolean;
	/** Fetch a VaultNote by vault-relative path. Returns undefined when missing. */
	getNote(path: string): VaultNote | undefined;
}

export interface DispatchIntent {
	id: string;
	taskPath: string;
	taskSlug: string;
	projectFolder: string;
	/** 'researcher' or 'author' — the prep specialist for this task type. */
	agentId: string;
	/** Task prompt passed to the dispatched agent. Discourages ask_operator
	 *  per ADR-019 guardrail 6 (fire-and-forget design). */
	prompt: string;
	/** Mirror of the upstream unblock trigger trail for auditability. */
	candidateTrail: ReadonlyArray<{ blockerPath: string; prevStatus: string; newStatus: string }>;
}

export interface PrepExtractionStats {
	candidatesReceived: number;
	skippedNotOptedIn: number;
	skippedTerminalStatus: number;
	skippedAiOwned: number;
	skippedNoAgent: number;
	skippedFirstObservation: number;
	skippedDedup: number;
	dispatched: number;
}

export interface PrepExtractionResult {
	dispatches: DispatchIntent[];
	stats: PrepExtractionStats;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Known AI agent slugs. Tasks whose `assignee` matches one of these are
 *  AI-owned (lane = `ready_for_ai`) — NOT eligible for human-directed prep. */
const AI_AGENT_SLUGS: ReadonlySet<string> = new Set([
	'researcher',
	'author',
	'designer',
	'media-generator',
	'developer',
	'soul-hub-implementer',
	'architect',
	'analyst',
	'hygiene-fixer',
	'mailwright',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['parked', 'superseded']);

// ── Pure helpers ────────────────────────────────────────────────────────────

function shortHash(input: string, len = 8): string {
	return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** Derive which prep agent should handle this task.
 *  Checks `work_type` first (explicit routing), then falls back to note `type`.
 *  Returns null when no agent fits — dispatch is skipped for this candidate. */
export function agentForArtifact(meta: Record<string, unknown>): string | null {
	const wt = typeof meta.work_type === 'string' ? meta.work_type.trim().toLowerCase() : '';
	if (wt === 'research') return 'researcher';
	if (wt === 'writing' || wt === 'doc' || wt === 'report' || wt === 'brief') return 'author';

	const t = typeof meta.type === 'string' ? meta.type.trim().toLowerCase() : '';
	if (t === 'research') return 'researcher';
	if (t === 'doc' || t === 'report' || t === 'brief') return 'author';

	return null;
}

/** True when the task's `assignee` is a known AI agent slug.
 *  AI-owned tasks are in the `ready_for_ai` lane, not `ready_for_you`. */
export function isAiOwned(assignee: unknown): boolean {
	if (typeof assignee !== 'string') return false;
	return AI_AGENT_SLUGS.has(assignee.trim().toLowerCase());
}

/** Build the fire-and-forget prompt for the dispatched prep agent.
 *  Explicitly discourages ask_operator per ADR-019 guardrail 6. */
function buildPrepPrompt(candidate: UnblockCandidate, note: VaultNote | undefined): string {
	const title = note?.title ?? candidate.dependentSlug;
	const blockers = candidate.blockerPaths
		.map((p) => p.replace(/\.md$/i, ''))
		.join(', ');

	return [
		`Proactive prep for: ${title}`,
		`Artifact path: ${candidate.dependentPath}`,
		``,
		`This artifact just became unblocked. The following blocker(s) shipped: ${blockers}.`,
		`The operator will review it in their own time. Your task: pre-stage a prep note`,
		`so the groundwork exists when their turn comes.`,
		``,
		`Produce a concise prep note covering:`,
		`- Brief context: what this artifact is about and why it matters`,
		`- Research brief, options analysis, or outline (as fits the artifact type)`,
		`- Key open questions the operator will need to decide`,
		``,
		`Save the prep note to the vault and link it to the artifact via relates_to:`,
		`  relates_to: "[[${candidate.dependentPath.replace(/\.md$/i, '')}]]"`,
		``,
		`IMPORTANT — fire-and-forget: Do NOT pause to ask the operator for input.`,
		`Do NOT emit ask_operator. Write the note and exit. The operator will review`,
		`your output at their own pace in the Handoff Workbench.`,
	].join('\n');
}

// ── Pure extractor ──────────────────────────────────────────────────────────

/** Pure action-layer extractor. Receives UnblockCandidate[] from
 *  vault-scout-unblock, applies all ADR-019 guardrails, and emits
 *  DispatchIntents for the scheduler site to execute.
 *
 *  Side effects: `store.upsert(...)` for candidates that pass the opt-in,
 *  terminal-status, and agent-selection filters (first-observation INSERT
 *  or dispatch UPDATE). Candidates that fail early filters are NOT written
 *  to the store — they remain eligible for re-evaluation on future runs. */
export function extractProactivePrepDispatches(
	candidates: UnblockCandidate[],
	resolver: PrepResolver,
	store: PrepSnapshotStore,
	now: number,
): PrepExtractionResult {
	const dispatches: DispatchIntent[] = [];
	const stats: PrepExtractionStats = {
		candidatesReceived: 0,
		skippedNotOptedIn: 0,
		skippedTerminalStatus: 0,
		skippedAiOwned: 0,
		skippedNoAgent: 0,
		skippedFirstObservation: 0,
		skippedDedup: 0,
		dispatched: 0,
	};

	for (const candidate of candidates) {
		stats.candidatesReceived++;

		// Guardrail 1: Opt-in per project.
		if (!resolver.isProjectOptedIn(candidate.projectFolder)) {
			stats.skippedNotOptedIn++;
			continue;
		}

		// Fetch the task note for status, owner, and type checks.
		const note = resolver.getNote(candidate.dependentPath);
		const meta = (note?.meta ?? {}) as Record<string, unknown>;

		// Guardrail 4: Skip terminal statuses (parked / superseded).
		const status = typeof meta.status === 'string' ? meta.status.trim().toLowerCase() : '';
		if (TERMINAL_STATUSES.has(status)) {
			stats.skippedTerminalStatus++;
			continue;
		}

		// Guardrail 5 (lane = ready_for_you check): skip AI-owned tasks.
		// AI-assigned tasks are in `ready_for_ai`, not `ready_for_you`.
		if (isAiOwned(meta.assignee)) {
			stats.skippedAiOwned++;
			continue;
		}

		// Agent selection (guardrail 6). Must pass BEFORE committing a snapshot
		// row — we don't record tasks whose type has no matching prep agent, so
		// they remain re-evaluable if their type changes.
		const agentId = agentForArtifact(meta);
		if (!agentId) {
			stats.skippedNoAgent++;
			continue;
		}

		// Guardrails 2 + 3: snapshot dedup + quiet first-observation.
		const prior = store.get(candidate.dependentPath);

		if (!prior) {
			// Guardrail 3: Quiet first-observation — snapshot only, no dispatch.
			store.upsert({
				task_path: candidate.dependentPath,
				prep_path: null,
				recorded_at: now,
			});
			stats.skippedFirstObservation++;
			continue;
		}

		if (prior.prep_path !== null) {
			// Guardrail 2: Already dispatched — dedup (one prep per task).
			stats.skippedDedup++;
			continue;
		}

		// Second+ encounter with prep_path=null: DISPATCH.
		// Update snapshot first so a crash after the update doesn't re-dispatch.
		store.upsert({
			task_path: candidate.dependentPath,
			prep_path: 'dispatched:' + String(now),
			recorded_at: prior.recorded_at,
		});

		const id =
			'prep-' +
			shortHash(candidate.dependentPath) +
			'-' +
			shortHash(agentId + '|' + String(now));

		dispatches.push({
			id,
			taskPath: candidate.dependentPath,
			taskSlug: candidate.dependentSlug,
			projectFolder: candidate.projectFolder,
			agentId,
			prompt: buildPrepPrompt(candidate, note),
			candidateTrail: candidate.triggerTrail,
		});
		stats.dispatched++;
	}

	return { dispatches, stats };
}
