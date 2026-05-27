/** GET /api/vault/projects/:slug/worklist
 *
 *  projects-graph ADR-018 (Handoff Workbench) — the human↔AI collaboration
 *  surface. Returns the project's *actionable* artifacts grouped into the
 *  five readiness lanes, computed from `assignee` (ownership) + the status
 *  of each artifact's `blocked_by` upstream.
 *
 *  Lanes (per ADR-018 P-A):
 *    - ready_for_ai   — AI-owned, all blockers shipped
 *    - waiting_on_you — AI-owned, blocked by an unshipped upstream (you)
 *    - ready_for_you  — human/unassigned-owned, blockers clear
 *    - waiting_on_ai  — human/unassigned-owned, blocked by an unshipped upstream
 *    - in_flight      — an agent run is active (populated by ADR-018 S2 dispatch;
 *                       always empty in S1)
 *
 *  Actionable = type in {decision, task, risk, metric, post, design,
 *  requirements} (ADR-021) AND status in {proposed, accepted}. Shipped/parked/
 *  rejected/superseded are terminal and excluded. Pure read transform over
 *  engine.getNotes(); no explicit cache. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { listAgents } from '$lib/agents/store.js';
import {
	listRunningRuns,
	listAwaitingOperatorInput,
	listReviewableRuns,
	listNoArtifactRuns,
} from '$lib/agents/runs.js';
import type { RunningRunTelemetry } from '$lib/agents/runs.js';
import { computeLaneAndProgress } from '$lib/projects/worklist-lane.js';
import type {
	AwaitingOperatorPayload,
	ReviewHandoffPayload,
	NoArtifactPayload,
} from '$lib/projects/worklist-lane.js';
import { safeId } from '$lib/agents/dispatch/worktree-provision.js';
import { parseHandback, handbackGatesGreen } from '$lib/agents/handback.js';
import type { VaultMeta } from '$lib/vault/types.js';

const execFileAsync = promisify(execFile);

// projects-graph ADR-021 — design + requirements added so design/brand-heavy
// legacy projects (e.g. triden) surface their real work, not just decisions.
// `proposal` deferred: its open/applied/rejected lifecycle ≠ ACTIONABLE_STATUSES.
const ACTIONABLE_TYPES = new Set([
	'decision',
	'task',
	'risk',
	'metric',
	'post',
	'design',
	'requirements',
]);
const ACTIONABLE_STATUSES = new Set(['proposed', 'accepted']);

type Lane = 'ready_for_ai' | 'waiting_on_you' | 'ready_for_you' | 'waiting_on_ai' | 'in_flight';
type Owner = 'ai' | 'human' | 'unassigned';

interface WorklistItem {
	id: string;
	slug: string;
	title: string;
	type: string;
	status: string;
	assignee: string | null;
	owner: Owner;
	work_type: string | null;
	/** All declared blocked_by slugs (resolved to bare slug). */
	blockedBy: string[];
	/** Subset whose upstream is not shipped (the reason it's gated). */
	blockedByUnmet: string[];
	lane: Lane;
	/** projects-graph ADR-026 — live run telemetry for in_flight items. */
	progress?: { costUsd: number; numTurns: number; startedAt: number };
	/** ADR-026 P2b — populated when a paused run is awaiting operator input. */
	awaitingOperator?: AwaitingOperatorPayload;
	/** ADR-026 D3 — populated when a finished, un-merged coding run is awaiting review. */
	reviewHandoff?: ReviewHandoffPayload;
	/** ADR-012 P1 — populated when a success-like run left no reviewable artifact. */
	noArtifact?: NoArtifactPayload;
}

interface WorklistResponse {
	project: string;
	generated_at: string;
	lanes: Record<Lane, WorklistItem[]>;
	counts: Record<Lane, number>;
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

/** `[[adr-001-foo|alias]]` → `adr-001-foo`; `adr-002` → `adr-002`;
 *  cross-project `[[../other/x]]` → `x` (last segment). */
function toSlug(raw: string): string | null {
	const trimmed = raw.trim();
	const wiki = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(trimmed);
	const target = wiki ? wiki[1].trim() : trimmed;
	const last = target.split('/').pop() ?? target;
	return last.replace(/\.md$/i, '') || null;
}
/** Inner `[[target|alias]]` → `target` (path or bare slug), for the engine's
 *  global link resolver. Unlike toSlug it keeps any `../project/...` prefix so
 *  cross-project blockers resolve to the right note. Null for non-wikilinks. */
function wikilinkTarget(raw: string): string | null {
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(raw.trim());
	return m ? m[1].trim() : null;
}

function asStr(v: unknown): string | null {
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}


function extractTitle(meta: VaultMeta, body: string, slug: string): string {
	const t = meta.title;
	if (typeof t === 'string' && t.trim().length > 0) return t.trim();
	const h1 = /^#\s+(.+?)\s*$/m.exec(body);
	if (h1) return h1[1].trim();
	return slug;
}

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	// Agent roster — an assignee matching an agent id is AI-owned.
	const agentIds = new Set(listAgents().agents.map((a) => a.id.toLowerCase()));
	const classifyOwner = (assignee: string | null): Owner => {
		if (!assignee) return 'unassigned';
		return agentIds.has(assignee.toLowerCase()) ? 'ai' : 'human';
	};

