<script lang="ts">
	/** Side-viewer drawer for a single ADR / vault note.
	 *
	 *  Slides in from the right. Fetches `/api/vault/notes/<path>` to get the
	 *  pre-rendered HTML and frontmatter. For a proposed ADR (status field on
	 *  the note's frontmatter), embeds the same `DecisionActions` strip the
	 *  detail page and the queue use, so the operator can decide without
	 *  closing the drawer.
	 *
	 *  Closes on backdrop click + ESC. The parent owns open/close state.
	 */

	import { onMount, untrack } from 'svelte';
	import RenderedMarkdown from '../RenderedMarkdown.svelte';
	import DecisionActions from './DecisionActions.svelte';
	import { resolveAgentForWork, clusterFromTags, classifySurface } from '$lib/projects/dispatch-routing.js';
	import { parseHandback, handbackGatesGreen, type ParsedHandback } from '$lib/agents/handback.js';

	interface NoteLink {
		raw: string;
		resolved?: string;
		embed?: boolean;
	}

	interface NotePayload {
		path: string;
		title: string;
		meta: Record<string, unknown>;
		content?: string;
		rendered: string;
		contentIsRtl?: boolean;
		links?: NoteLink[];
		/** Engine-resolved relationship-field wikilinks (`blocked_by`, etc.):
		 *  raw target → vault path (or null if unresolvable). Authoritative —
		 *  uses the global slug/alias index, so cross-project bare slugs resolve
		 *  correctly where the drawer's directory-relative fallback would 404. */
		depResolved?: Record<string, string | null>;
		backlinks?: string[];
	}

	type DrawerAction = 'accept' | 'reject' | 'park' | 'ship';

	interface Props {
		path: string | null;
		onClose: () => void;
		onTransition?: (info: { path: string; action: DrawerAction; newStatus: string }) => void;
		/** projects-graph ADR-025 D5 — when true AND canDispatch, call dispatchToAI()
		 *  once after the note loads.  Set by the page after an Accept → AI confirm
		 *  from DecisionActions so the drawer reuses its existing stream + review card. */
		autoDispatch?: boolean;
		/** projects-graph ADR-025 D5 — propagated from the page to DecisionActions
		 *  inside this drawer so the confirm flow closes + re-opens the drawer with
		 *  autoDispatch=true even when the confirm originates from inside the drawer. */
		onDispatch?: (path: string) => void;
	}

	let { path, onClose, onTransition, autoDispatch = false, onDispatch }: Props = $props();

	/** Internal navigation state — mirrors `path` from the parent on open,
	 *  but lets in-drawer link clicks (cross-project panel) swap to another
	 *  note without closing. Reset to `path` whenever the prop changes so
	 *  the parent stays in control of open/close. */
	let currentPath = $state<string | null>(null);

	let note = $state<NotePayload | null>(null);
	let loading = $state(false);
	let error = $state('');

	// Phase 3a affordances state
	let shipping = $state(false);
	// projects-graph ADR-027 P1 — Ship & merge state
	let shippingAndMerging = $state(false);
	let shipMergeError = $state('');
	let savingTarget = $state(false);
	let targetDateInput = $state('');
	let editingTarget = $state(false);
	// projects-graph ADR-017 P3 — assignee (ownership), orthogonal to status.
	let savingAssignee = $state(false);
	let assigneeInput = $state('');
	let editingAssignee = $state(false);
	// projects-graph ADR-018 S2 — Dispatch to AI loop (drawer).
	let agentIds = $state<Set<string>>(new Set());
	// ADR-014 D1 — parallel repo map so routing refuses repo-less coding agents.
	let agentRepos = $state<Map<string, string | undefined>>(new Map());
	let dispatchMode = $state<'test' | 'production'>('test');
	let dispatching = $state(false);
	let dispatchOutput = $state('');
	let dispatchError = $state('');
	let dispatchDoneNote = $state<string | null>(null);
	let mutationError = $state('');

	// projects-graph ADR-024 D2 — "Send back to AI" iterate loop state.
	// The affordance lives inside the D1 review card; it collapses until
	// the operator clicks "↩ Send back to AI…".
	let sendBackExpanded = $state(false);
	let sendBackFeedback = $state('');
	let sendingBack = $state(false);
	let sendBackError = $state('');

	// projects-graph ADR-024 D1 / ADR-028 — parsed soul-hub-implementer hand-back.
	// Populated after a coding dispatch completes; drives the code-review card
	// and the D3 ship gate. Cleared on each new load or re-dispatch.
	// Type is the shared ParsedHandback from $lib/agents/handback.js (ADR-028).
	let implementerReturn = $state<ParsedHandback | null>(null);
	let implementerSessionId = $state<string | null>(null);
	let implementerParseError = $state<string | null>(null);

	// projects-graph ADR-024 D4 — blocker status cache.
	// Keyed by resolved vault path; value is the blocker's status string or
	// null if unreachable. Undefined (key missing) means "not yet fetched".
	let blockerStatuses = $state<Record<string, string | null>>({});

	// projects-graph ADR-025 D5 — auto-dispatch guard: tracks whether we have
	// already fired dispatchToAI() for the current open+autoDispatch=true cycle.
	// Reset to false in load() so each new open can trigger exactly once.
	let autoDispatched = $state(false);

	const status = $derived(note ? String(note.meta.status ?? '').toLowerCase() : '');
	const isProposed = $derived(status === 'proposed');
	const isAccepted = $derived(status === 'accepted');
	// projects-graph ADR-017 P2 — the drawer is type-agnostic on read, but the
	// lifecycle action strip (accept/park/ship via /api/vault/decisions/transition)
	// is decision-only until P3 generalises it. Gate the strip on this.
	const noteType = $derived(note ? String(note.meta.type ?? '').toLowerCase() : '');
	const isDecision = $derived(noteType === 'decision');
	// projects-graph ADR-017 P3 — the canonical-6 lifecycle action strip applies
	// to any artifact whose type the transition endpoint accepts (shared vocab).
	const TRANSITIONABLE = ['decision', 'task', 'risk', 'metric', 'post'];
	const isTransitionable = $derived(TRANSITIONABLE.includes(noteType));

	/** Project this note lives in — `projects/<project>/...` → `<project>`,
	 *  for any other zone returns the zone name (`knowledge`, `inbox`, etc.). */
	const ownProject = $derived(note ? extractProject(note.path) : '');

	/** Outgoing wikilinks grouped by their target project, EXCLUDING this
	 *  note's own project. The within-project ones are visible inline in the
	 *  rendered body, so they don't need a panel. */
	const outgoingByOtherProject = $derived.by(() => {
		const map = new Map<string, string[]>();
		if (!note?.links) return map;
		for (const link of note.links) {
			if (!link.resolved || link.embed) continue;
			const proj = extractProject(link.resolved);
			if (!proj || proj === ownProject) continue;
			const arr = map.get(proj) ?? [];
			arr.push(link.resolved);
			map.set(proj, arr);
		}
		return map;
	});

	/** Incoming wikilinks (backlinks) grouped by their source project. We show
	 *  ALL groups (other projects AND own) because backlinks aren't visible
	 *  in the body — they're inherently a separate read. Other-project bins
	 *  render first, then own-project. */
	const incomingByProject = $derived.by(() => {
		const map = new Map<string, string[]>();
		if (!note?.backlinks) return map;
		for (const path of note.backlinks) {
			const proj = extractProject(path);
			if (!proj) continue;
			const arr = map.get(proj) ?? [];
			arr.push(path);
			map.set(proj, arr);
		}
		return map;
	});

	const sortedIncomingProjects = $derived.by(() => {
		const others: string[] = [];
		const own: string[] = [];
		for (const proj of incomingByProject.keys()) {
			if (proj === ownProject) own.push(proj);
			else others.push(proj);
		}
		others.sort();
		return [...others, ...own];
	});

	const hasCrossProjectLinks = $derived(
		outgoingByOtherProject.size > 0 ||
			Array.from(incomingByProject.keys()).some((p) => p !== ownProject),
	);

	function extractProject(path: string): string {
		const parts = path.split('/');
		// `projects/<slug>/...` (3+ parts) → real project. `projects/index.md`
		// (zone-root) and other zones (`knowledge/`, `inbox/`, etc.) get the
		// zone name so they bin together rather than appearing as fake projects.
		if (parts[0] === 'projects' && parts.length >= 3) return parts[1];
		return parts[0] || '';
	}

	function shortName(path: string): string {
		return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
	}

	const created = $derived(extractDate(note?.meta.created));
	const targetDate = $derived(extractDate(note?.meta.target_date));
	const acceptedOn = $derived(extractDate(note?.meta.accepted_on));
	const shippedOn = $derived(extractDate(note?.meta.shipped_on));
	const project = $derived(typeof note?.meta.project === 'string' ? note.meta.project : '');
	const assignee = $derived(typeof note?.meta.assignee === 'string' ? note.meta.assignee : '');
	const workType = $derived(typeof note?.meta.work_type === 'string' ? note.meta.work_type : '');
	// projects-graph ADR-025 D2 — cluster signal for capability-aware routing.
	// Moved before dispatchTarget so cluster is available when the derived is evaluated.
	const tags = $derived(extractStringArray(note?.meta.tags));
	const cluster = $derived(clusterFromTags(tags));
	// projects-graph ADR-018 S2 — which agent (if any) can run this artifact.
	// projects-graph ADR-025 D2 — passes cluster so soul-hub coding work routes to
	// soul-hub-implementer instead of developer when the agent is in the roster.
	// ADR-014 D1 — passes agentRepos so repo-less coding candidates are refused.
	const dispatchTarget = $derived(resolveAgentForWork(workType, assignee, agentIds, cluster, agentRepos));
	const canDispatch = $derived(!!dispatchTarget && isTransitionable && status !== 'shipped');
	// projects-graph ADR-024 D1 — implementation dispatches (coding work, or the
	// soul-hub-implementer) MUST run in production mode: the `test` caps
	// (60s / 5 turns / $0.10) cannot implement an ADR. Pin them to production
	// regardless of the toggle; clerical work keeps the test/production choice.
	const isImplementationDispatch = $derived(
		dispatchTarget === 'soul-hub-implementer' || workType === 'coding',
	);
	// ADR-012 P3 — the artifact's implementation surface. A non-soul-hub surface
	// (e.g. `~/.claude/agents`) means the default worktree dispatch is NOT where
	// this work lands; surface a warning so the operator routes deliberately.
	const surface = $derived(classifySurface(note?.meta ?? {}));
	const surfaceOutOfWorktree = $derived(
		isImplementationDispatch && surface.kind !== 'soul-hub',
	);
	// projects-graph ADR-024 D1 / ADR-028 — all implementer gates green (drives D3).
	// Delegates to the shared handbackGatesGreen from $lib/agents/handback.js so
	// the definition of "green" is identical across drawer, worklist, and ship-merge.
	const implementerGatesGreen = $derived(
		implementerReturn !== null && handbackGatesGreen(implementerReturn),
	);
	// projects-graph ADR-024 D3 — coding dispatch with a parsed red hand-back
	// gates the Ship button (operator can only Send-back or Reject until green).
	const shipGatedByCodeReview = $derived(
		isImplementationDispatch && implementerReturn !== null && !implementerGatesGreen,
	);
	const falsifierDate = $derived(
		extractDate(note?.meta.falsifier_date) ?? extractDate(note?.meta.falsifierDate),
	);

	function extractDate(raw: unknown): string | null {
		if (typeof raw === 'string') return raw.trim() || null;
		if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
			return raw.toISOString().slice(0, 10);
		}
		// Vault API serializes Date through JSON, so it arrives as ISO string —
		// but the JSON parse can also surface it as the original value if it
		// was already a string. Handled above.
		return null;
	}

	function extractStringArray(raw: unknown): string[] {
		if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
		if (typeof raw === 'string') return [raw];
		return [];
	}

	// projects-graph ADR-024 D4 — true when this edge targets a different project.
	function isEdgeExternal(edge: DepEdge): boolean {
		return extractProject(edge.resolved) !== ownProject;
	}

	// projects-graph ADR-024 D4 — fire background status fetches for all
	// upstream blockers (including cross-project). Called after `note` loads.
	function loadBlockerStatuses() {
		const edges = upstreamEdges; // read derived after note is set
		for (const edge of edges) {
			const resolved = edge.resolved;
			fetch(`/api/vault/notes/${resolved}`)
				.then(async (r) => {
					if (!r.ok) {
						blockerStatuses[resolved] = null;
						return;
					}
					const data = (await r.json()) as { meta?: { status?: unknown } };
					const s = typeof data?.meta?.status === 'string' ? data.meta.status : null;
					blockerStatuses[resolved] = s;
				})
				.catch(() => {
					blockerStatuses[resolved] = null;
				});
		}
	}

	/** Phase 3b — parse `"[[slug]]"` or `"[[path/to/note]]"` wikilink values out
	 *  of a frontmatter relationship array. Tolerates either string or
	 *  string[] shape and strips the `|alias` suffix. Non-wikilink strings
	 *  are dropped — governance enforces the wikilink format. */
	function parseWikilinks(raw: unknown): string[] {
		const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
		const out: string[] = [];
		for (const item of arr) {
			if (typeof item !== 'string') continue;
			const m = item.match(/^\s*\[\[(.+?)(?:\|.+?)?\]\]\s*$/);
			if (m) out.push(m[1].trim());
		}
		return out;
	}

	/** Resolve a frontmatter wikilink target to a vault-relative file path.
	 *  - Slug form (`adr-018-author-agent`) → same directory as `fromPath`.
	 *  - Path form (`../soul-hub-whatsapp/adr-019-vault-git-migration`) →
	 *    resolved relative to `fromPath`'s directory, with `..` segments collapsed. */
	function resolveRelLink(raw: string, fromPath: string): string {
		const fromDir = fromPath.split('/').slice(0, -1);
		if (!raw.includes('/')) {
			return [...fromDir, `${raw}.md`].join('/');
		}
		const segments = raw.split('/');
		const out = [...fromDir];
		for (const seg of segments) {
			if (seg === '..') out.pop();
			else if (seg === '.' || seg === '') continue;
			else out.push(seg);
		}
		let resolved = out.join('/');
		if (!/\.md$/.test(resolved)) resolved += '.md';
		return resolved;
	}

	interface DepEdge {
		label: string;
		raw: string;
		resolved: string;
	}

	function collectEdges(fields: [string, string][]): DepEdge[] {
		if (!note) return [];
		const items: DepEdge[] = [];
		for (const [field, label] of fields) {
			for (const raw of parseWikilinks(note.meta[field])) {
				// Prefer the engine's authoritative resolution (global slug/alias
				// index — handles cross-project bare slugs). Fall back to the naive
				// directory-relative resolve only when the API didn't supply one
				// (older payloads) or it couldn't resolve (null → leave a best-effort
				// guess so the edge still renders a name rather than vanishing).
				const fromApi = note.depResolved?.[raw];
				const resolved = fromApi ?? resolveRelLink(raw, note.path);
				items.push({ label, raw, resolved });
			}
		}
		return items;
	}

	// Upstream — this ADR depends on / replaced these
	const upstreamEdges = $derived(
		collectEdges([
			['blocked_by', 'blocked by'],
			['extends', 'extends'],
			['supersedes', 'supersedes'],
		]),
	);

	// Downstream — these depend on / replaced this
	const downstreamEdges = $derived(
		collectEdges([
			['blocks', 'blocks'],
			['superseded_by', 'superseded by'],
		]),
	);

	const relatedEdges = $derived(collectEdges([['relates_to', 'relates to']]));

	const hasDependencies = $derived(
		upstreamEdges.length + downstreamEdges.length + relatedEdges.length > 0,
	);

	async function load(p: string) {
		loading = true;
		error = '';
		note = null;
		// Reset D1/D2/D3 code-review state and D4 blocker cache on each new load.
		implementerReturn = null;
		implementerSessionId = null;
		implementerParseError = null;
		blockerStatuses = {};
		// ADR-027 — reset ship-merge error on each note navigation.
		shipMergeError = '';
		// projects-graph ADR-025 D5 — reset auto-dispatch guard for each new note.
		autoDispatched = false;
		sendBackExpanded = false;
		sendBackFeedback = '';
		sendBackError = '';
		try {
			const res = await fetch(`/api/vault/notes/${p}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			note = await res.json();
			// D4: fire background fetches for blocker statuses (non-blocking).
			loadBlockerStatuses();
			// ADR-026 D3 (drawer hydration) — if a PAST dispatch left an un-merged
			// branch + hand-back, re-show the review card + Ship/Send-back. Skip
			// when autoDispatch is set: a fresh dispatch will populate the card and
			// would otherwise reset what we hydrate (avoids a flash).
			if (!autoDispatch) hydrateReviewCard(p);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load note';
		} finally {
			loading = false;
		}
	}

	/** ADR-026 D3 (drawer hydration) — best-effort: pull the latest completed,
	 *  un-merged dispatch for this subject and pre-fill the ADR-024 review card
	 *  (`implementerReturn` + session id) so Ship / Send-back render WITHOUT a
	 *  live dispatch stream. The endpoint already gates on branch liveness +
	 *  success status, so a non-implementation note simply gets `available:false`. */
	async function hydrateReviewCard(p: string) {
		// Don't bother for already-closed lifecycle states — nothing to ship.
		const st = String(note?.meta.status ?? '').toLowerCase();
		if (['shipped', 'rejected', 'parked', 'superseded'].includes(st)) return;
		try {
			const res = await fetch(`/api/agents/review-handoff?subject=${encodeURIComponent(p)}`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				available: boolean;
				sessionId?: string | null;
				handbackRaw?: string | null;
			};
			if (!data.available) return;
			// Race guard: the await may have outlived this open. Only hydrate the
			// still-open, not-dispatching, not-already-populated card for THIS path.
			if (currentPath !== p || dispatching || implementerReturn !== null) return;
			const parsed = data.handbackRaw ? parseHandback(data.handbackRaw) : null;
			if (parsed) {
				implementerReturn = parsed;
				implementerSessionId = data.sessionId ?? null;
				implementerParseError = null;
			}
		} catch {
			// best-effort — on failure the card just won't pre-fill (live dispatch still works)
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && path) onClose();
	}

	onMount(() => {
		loadAgentIds();
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	// When the parent changes the prop (open/close or jump to a new note),
	// reset internal navigation to follow.
	$effect(() => {
		const p = path;
		untrack(() => {
			currentPath = p;
		});
	});

	// Whenever currentPath changes (parent OR internal cross-project click),
	// fetch the corresponding note.
	$effect(() => {
		const p = currentPath;
		untrack(() => {
			if (p) load(p);
			else { note = null; error = ''; }
		});
	});

	// projects-graph ADR-025 D5 — fire dispatchToAI() exactly once when the
	// parent opens the drawer with autoDispatch=true after an Accept → AI confirm.
	// Guard: note loaded + canDispatch + not already dispatched + not mid-flight.
	$effect(() => {
		if (autoDispatch && canDispatch && !autoDispatched && !dispatching && note) {
			autoDispatched = true;
			dispatchToAI();
		}
	});

	function handleTransition(info: { path: string; action: DrawerAction; newStatus: string }) {
		onTransition?.(info);
		// Close after a successful transition — the row in the parent list
		// will update or vanish, so keeping the drawer open shows stale data.
		onClose();
	}

	async function shipDecision() {
		if (!note || shipping) return;
		shipping = true;
		mutationError = '';
		try {
			const res = await fetch('/api/vault/decisions/transition', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: note.path, action: 'ship' }),
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				mutationError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			handleTransition({ path: note.path, action: 'ship', newStatus: data.newStatus });
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Network error';
		} finally {
			shipping = false;
		}
	}

	/**
	 * projects-graph ADR-027 P1 — "Ship & merge": merges the implementer's
	 * orchestration branch to main then flips the ADR status to `shipped`.
	 * All guards run server-side; this function only drives UI state.
	 */
	async function shipAndMerge() {
		if (!note || shippingAndMerging) return;
		shippingAndMerging = true;
		shipMergeError = '';
		mutationError = '';
		try {
			const res = await fetch('/api/agents/ship-merge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: note.path }),
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				shipMergeError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			handleTransition({ path: note.path, action: 'ship', newStatus: data.newStatus });
		} catch (e) {
			shipMergeError = e instanceof Error ? e.message : 'Network error';
		} finally {
			shippingAndMerging = false;
		}
	}

	async function saveTargetDate() {
		if (!note || savingTarget) return;
		const value = targetDateInput.trim();
		if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			mutationError = 'Date must be YYYY-MM-DD';
			return;
		}
		savingTarget = true;
		mutationError = '';
		try {
			// Patch only the target_date field. Empty string clears it.
			const meta: Record<string, unknown> = { ...note.meta, target_date: value || null };
			if (!value) delete meta.target_date;
			const res = await fetch(`/api/vault/notes/${note.path}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta }),
			});
			const data = await res.json();
			if (!res.ok || data.success === false) {
				mutationError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			editingTarget = false;
			// Refresh the note so the chip reflects the new value.
			await load(note.path);
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Network error';
		} finally {
			savingTarget = false;
		}
	}

	function startEditingTarget() {
		targetDateInput = targetDate ?? '';
		editingTarget = true;
		mutationError = '';
	}

	// projects-graph ADR-017 P3 — set/clear the assignee. Mirrors saveTargetDate:
	// patch one frontmatter field through the notes endpoint (chokepoint-validated),
	// then reload so the chip reflects the new owner.
	async function saveAssignee() {
		if (!note || savingAssignee) return;
		const value = assigneeInput.trim();
		savingAssignee = true;
		mutationError = '';
		try {
			const meta: Record<string, unknown> = { ...note.meta, assignee: value || null };
			if (!value) delete meta.assignee;
			const res = await fetch(`/api/vault/notes/${note.path}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta }),
			});
			const data = await res.json();
			if (!res.ok || data.success === false) {
				mutationError = data.error ?? `HTTP ${res.status}`;
				return;
			}
			editingAssignee = false;
			await load(note.path);
		} catch (e) {
			mutationError = e instanceof Error ? e.message : 'Network error';
		} finally {
			savingAssignee = false;
		}
	}

	function startEditingAssignee() {
		assigneeInput = assignee ?? '';
		editingAssignee = true;
		mutationError = '';
	}

	// projects-graph ADR-018 S2 — load the roster once so resolveAgentForWork
	// can validate an assignee-as-agent and the work_type→agent map.
	// ADR-014 D1 — also captures repo per agent so routing can refuse repo-less
	// coding candidates (avoids unisolated run; matches D1 in dispatch-routing.ts).
	async function loadAgentIds() {
		if (agentIds.size > 0) return;
		try {
			const res = await fetch('/api/agents');
			if (!res.ok) return;
			const data = await res.json();
			const list = Array.isArray(data) ? data : (data.agents ?? data.results ?? []);
			const newIds = new Set<string>();
			const newRepos = new Map<string, string | undefined>();
			for (const a of list as Array<{ id?: string; repo?: string }>) {
				const id = (a.id ?? '').toLowerCase();
				if (!id) continue;
				newIds.add(id);
				newRepos.set(
					id,
					typeof a.repo === 'string' && a.repo.trim() ? a.repo.trim() : undefined,
				);
			}
			agentIds = newIds;
			agentRepos = newRepos;
		} catch {
			/* roster unavailable — Dispatch button simply won't show */
		}
	}

	/** Dispatch the artifact to its resolved agent. Streams the NDJSON run,
	 *  shows live output, and on completion writes the agent's output back as a
	 *  linked `output` note + stamps `assignee`. Does NOT flip status — the
	 *  human reviews the output note and ships via the action strip (operator
	 *  decision 2026-05-21). */
	async function dispatchToAI() {
		if (!note || dispatching || !dispatchTarget) return;
		dispatching = true;
		dispatchOutput = '';
		dispatchError = '';
		dispatchDoneNote = null;
		// D1/D2 — reset code-review card + iterate state on each new dispatch.
		implementerReturn = null;
		implementerSessionId = null;
		implementerParseError = null;
		sendBackExpanded = false;
		sendBackFeedback = '';
		sendBackError = '';
		const agent = dispatchTarget;
		const artifactPath = note.path;
		const artifactSlug = artifactPath.split('/').pop()?.replace(/\.md$/i, '') ?? artifactPath;
		const proj = project;
		// ADR-024 D1 — implementation work overrides the toggle to production.
		const effectiveMode = isImplementationDispatch ? 'production' : dispatchMode;
		try {
			// Stamp ownership first so the lane + chip reflect the dispatch.
			if (assignee !== agent) {
				await fetch(`/api/vault/notes/${artifactPath}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ meta: { ...note.meta, assignee: agent } }),
				});
			}

			const task =
				`Work on this ${noteType}: "${note.title}".\n\n` +
				`${note.content ?? ''}\n\n` +
				`Produce the deliverable and return it as your final output.`;

			const res = await fetch(`/api/agents/${agent}/test?mode=${effectiveMode}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// ADR-014 D2 — pass work_type so the server guard can refuse repo-less
				// coding dispatches even when reached via direct API or CLI (belt-and-suspenders).
				body: JSON.stringify({ task: task.slice(0, 4000), subject: artifactPath, work_type: workType }),
			});
			if (!res.ok || !res.body) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
			}

			// Consume the NDJSON stream.
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			let finalOutput = '';
			let runId = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					let ev: Record<string, unknown>;
					try { ev = JSON.parse(line); } catch { continue; }
					if (ev.type === 'started' && typeof ev.runId === 'string') {
						runId = ev.runId;
					} else if (ev.type === 'output' && typeof ev.data === 'string') {
						dispatchOutput += ev.data;
					} else if (ev.type === 'error') {
						dispatchError = String(ev.message ?? 'dispatch error');
					} else if (ev.type === 'done') {
						// ADR-024 D1 — capture the full DispatchResult so we can extract
						// claude_session_id for a future --resume loop (D2).
						const result = ev.result as {
							output?: string;
							claude_session_id?: string;
						} | undefined;
						finalOutput = result?.output ?? dispatchOutput;
						if (result?.claude_session_id) {
							implementerSessionId = result.claude_session_id;
						}
					}
				}
			}
			if (dispatchError) return;

			const body = finalOutput.trim() || dispatchOutput.trim();
			if (!body) {
				dispatchError = 'Agent returned no output.';
				return;
			}

			// projects-graph ADR-024 D1 — for coding dispatches, parse the
			// soul-hub-implementer hand-back JSON out of the agent's output.
			// Drives the code-review card and the D3 ship gate.
			if (isImplementationDispatch) {
				const parsed = parseHandback(body);
				if (parsed) {
					implementerReturn = parsed;
					implementerParseError = null;
				} else {
					implementerReturn = null;
					implementerParseError =
						'Could not parse implementer hand-back JSON — review the raw output note.';
				}
			}

			// Write the deliverable back as a linked output note (review-then-ship).
			const stamp = new Date().toISOString().slice(0, 10);
			const filename = `${artifactSlug}-output-${stamp}.md`;
			// Conform to the `output` template (ADR-009): ## Pipeline Context + ## Output.
			const noteContent =
				`# Output — ${note.title}\n\n` +
				`## Pipeline Context\n\n` +
				`- **Source artifact**: [[${artifactSlug}]]\n` +
				`- **Agent**: ${agent}\n` +
				`- **Run ID**: ${runId || '(n/a)'}\n` +
				`- **Mode**: ${effectiveMode}\n` +
				`- **Date**: ${stamp}\n\n` +
				`> AI-generated. Review before shipping the source artifact.\n\n` +
				`## Output\n\n` +
				body;
			const writeRes = await fetch('/api/vault/notes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					zone: `projects/${proj}`,
					filename,
					meta: {
						type: 'output',
						created: stamp,
						tags: [proj, 'ai-output'],
						project: proj,
						assignee: agent,
						pipeline: 'ai-dispatch',
						run_id: runId || null,
						step: agent,
						relates_to: [`[[${artifactSlug}]]`],
					},
					content: noteContent,
				}),
			});
			const writeData = await writeRes.json();
			if (!writeRes.ok || writeData.success === false) {
				dispatchError = `Output written failed: ${writeData.error ?? writeRes.status}`;
				return;
			}
			dispatchDoneNote = `projects/${proj}/${filename}`;
			await load(artifactPath); // refresh assignee chip
		} catch (e) {
			dispatchError = e instanceof Error ? e.message : 'Dispatch failed';
		} finally {
			dispatching = false;
		}
	}

	/**
	 * ADR-024 D2 — Re-dispatch on the SAME branch + session.
	 *
	 * Posts `{ task: feedback, subject, resume: sessionId, branch }` to the test
	 * endpoint in production mode.  `dispatching` stays `true` throughout so the
	 * live-output `<pre>` block keeps rendering (artifact in flight per spec).
	 * On completion the hand-back is re-parsed and `implementerReturn` is updated
	 * in place — the review card refreshes without a new note navigation.
	 */
	async function sendBackToAI() {
		if (!note || sendingBack || !implementerSessionId || !implementerReturn || !dispatchTarget) return;
		const feedback = sendBackFeedback.trim();
		if (!feedback) {
			sendBackError = 'Enter feedback for the AI before sending.';
			return;
		}

		// Capture before clearing (implementerReturn is reset below).
		const sessionId = implementerSessionId;
		const branch = implementerReturn.branch;
		const agent = dispatchTarget;
		const artifactPath = note.path;
		const artifactSlug = artifactPath.split('/').pop()?.replace(/\.md$/i, '') ?? artifactPath;
		const proj = project;

		sendingBack = true;
		dispatching = true;
		sendBackError = '';
		dispatchOutput = '';
		dispatchError = '';
		dispatchDoneNote = null;
		sendBackExpanded = false;
		sendBackFeedback = '';
		// Reset review card — will be repopulated when the resume completes.
		implementerReturn = null;
		implementerSessionId = null;
		implementerParseError = null;

		try {
			const res = await fetch(`/api/agents/${agent}/test?mode=production`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: feedback.slice(0, 4000),
					subject: artifactPath,
					resume: sessionId,
					branch,
				}),
			});
			if (!res.ok || !res.body) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
			}

			// Consume NDJSON stream — identical to dispatchToAI's stream loop.
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			let finalOutput = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					let ev: Record<string, unknown>;
					try { ev = JSON.parse(line); } catch { continue; }
					if (ev.type === 'output' && typeof ev.data === 'string') {
						dispatchOutput += ev.data;
					} else if (ev.type === 'error') {
						dispatchError = String(ev.message ?? 'dispatch error');
					} else if (ev.type === 'done') {
						const result = ev.result as { output?: string; claude_session_id?: string } | undefined;
						finalOutput = result?.output ?? dispatchOutput;
						if (result?.claude_session_id) {
							// Preserve session id for a future iteration.
							implementerSessionId = result.claude_session_id;
						}
					}
				}
			}
			if (dispatchError) return;

			const body = finalOutput.trim() || dispatchOutput.trim();
			if (!body) {
				dispatchError = 'Agent returned no output.';
				return;
			}

			// Re-parse the updated hand-back → review card refreshes in place.
			const parsed = parseHandback(body);
			if (parsed) {
				implementerReturn = parsed;
				implementerParseError = null;
			} else {
				implementerReturn = null;
				implementerParseError =
					'Could not parse implementer hand-back JSON — review the raw output note.';
			}

			// Write the iterate output note (audit trail).
			const stamp = new Date().toISOString().slice(0, 10);
			const filename = `${artifactSlug}-output-${stamp}-iterate.md`;
			const noteContent =
				`# Output (iterate) — ${note.title}\n\n` +
				`## Pipeline Context\n\n` +
				`- **Source artifact**: [[${artifactSlug}]]\n` +
				`- **Agent**: ${agent}\n` +
				`- **Branch**: \`${branch}\`\n` +
				`- **Mode**: production (resume)\n` +
				`- **Date**: ${stamp}\n\n` +
				`> AI-generated (resume iteration). Review before shipping the source artifact.\n\n` +
				`## Output\n\n` +
				body;
			const writeRes = await fetch('/api/vault/notes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					zone: `projects/${proj}`,
					filename,
					meta: {
						type: 'output',
						created: stamp,
						tags: [proj, 'ai-output', 'iterate'],
						project: proj,
						assignee: agent,
						pipeline: 'ai-dispatch-resume',
						relates_to: [`[[${artifactSlug}]]`],
					},
					content: noteContent,
				}),
			});
			const writeData = await writeRes.json();
			if (!writeRes.ok || writeData.success === false) {
				dispatchError = `Output write failed: ${writeData.error ?? writeRes.status}`;
				return;
			}
			dispatchDoneNote = `projects/${proj}/${filename}`;
		} catch (e) {
			dispatchError = e instanceof Error ? e.message : 'Send back failed';
		} finally {
			sendingBack = false;
			dispatching = false;
		}
	}
