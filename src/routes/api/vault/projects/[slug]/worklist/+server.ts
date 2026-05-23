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

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { listAgents } from '$lib/agents/store.js';
import { listRunningSubjectPaths } from '$lib/agents/runs.js';
import type { VaultMeta } from '$lib/vault/types.js';

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

	// projects-graph ADR-018 S2b — artifacts with an in-flight agent run sit in
	// the in_flight lane regardless of their computed readiness.
	let runningSubjects: Set<string>;
	try {
		runningSubjects = listRunningSubjectPaths();
	} catch {
		runningSubjects = new Set(); // runs DB unavailable — lane just stays empty
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
		const blockedBy = asStringArray(r.meta.blocked_by ?? r.meta.blockedBy)
			.map(toSlug)
			.filter((s): s is string => !!s);
		// A blocker is unmet when its status is anything other than shipped.
		// Cross-project blockers (not in this project's index) are conservatively
		// treated as unmet — the operator resolves them manually.
		const blockedByUnmet = blockedBy.filter((dep) => statusBySlug.get(dep) !== 'shipped');

		let lane: Lane;
		if (runningSubjects.has(r.path)) {
			lane = 'in_flight';
		} else if (blockedByUnmet.length === 0) {
			lane = owner === 'ai' ? 'ready_for_ai' : 'ready_for_you';
		} else {
			lane = owner === 'ai' ? 'waiting_on_you' : 'waiting_on_ai';
		}

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