	// projects-graph ADR-026 — artifacts with an in-flight agent run sit in
	// the in_flight lane, enriched with live telemetry (cost/turns/elapsed).
	let runningRuns: Map<string, RunningRunTelemetry>;
	try {
		runningRuns = listRunningRuns();
	} catch {
		runningRuns = new Map(); // runs DB unavailable — lane just stays empty
	}

	// ADR-026 P2b — paused runs awaiting an operator answer. The question lives
	// in error_message prefixed with `OPERATOR_QUESTION: `. Branch is
	// reconstructed from (startedAt, subjectPath) — no schema change needed.
	let awaitingBySubject: Map<string, AwaitingOperatorPayload>;
	try {
		const awaitingRows = listAwaitingOperatorInput();
		awaitingBySubject = new Map();
		for (const row of awaitingRows) {
			if (!row.subjectPath) continue;
			const question = (row.errorMessage ?? '').replace(/^OPERATOR_QUESTION:\s*/, '');
			const sessionId = row.claudeSessionId ?? '';
			const branch = `orchestration/run-${row.startedAt}/${safeId(row.subjectPath)}`;
			awaitingBySubject.set(row.subjectPath, {
				question,
				sessionId,
				branch,
				agentId: row.agentId,
			});
		}
	} catch {
		awaitingBySubject = new Map(); // DB unavailable — awaiting lane behaves as before
	}

	// ADR-026 D3 — reviewable (finished, un-merged) runs per subject_path.
	// We only surface runs whose worktree branch still exists in the repo; a
	// discarded branch means the run was already handled (merged or abandoned).
	let reviewBySubject: Map<string, ReviewHandoffPayload>;
	try {
		const reviewableRuns = listReviewableRuns();

		// ONE git branch list call for all orchestration/* branches.
		let liveBranches = new Set<string>();
		try {
			const { stdout } = await execFileAsync(
				'git',
				['branch', '--list', 'orchestration/*', '--format=%(refname:short)'],
				{ cwd: process.cwd() },
			);
			liveBranches = new Set(
				stdout
					.split('\n')
					.map((b) => b.trim())
					.filter(Boolean),
			);
		} catch {
			// git unavailable or no orchestration branches — treat all runs as discarded
		}

		reviewBySubject = new Map();
		for (const [subjectPath, run] of reviewableRuns) {
			const branch = `orchestration/run-${run.startedAt}/${safeId(subjectPath)}`;
			// Only surface if the branch still exists (un-merged) in the repo.
			if (!liveBranches.has(branch)) continue;

			// ADR-026 D3 — prefer the full untruncated `handback` column; fall
			// back to `resultExcerpt` for runs predating this migration (null
			// handback) so existing rows still render something rather than blank.
			const hb = parseHandback(run.handback ?? run.resultExcerpt);
			reviewBySubject.set(subjectPath, {
				branch: hb?.branch ?? branch,
				summary: hb?.summary ?? '',
				followUps: hb?.follow_ups ?? [],
				gatesGreen: hb ? handbackGatesGreen(hb) : false,
				costUsd: run.costUsd,
			});
		}
	} catch {
		reviewBySubject = new Map(); // runs DB unavailable — review lane stays empty
	}

	// ADR-012 P1 — success-like runs that produced no reviewable artifact.
	// Surfaced in Waiting-on-you with a short summary so they don't fall back
	// to a silent ready_for_ai. A subject with a live review branch (above)
	// takes precedence in the lane logic, so we don't need to cross-filter here.
	let noArtifactBySubject: Map<string, NoArtifactPayload>;
	try {
		noArtifactBySubject = new Map();
		for (const [subjectPath, run] of listNoArtifactRuns()) {
			// Use the first non-empty line of the excerpt as a one-line summary.
			const summary =
				(run.resultExcerpt ?? '')
					.split('\n')
					.map((l) => l.trim())
					.find((l) => l.length > 0) ?? '';
			noArtifactBySubject.set(subjectPath, {
				summary: summary.length > 200 ? summary.slice(0, 200) + '…' : summary,
				costUsd: run.costUsd,
				numTurns: run.numTurns,
			});
		}
	} catch {
		noArtifactBySubject = new Map(); // runs DB unavailable — lane stays empty
	}

