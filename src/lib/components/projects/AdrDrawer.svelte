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
	import { resolveAgentForWork } from '$lib/projects/dispatch-routing.js';

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
		backlinks?: string[];
	}

	type DrawerAction = 'accept' | 'reject' | 'park' | 'ship';

	interface Props {
		path: string | null;
		onClose: () => void;
		onTransition?: (info: { path: string; action: DrawerAction; newStatus: string }) => void;
	}

	let { path, onClose, onTransition }: Props = $props();

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
	let savingTarget = $state(false);
	let targetDateInput = $state('');
	let editingTarget = $state(false);
	// projects-graph ADR-017 P3 — assignee (ownership), orthogonal to status.
	let savingAssignee = $state(false);
	let assigneeInput = $state('');
	let editingAssignee = $state(false);
	// projects-graph ADR-018 S2 — Dispatch to AI loop (drawer).
	let agentIds = $state<Set<string>>(new Set());
	let dispatchMode = $state<'test' | 'production'>('test');
	let dispatching = $state(false);
	let dispatchOutput = $state('');
	let dispatchError = $state('');
	let dispatchDoneNote = $state<string | null>(null);
	let mutationError = $state('');

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
	// projects-graph ADR-018 S2 — which agent (if any) can run this artifact.
	const dispatchTarget = $derived(resolveAgentForWork(workType, assignee, agentIds));
	const canDispatch = $derived(!!dispatchTarget && isTransitionable && status !== 'shipped');
	const tags = $derived(extractStringArray(note?.meta.tags));
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
				items.push({ label, raw, resolved: resolveRelLink(raw, note.path) });
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
		try {
			const res = await fetch(`/api/vault/notes/${p}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			note = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load note';
		} finally {
			loading = false;
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
	async function loadAgentIds() {
		if (agentIds.size > 0) return;
		try {
			const res = await fetch('/api/agents');
			if (!res.ok) return;
			const data = await res.json();
			const list = Array.isArray(data) ? data : (data.agents ?? data.results ?? []);
			agentIds = new Set(
				list.map((a: { id?: string }) => (a.id ?? '').toLowerCase()).filter(Boolean),
			);
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
		const agent = dispatchTarget;
		const artifactPath = note.path;
		const artifactSlug = artifactPath.split('/').pop()?.replace(/\.md$/i, '') ?? artifactPath;
		const proj = project;
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

			const res = await fetch(`/api/agents/${agent}/test?mode=${dispatchMode}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: task.slice(0, 4000), subject: artifactPath }),
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
						const result = ev.result as { output?: string } | undefined;
						finalOutput = result?.output ?? dispatchOutput;
					}
				}
			}
			if (dispatchError) return;

			const body = finalOutput.trim() || dispatchOutput.trim();
			if (!body) {
				dispatchError = 'Agent returned no output.';
				return;
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
				`- **Mode**: ${dispatchMode}\n` +
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
							<DecisionActions path={note.path} size="sm" onTransition={handleTransition} />
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

				<!-- Ship button for accepted artifacts (P3: any transitionable type) -->
				{#if isAccepted && isTransitionable}
					<div class="mb-5 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5 flex items-center justify-between gap-3">
						<div>
							<p class="text-xs text-hub-info">Decision accepted{acceptedOn ? ` on ${acceptedOn}` : ''}</p>
							<p class="text-[11px] text-hub-dim mt-0.5">Mark as shipped when all planned phases are live.</p>
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

				<!-- projects-graph ADR-018 S2 — Dispatch to AI. Shown when the
				     artifact's work_type / assignee resolves to a roster agent.
				     Writes output back as a linked note; human reviews + ships. -->
				{#if canDispatch}
					<div class="mb-5 p-3 rounded-lg border border-hub-cta/30 bg-hub-cta/5">
						<div class="flex items-center justify-between gap-3 flex-wrap">
							<div>
								<p class="text-xs text-hub-text font-medium">Dispatch to AI</p>
								<p class="text-[11px] text-hub-dim mt-0.5">→ <span class="font-mono">{dispatchTarget}</span>{workType ? ` · ${workType}` : ''}</p>
							</div>
							<div class="flex items-center gap-1.5">
								<select
									bind:value={dispatchMode}
									disabled={dispatching}
									class="px-1.5 py-1 rounded bg-hub-card border border-hub-border text-hub-text text-[11px] cursor-pointer disabled:opacity-50"
									title="test = capped $0.10 / 5 turns · run = real budget"
								>
									<option value="test">test</option>
									<option value="production">run</option>
								</select>
								<button
									onclick={dispatchToAI}
									disabled={dispatching}
									class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
								>
									{dispatching ? '🟡 working…' : 'Dispatch'}
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
								<span class="text-hub-dim">then ship the artifact above.</span>
							</div>
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
								<ul class="space-y-0.5 ml-4">
									{#each upstreamEdges as edge}
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