</script>

{#if path}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 bg-black/50 z-40 transition-opacity"
		onclick={onClose}
		role="presentation"
	></div>

	<!-- Drawer -->
	<aside
		class="fixed top-0 right-0 bottom-0 w-full sm:w-[640px] lg:w-[760px] bg-hub-bg border-l border-hub-border z-50 flex flex-col shadow-2xl"
		role="dialog"
		aria-label={noteType ? `${noteType} viewer` : 'Artifact viewer'}
	>
		<header class="flex-shrink-0 px-5 py-3 border-b border-hub-border flex items-center justify-between">
			<div class="min-w-0 flex-1">
				{#if note}
					<h2 class="text-sm font-semibold text-hub-text truncate">{note.title}</h2>
					<p class="text-[11px] text-hub-dim font-mono truncate">{note.path}</p>
				{:else if loading}
					<p class="text-sm text-hub-muted">Loading…</p>
				{:else}
					<p class="text-sm text-hub-muted">{path}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2 flex-shrink-0 ml-3">
				{#if note}
					<a
						href="/vault?path={encodeURIComponent(note.path)}"
						class="text-[11px] text-hub-dim hover:text-hub-text transition-colors"
						title="Open in vault"
					>
						Open in vault →
					</a>
				{/if}
				<button
					onclick={onClose}
					class="p-1.5 rounded-md hover:bg-hub-card text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
					aria-label="Close"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			</div>
		</header>

		<div class="flex-1 overflow-y-auto px-5 py-5">
			{#if loading && !note}
				<div class="flex items-center justify-center py-20">
					<p class="text-hub-muted text-sm">Loading…</p>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{:else if note}
				<!-- Frontmatter chips -->
				<div class="flex flex-wrap items-center gap-2 mb-4 text-[11px]">
					{#if noteType}
						<span class="px-2 py-0.5 rounded font-mono uppercase tracking-wider bg-hub-card text-hub-dim">{noteType}</span>
					{/if}
					{#if status}
						<span
							class="px-2 py-0.5 rounded font-medium"
							class:bg-hub-warning={status === 'proposed'}
							class:text-hub-bg={status === 'proposed'}
							class:bg-hub-info={status === 'accepted'}
							class:text-white={status === 'accepted' || status === 'shipped' || status === 'rejected'}
							class:bg-hub-cta={status === 'shipped'}
							class:bg-hub-danger={status === 'rejected'}
							class:bg-hub-dim={status === 'parked'}
							class:bg-hub-muted={status === 'superseded'}
							class:line-through={status === 'superseded'}
						>
							{status}
						</span>
					{/if}
					{#if project}
						<a href="/projects/{project}" class="px-2 py-0.5 rounded bg-hub-card text-hub-info hover:text-hub-text transition-colors">
							{project}
						</a>
					{/if}
					<!-- projects-graph ADR-017 P3 — assignee (ownership). Click to edit. -->
					{#if editingAssignee}
						<span class="inline-flex items-center gap-1">
							<input
								class="px-1.5 py-0.5 rounded bg-hub-card border border-hub-border text-hub-text text-[11px] w-32"
								placeholder="name or agent slug"
								bind:value={assigneeInput}
								onkeydown={(e) => { if (e.key === 'Enter') saveAssignee(); if (e.key === 'Escape') editingAssignee = false; }}
								disabled={savingAssignee}
							/>
							<button class="px-1.5 py-0.5 rounded bg-hub-cta/15 text-hub-cta text-[11px] cursor-pointer disabled:opacity-50" onclick={saveAssignee} disabled={savingAssignee}>{savingAssignee ? '…' : 'Save'}</button>
							<button class="px-1.5 py-0.5 rounded text-hub-dim text-[11px] cursor-pointer" onclick={() => (editingAssignee = false)}>Cancel</button>
						</span>
					{:else}
						<button
							class="px-2 py-0.5 rounded bg-hub-card text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
							onclick={startEditingAssignee}
							title="Set who owns this artifact (human name or agent slug)"
						>
							{assignee ? `@ ${assignee}` : '+ assign'}
						</button>
					{/if}
					{#if created}
						<span class="text-hub-dim">created {created}</span>
					{/if}
					{#if acceptedOn}
						<span class="text-hub-info">accepted {acceptedOn}</span>
					{/if}
					{#if shippedOn}
						<span class="text-hub-cta">shipped {shippedOn}</span>
					{/if}
					{#if targetDate && isProposed}
						<span class="text-hub-warning">target {targetDate}</span>
					{/if}
					{#if falsifierDate}
						<span class="text-hub-warning">⏱ {falsifierDate}</span>
					{/if}
					{#each tags.slice(0, 6) as tag}
						<span class="px-1.5 py-0.5 rounded bg-hub-card/60 text-hub-dim">{tag}</span>
					{/each}
				</div>

				<!-- Action strip for proposed artifacts (P3: any transitionable type, shared canonical-6 vocab) -->
				{#if isProposed && isTransitionable}
					<div class="mb-5 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="flex items-center justify-between gap-3 mb-1">
							<p class="text-xs text-hub-warning">{isDecision ? 'Awaiting decision' : 'Awaiting triage'}</p>
							<DecisionActions
							path={note.path}
							size="sm"
							onTransition={handleTransition}
							work_type={workType}
							assignee={assignee}
							tags={tags}
							agentIds={agentIds}
							onDispatch={onDispatch}
						/>
						</div>

						<!-- Target date editor — drives the planned-Gantt view (Phase 3a) -->
						<div class="mt-3 pt-3 border-t border-hub-warning/20 flex items-center gap-2 text-[11px]">
							<span class="text-hub-dim">Target ship date:</span>
							{#if editingTarget}
								<input
									bind:value={targetDateInput}
									type="text"
									placeholder="YYYY-MM-DD"
									pattern="\d{'{4}'}-\d{'{2}'}-\d{'{2}'}"
									class="bg-transparent border border-hub-border rounded px-2 py-0.5 text-[11px] text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors w-32"
								/>
								<button
									onclick={saveTargetDate}
									disabled={savingTarget}
									class="px-2 py-0.5 rounded font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
								>
									{savingTarget ? '…' : 'Save'}
								</button>
								<button
									onclick={() => { editingTarget = false; mutationError = ''; }}
									class="px-2 py-0.5 rounded text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
								>
									Cancel
								</button>
							{:else}
								<span class={targetDate ? 'text-hub-text font-medium' : 'text-hub-dim italic'}>
									{targetDate ?? 'not set'}
								</span>
								<button
									onclick={startEditingTarget}
									class="text-hub-info hover:text-hub-text transition-colors cursor-pointer"
								>
									{targetDate ? 'Update' : 'Set'}
								</button>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Ship controls for accepted artifacts (P3: any transitionable type).
				     projects-graph ADR-024 D3 — gated on implementer gates when
				     this is a coding artifact with a parsed hand-back.
				     projects-graph ADR-027 P1 — button matrix:
				       coding + green  → Ship & merge (primary) + Mark shipped (secondary)
				       coding + red    → disabled (existing shipGatedByCodeReview guard)
				       non-coding / no hand-back → Mark shipped (unchanged) -->
				{#if isAccepted && isTransitionable}
					{#if shipGatedByCodeReview}
						<!-- Red gates: ship disabled until gates pass -->
						<div class="mb-5 p-3 rounded-lg border border-hub-danger/30 bg-hub-danger/5 flex items-center justify-between gap-3">
							<div>
								<p class="text-xs text-hub-danger font-medium">⛔ Ship disabled — code review gates are red</p>
								<p class="text-[11px] text-hub-dim mt-0.5">Fix the failing gates and re-dispatch before shipping.</p>
							</div>
							<button
								onclick={shipDecision}
								disabled={true}
								title="Code review gates must be green before shipping"
								class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg transition-colors cursor-not-allowed opacity-50 flex-shrink-0"
							>
								Mark shipped
							</button>
						</div>
					{:else if isImplementationDispatch && implementerGatesGreen}
						<!-- ADR-027: coding artifact with green gates → Ship & merge primary -->
						<div class="mb-5 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5">
							<div class="mb-2">
								<p class="text-xs text-hub-info">Decision accepted{acceptedOn ? ` on ${acceptedOn}` : ''}</p>
								<p class="text-[11px] text-hub-dim mt-0.5">
									✓ Code review gates green. Merges the branch to main + marks shipped. Does not deploy — build &amp; reload separately.
								</p>
							</div>
							<div class="flex items-center gap-2 flex-wrap">
								<button
									onclick={shipAndMerge}
									disabled={shippingAndMerging || shipping}
									class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
								>
									{shippingAndMerging ? '⏳ merging…' : '⇡ Ship & merge'}
								</button>
								<button
									onclick={shipDecision}
									disabled={shipping || shippingAndMerging}
									title="Marks status as shipped without merging the branch — for multi-phase ADRs or already-merged branches"
									class="px-3 py-1.5 rounded text-xs font-medium bg-hub-card text-hub-dim hover:text-hub-text border border-hub-border/60 transition-colors cursor-pointer disabled:opacity-50"
								>
									{shipping ? '…' : 'Mark shipped (status only)'}
								</button>
							</div>
							{#if shipMergeError}
								<p class="mt-2 text-[11px] text-hub-danger">{shipMergeError}</p>
							{/if}
						</div>
					{:else}
						<!-- Non-coding or no hand-back: unchanged Mark shipped -->
						<div class="mb-5 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5 flex items-center justify-between gap-3">
							<div>
								<p class="text-xs text-hub-info">Decision accepted{acceptedOn ? ` on ${acceptedOn}` : ''}</p>
								<p class="text-[11px] text-hub-dim mt-0.5">
									Mark as shipped when all planned phases are live.
								</p>
							</div>
							<button
								onclick={shipDecision}
								disabled={shipping}
								class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
							>
								{shipping ? '…' : 'Mark shipped'}
							</button>
						</div>
					{/if}
				{/if}

				<!-- projects-graph ADR-018 S2 / ADR-025 D5 — Dispatch to AI.
				     Re-dispatch / run surface for an ALREADY-ACCEPTED artifact. A
				     *proposed* artifact is accepted-and-dispatched via the named
				     "Accept → 🤖 agent" button in the DecisionActions strip above,
				     so this standalone control is gated on `isAccepted` to avoid
				     showing two dispatch paths for one proposed ADR (D5 finding). -->
				{#if canDispatch && isAccepted}
					<div class="mb-5 p-3 rounded-lg border border-hub-cta/30 bg-hub-cta/5">
						{#if surfaceOutOfWorktree}
							<!-- ADR-012 P2/P3 — this ADR's surface is outside the soul-hub
							     worktree. The implementer's pre-flight check will STOP and
							     report (not edit live) unless explicitly authorized. -->
							<div class="mb-2 p-2 rounded border border-hub-warning/40 bg-hub-warning/5">
								<p class="text-[11px] text-hub-warning font-medium">⚠ Out-of-worktree surface: <span class="font-mono">{surface.declared}</span></p>
								<p class="text-[10px] text-hub-dim mt-0.5">
									{surface.kind === 'config-repo'
										? `This work lands in ${surface.repo}, not the soul-hub worktree. The implementer will stop + report unless the task authorizes an [OUT-OF-WORKTREE] surface — it will NOT edit global state silently.`
										: 'No known repo owns this surface. The implementer will stop + report rather than edit live; resolve the surface before dispatching.'}
								</p>
							</div>
						{/if}
						<div class="flex items-center justify-between gap-3 flex-wrap">
							<div>
								<p class="text-xs text-hub-text font-medium">Dispatch to AI</p>
								<p class="text-[11px] text-hub-dim mt-0.5">→ <span class="font-mono">{dispatchTarget}</span>{workType ? ` · ${workType}` : ''}</p>
							</div>
							<div class="flex items-center gap-1.5">
								{#if isImplementationDispatch}
									<!-- D5/D1: implementation dispatches are force-pinned to production.
									     Hide the toggle to prevent a misleading test click that would
									     actually run a ~$5–8 worktree build. -->
									<span class="text-[11px] text-hub-dim font-mono" title="ADR-024 D1 — coding dispatches always run in production mode with an isolated worktree">
										production · isolated worktree · ~$5–8
									</span>
								{:else}
									<select
										bind:value={dispatchMode}
										disabled={dispatching}
										class="px-1.5 py-1 rounded bg-hub-card border border-hub-border text-hub-text text-[11px] cursor-pointer disabled:opacity-50"
										title="test = capped $0.10 / 5 turns · run = real budget"
									>
										<option value="test">test</option>
										<option value="production">run</option>
									</select>
								{/if}
								<button
									onclick={dispatchToAI}
									disabled={dispatching}
									title={implementerReturn ? 'A completed run is awaiting your review below — this starts a fresh dispatch on a new branch' : undefined}
									class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
								>
									{dispatching ? '🟡 working…' : implementerReturn ? 'Re-dispatch' : 'Dispatch'}
								</button>
							</div>
						</div>
						{#if dispatching && dispatchOutput}
							<pre class="mt-2 max-h-40 overflow-y-auto text-[11px] text-hub-dim whitespace-pre-wrap bg-hub-bg/40 rounded p-2 border border-hub-border/50">{dispatchOutput.slice(-2000)}</pre>
						{/if}
						{#if dispatchError}
							<p class="mt-2 text-[11px] text-hub-danger">{dispatchError}</p>
						{/if}
						{#if dispatchDoneNote}
							<div class="mt-2 flex items-center gap-2 text-[11px]">
								<span class="text-hub-cta">✓ output saved</span>
								<button class="text-hub-info hover:text-hub-text underline cursor-pointer" onclick={() => dispatchDoneNote && load(dispatchDoneNote)}>review it →</button>
								{#if !isImplementationDispatch}
									<span class="text-hub-dim">then ship the artifact above.</span>
								{/if}
							</div>
						{/if}

						<!-- projects-graph ADR-024 D1 — Code Review Card.
						     Rendered after an implementation dispatch completes; shows
						     branch, files changed, gate badge. Drives the D3 ship gate. -->
						{#if implementerReturn}
							<div class="mt-3 rounded-lg border p-3 {implementerGatesGreen ? 'border-hub-cta/40 bg-hub-cta/5' : 'border-hub-danger/40 bg-hub-danger/5'}">
								<div class="flex items-center justify-between mb-2">
									<p class="text-xs font-semibold text-hub-text">Code Review</p>
									<span class="px-2 py-0.5 rounded text-[10px] font-bold {implementerGatesGreen ? 'bg-hub-cta text-hub-bg' : 'bg-hub-danger text-white'}">
										{implementerGatesGreen ? '✓ gates green' : '✗ gates red'}
									</span>
								</div>
								<p class="text-[11px] text-hub-dim font-mono truncate mb-2" title={implementerReturn.branch}>{implementerReturn.branch}</p>
								<div class="flex items-center gap-3 text-[11px] text-hub-dim mb-2">
									<span>{implementerReturn.commits.length} commit{implementerReturn.commits.length !== 1 ? 's' : ''}</span>
									<span>·</span>
									<span>{implementerReturn.files_changed.length} file{implementerReturn.files_changed.length !== 1 ? 's' : ''} changed</span>
									{#if implementerSessionId}
										<span class="ml-auto font-mono text-[10px] text-hub-dim" title="Claude session ID for --resume">{implementerSessionId.slice(0, 8)}…</span>
									{/if}
								</div>
								{#if implementerReturn.files_changed.length > 0}
									<ul class="text-[11px] font-mono text-hub-dim space-y-0.5 ml-2 mb-2">
										{#each implementerReturn.files_changed.slice(0, 8) as f}
											<li>· {f}</li>
										{/each}
										{#if implementerReturn.files_changed.length > 8}
											<li class="italic">… +{implementerReturn.files_changed.length - 8} more</li>
										{/if}
									</ul>
								{/if}
								{#if Object.keys(implementerReturn.gate_results).length > 0}
									<div class="flex flex-wrap gap-1 mb-2">
										{#each Object.entries(implementerReturn.gate_results) as [gate, result]}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {result === 'pass' ? 'bg-hub-cta/15 text-hub-cta' : 'bg-hub-danger/15 text-hub-danger'}">
												{gate}: {result}
											</span>
										{/each}
									</div>
								{/if}
								{#if implementerReturn.summary}
									<p class="text-[11px] text-hub-dim leading-relaxed mt-1">
										{implementerReturn.summary.length > 280
											? implementerReturn.summary.slice(0, 280) + '…'
											: implementerReturn.summary}
									</p>
								{/if}
								{#if implementerReturn.follow_ups.length > 0}
									<details class="mt-2">
										<summary class="text-[11px] text-hub-warning cursor-pointer select-none">
											⚠ {implementerReturn.follow_ups.length} follow-up{implementerReturn.follow_ups.length !== 1 ? 's' : ''}
										</summary>
										<ul class="mt-1 ml-2 space-y-0.5">
											{#each implementerReturn.follow_ups as item}
												<li class="text-[11px] text-hub-dim">· {item}</li>
											{/each}
										</ul>
									</details>
								{/if}

								<!-- projects-graph ADR-024 D2 — "Send back to AI" iterate loop.
								     Collapsed until clicked. Disabled when no session id (PTY
								     didn't emit one, or session was already cleared). -->
								<div class="mt-3 pt-2 border-t border-hub-border/30">
									{#if !dispatching && !sendBackExpanded}
										<button
											onclick={() => { sendBackExpanded = true; sendBackError = ''; }}
											disabled={!implementerSessionId}
											title={implementerSessionId ? 'Re-dispatch on the same branch, resuming the same Claude session' : 'No session ID — cannot resume (run completed without PTY session data)'}
											class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
										>
											↩ Send back to AI…
										</button>
									{:else if sendBackExpanded && !dispatching}
										<div class="space-y-1.5">
											<p class="text-[10px] text-hub-dim">Feedback for the implementer (will resume session <span class="font-mono">{implementerSessionId?.slice(0, 8)}…</span> on branch <span class="font-mono truncate">{implementerReturn?.branch ?? ''}</span>):</p>
											<textarea
												bind:value={sendBackFeedback}
												placeholder="E.g. 'The TypeScript check still fails on line 42 — fix the type error and re-run npm run check before returning.'"
												class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-hub-text text-[11px] placeholder:text-hub-dim resize-none focus:outline-none focus:border-hub-cta/50 transition-colors"
												rows="3"
												disabled={sendingBack}
											></textarea>
											{#if sendBackError}
												<p class="text-[10px] text-hub-danger">{sendBackError}</p>
											{/if}
											<div class="flex items-center gap-1.5">
												<button
													onclick={sendBackToAI}
													disabled={sendingBack || !sendBackFeedback.trim()}
													class="px-2.5 py-1 rounded text-[11px] font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
												>
													{sendingBack ? '🟡 sending…' : '↩ Send back'}
												</button>
												<button
													onclick={() => { sendBackExpanded = false; sendBackFeedback = ''; sendBackError = ''; }}
													disabled={sendingBack}
													class="px-2.5 py-1 rounded text-[11px] text-hub-dim hover:text-hub-text transition-colors cursor-pointer disabled:opacity-50"
												>
													Cancel
												</button>
											</div>
										</div>
									{/if}
								</div>
							</div>
						{:else if implementerParseError && !dispatching}
							<p class="mt-2 text-[11px] text-hub-warning">{implementerParseError}</p>
						{/if}
					</div>
				{/if}

				{#if mutationError}
					<div class="mb-4 px-3 py-2 rounded bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
						{mutationError}
					</div>
				{/if}

				<RenderedMarkdown html={note.rendered ?? ''} rtl={!!note.contentIsRtl} />

				<!-- Dependencies panel (Phase 3b) — surfaces typed relationship
				     fields from the frontmatter (blocks/blocked_by/extends/
				     supersedes/superseded_by/relates_to). Each item is a
				     button that swaps the drawer to that ADR, reusing the
				     in-drawer nav pattern. -->
				{#if hasDependencies}
					<div class="mt-6 pt-4 border-t border-hub-border">
						<p class="text-[11px] uppercase tracking-wider text-hub-dim mb-3">
							Dependencies
						</p>

						{#if upstreamEdges.length > 0}
							<div class="mb-3 rounded-md border border-hub-warning/30 bg-hub-warning/5 p-2">
								<div class="flex items-center gap-2 mb-1.5">
									<span class="text-[10px] uppercase tracking-wider text-hub-warning">↑</span>
									<span class="text-xs font-medium text-hub-text">This depends on</span>
									<span class="text-[10px] text-hub-dim">({upstreamEdges.length})</span>
								</div>
								<!-- projects-graph ADR-024 D4 — upstream edges with status badges.
								     Cross-project blockers (external: true in critical-path.ts)
								     are shown with a ⚠ marker if not yet shipped, ensuring the
								     operator sees the real gate rather than a silently dropped dep. -->
								<ul class="space-y-0.5 ml-4">
									{#each upstreamEdges as edge}
										{@const bStatus = blockerStatuses[edge.resolved]}
										{@const bExternal = isEdgeExternal(edge)}
										<li class="flex items-center gap-2 text-xs">
											<span class="text-[10px] uppercase tracking-wider text-hub-dim w-20 flex-shrink-0">
												{edge.label}
											</span>
											<button
												onclick={() => (currentPath = edge.resolved)}
												class="text-hub-text hover:text-hub-info font-mono text-[11px] transition-colors text-left cursor-pointer truncate min-w-0 flex-1"
												title={edge.resolved}
											>
												{shortName(edge.resolved)}
											</button>
											<!-- Status badge: loading → status pill → unknown -->
											{#if !(edge.resolved in blockerStatuses)}
												<span class="flex-shrink-0 text-[9px] text-hub-dim italic">…</span>
											{:else if bStatus !== null}
												<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium
													{bStatus === 'shipped' ? 'bg-hub-cta/15 text-hub-cta' :
													 bStatus === 'accepted' ? 'bg-hub-info/15 text-hub-info' :
													 bStatus === 'proposed' ? 'bg-hub-warning/15 text-hub-warning' :
													 'bg-hub-dim/15 text-hub-dim'}">
													{bStatus}
												</span>
											{:else}
												<span class="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-hub-dim/15 text-hub-dim">?</span>
											{/if}
											<!-- Cross-project warning when not shipped -->
											{#if bExternal && bStatus !== 'shipped'}
												<span class="flex-shrink-0 text-[10px] text-hub-warning" title="Cross-project blocker — not yet shipped">⚠</span>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/if}

						{#if downstreamEdges.length > 0}
							<div class="mb-3 rounded-md border border-hub-cta/30 bg-hub-cta/5 p-2">
								<div class="flex items-center gap-2 mb-1.5">
									<span class="text-[10px] uppercase tracking-wider text-hub-cta">↓</span>
									<span class="text-xs font-medium text-hub-text">Downstream</span>
									<span class="text-[10px] text-hub-dim">({downstreamEdges.length})</span>
								</div>
								<ul class="space-y-0.5 ml-4">
									{#each downstreamEdges as edge}
										<li class="flex items-baseline gap-2 text-xs">
											<span class="text-[10px] uppercase tracking-wider text-hub-dim w-20 flex-shrink-0">
												{edge.label}
											</span>
											<button
												onclick={() => (currentPath = edge.resolved)}
												class="text-hub-text hover:text-hub-info font-mono text-[11px] transition-colors text-left cursor-pointer truncate min-w-0 flex-1"
												title={edge.resolved}
											>
												{shortName(edge.resolved)}
											</button>
										</li>
									{/each}
								</ul>
							</div>
						{/if}

						{#if relatedEdges.length > 0}
							<div class="rounded-md border border-hub-border/60 bg-hub-card/40 p-2">
								<div class="flex items-center gap-2 mb-1.5">
									<span class="text-[10px] uppercase tracking-wider text-hub-dim">↔</span>
									<span class="text-xs font-medium text-hub-text">Related</span>
									<span class="text-[10px] text-hub-dim">({relatedEdges.length})</span>
								</div>
								<ul class="space-y-0.5 ml-4">
									{#each relatedEdges as edge}
										<li class="text-xs">
											<button
												onclick={() => (currentPath = edge.resolved)}
												class="text-hub-text hover:text-hub-info font-mono text-[11px] transition-colors text-left cursor-pointer truncate w-full"
												title={edge.resolved}
											>
												{shortName(edge.resolved)}
											</button>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Cross-project links (Phase 3d) — surfaces wikilinks that
				     leave/enter this project. Within-project outgoing wikilinks
				     are visible inline in the body, so we skip those. -->
				{#if hasCrossProjectLinks}
					<div class="mt-6 pt-4 border-t border-hub-border">
						<p class="text-[11px] uppercase tracking-wider text-hub-dim mb-3">
							Cross-project links
						</p>

						{#if outgoingByOtherProject.size > 0}
							<div class="mb-4">
								<p class="text-[11px] text-hub-dim mb-2">
									This ADR references {Array.from(outgoingByOtherProject.values()).reduce((n, arr) => n + arr.length, 0)} note{Array.from(outgoingByOtherProject.values()).reduce((n, arr) => n + arr.length, 0) === 1 ? '' : 's'} elsewhere
								</p>
								<div class="space-y-2">
									{#each Array.from(outgoingByOtherProject.entries()).sort((a, b) => a[0].localeCompare(b[0])) as [proj, paths]}
										<div class="rounded-md border border-hub-border/60 bg-hub-card/40 p-2">
											<div class="flex items-center gap-2 mb-1.5">
												<span class="text-[10px] uppercase tracking-wider text-hub-info">→</span>
												<a href="/projects/{proj}" class="text-xs font-medium text-hub-info hover:text-hub-text transition-colors">
													{proj}
												</a>
												<span class="text-[10px] text-hub-dim">({paths.length})</span>
											</div>
											<ul class="space-y-0.5 ml-4 text-xs">
												{#each paths.slice(0, 6) as p}
													<li>
														<button onclick={() => currentPath = p} class="text-hub-text hover:text-hub-info font-mono text-[11px] transition-colors text-left cursor-pointer truncate w-full">
															{shortName(p)}
														</button>
													</li>
												{/each}
												{#if paths.length > 6}
													<li class="text-[11px] text-hub-dim">+{paths.length - 6} more</li>
												{/if}
											</ul>
										</div>
									{/each}
								</div>
							</div>
						{/if}

						{#if incomingByProject.size > 0}
							<div>
								<p class="text-[11px] text-hub-dim mb-2">
									Referenced by {note.backlinks?.length ?? 0} note{(note.backlinks?.length ?? 0) === 1 ? '' : 's'}
									{#if Array.from(incomingByProject.keys()).filter((p) => p !== ownProject).length > 0}
										<span>across {incomingByProject.size} project{incomingByProject.size === 1 ? '' : 's'}</span>
									{/if}
								</p>
								<div class="space-y-2">
									{#each sortedIncomingProjects as proj}
										{@const paths = incomingByProject.get(proj) ?? []}
										{@const isOwn = proj === ownProject}
										<div class="rounded-md border p-2"
											class:border-hub-info={!isOwn}
											class:border-opacity-30={!isOwn}
											class:bg-hub-info={!isOwn}
											class:bg-opacity-5={!isOwn}
											class:border-hub-border={isOwn}
											class:border-opacity-60={isOwn}
											class:bg-hub-card={isOwn}
											class:bg-opacity-40={isOwn}
										>
											<div class="flex items-center gap-2 mb-1.5">
												<span class="text-[10px] uppercase tracking-wider"
													class:text-hub-info={!isOwn}
													class:text-hub-dim={isOwn}
												>←</span>
												{#if isOwn}
													<span class="text-xs font-medium text-hub-text">{proj}</span>
													<span class="text-[10px] text-hub-dim">(same project · {paths.length})</span>
												{:else}
													<a href="/projects/{proj}" class="text-xs font-medium text-hub-info hover:text-hub-text transition-colors">
														{proj}
													</a>
													<span class="text-[10px] text-hub-dim">({paths.length})</span>
												{/if}
											</div>
											<ul class="space-y-0.5 ml-4 text-xs">
												{#each paths.slice(0, 6) as p}
													<li>
														<button onclick={() => currentPath = p} class="text-hub-text hover:text-hub-info font-mono text-[11px] transition-colors text-left cursor-pointer truncate w-full">
															{shortName(p)}
														</button>
													</li>
												{/each}
												{#if paths.length > 6}
													<li class="text-[11px] text-hub-dim">+{paths.length - 6} more</li>
												{/if}
											</ul>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	</aside>
{/if}