	const notes = engine
		.getNotes({ project: slug, limit: 500 })
		.filter((n) => !n.path.startsWith('archive/'));

	// First pass: index every note's slug → { status, owner } so we can resolve
	// each artifact's blockers (status drives gating; owner drives lane side).
	const statusBySlug = new Map<string, string>();
	const ownerBySlug = new Map<string, Owner>();
	type Raw = { path: string; meta: VaultMeta; body: string; slug: string };
	const raws: Raw[] = [];

	for (const note of notes) {
		const full = engine.getNote(note.path);
		if (!full) continue;
		const noteSlug = note.path.split('/').pop()?.replace(/\.md$/i, '') ?? note.path;
		const status = String(full.meta.status ?? '').toLowerCase();
		statusBySlug.set(noteSlug, status);
		ownerBySlug.set(noteSlug, classifyOwner(asStr(full.meta.assignee)));
		raws.push({ path: note.path, meta: full.meta, body: full.content, slug: noteSlug });
	}

	const items: WorklistItem[] = [];
	for (const r of raws) {
		const type = String(r.meta.type ?? '').toLowerCase();
		const status = String(r.meta.status ?? '').toLowerCase();
		if (!ACTIONABLE_TYPES.has(type) || !ACTIONABLE_STATUSES.has(status)) continue;

		const assignee = asStr(r.meta.assignee);
		const owner = classifyOwner(assignee);
		const blockedByRaw = asStringArray(r.meta.blocked_by ?? r.meta.blockedBy);
		const blockedBy = blockedByRaw.map(toSlug).filter((s): s is string => !!s);
		// A blocker is unmet unless its status is 'shipped'. Project-local
		// blockers resolve from the fast in-project index; CROSS-PROJECT blockers
		// resolve through the engine's global link resolver so they're gated on
		// their real status. (Previously cross-project blockers were treated as
		// permanently unmet — a soul-hub-agents ADR blocked_by a *shipped*
		// soul-hub-whatsapp ADR stayed stuck in waiting_on_ai forever.)
		const blockedByUnmet = blockedByRaw
			.filter((raw) => {
				const slug = toSlug(raw);
				if (!slug) return false;
				const local = statusBySlug.get(slug);
				if (local !== undefined) return local !== 'shipped';
				const target = wikilinkTarget(raw);
				const resolved = target ? engine.resolveLink(target, r.path) : null;
				const st = resolved
					? String(engine.getNote(resolved)?.meta.status ?? '').toLowerCase()
					: '';
				return st !== 'shipped';
			})
			.map(toSlug)
			.filter((s): s is string => !!s);

		const awaitingOperator = awaitingBySubject.get(r.path);
		const reviewHandoff = reviewBySubject.get(r.path);
		const noArtifact = noArtifactBySubject.get(r.path);
		const {
			lane,
			progress,
			awaitingOperator: awaitingResult,
			reviewHandoff: reviewResult,
			noArtifact: noArtifactResult,
		} = computeLaneAndProgress(
			r.path,
			owner,
			blockedByUnmet,
			runningRuns,
			awaitingOperator,
			reviewHandoff,
			noArtifact,
		);

		items.push({
			id: r.path,
			slug: r.slug,
			title: extractTitle(r.meta, r.body, r.slug),
			type,
			status,
			assignee,
			owner,
			work_type: asStr(r.meta.work_type),
			blockedBy,
			blockedByUnmet,
			lane,
			progress,
			awaitingOperator: awaitingResult,
			reviewHandoff: reviewResult,
			noArtifact: noArtifactResult,
		});
	}

	const lanes: Record<Lane, WorklistItem[]> = {
		ready_for_ai: [],
		waiting_on_you: [],
		ready_for_you: [],
		waiting_on_ai: [],
		in_flight: [],
	};
	for (const it of items) lanes[it.lane].push(it);

	// Within a lane: proposed before accepted, then title for determinism.
	const sortLane = (a: WorklistItem, b: WorklistItem) => {
		const rank = (s: string) => (s === 'proposed' ? 0 : 1);
		const r = rank(a.status) - rank(b.status);
		return r !== 0 ? r : a.title.localeCompare(b.title);
	};
	for (const k of Object.keys(lanes) as Lane[]) lanes[k].sort(sortLane);

	const counts = Object.fromEntries(
		(Object.keys(lanes) as Lane[]).map((k) => [k, lanes[k].length]),
	) as Record<Lane, number>;

	const response: WorklistResponse = {
		project: slug,
		generated_at: new Date().toISOString(),
		lanes,
		counts,
	};
	return json(response);
};
