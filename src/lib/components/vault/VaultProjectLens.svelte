<script lang="ts">
	import { onMount } from 'svelte';
	import type { GraphNode, GraphEdge } from '$lib/vault/types.js';
	import { TYPE_COLORS } from '$lib/vault/types.js';
	import { getVaultStore } from '$lib/vault/store.svelte.js';

	interface Props {
		projectName: string;
		onNoteSelect: (path: string) => void;
	}

	let { projectName, onNoteSelect }: Props = $props();

	const store = getVaultStore();

	// Notes state
	let notes = $state<{ path: string; title: string; type?: string; mtime?: number }[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Scaffold state
	let scaffolded = $state<boolean | null>(null);
	let scaffolding = $state(false);

	// Graph state
	let graphNodes = $state<(GraphNode & { x: number; y: number })[]>([]);
	let graphEdges = $state<GraphEdge[]>([]);

	// Search
	let searchQuery = $state('');

	// Quick-add form
	let showQuickAdd = $state(false);
	let quickAddType = $state<'learning' | 'decision' | 'debugging' | 'output'>('learning');
	let quickAddTitle = $state('');
	let quickAddSaving = $state(false);

	// Grouped + filtered notes
	const filteredNotes = $derived(
		searchQuery.trim()
			? notes.filter((n) => n.title.toLowerCase().includes(searchQuery.toLowerCase()))
			: notes
	);

	const groupedNotes = $derived(() => {
		const groups: Record<string, typeof notes> = {};
		for (const note of filteredNotes) {
			const parts = note.path.split('/');
			// path is like "projects/soul-hub/decisions/note.md" — grab the subfolder
			const folder = parts.length >= 4 ? parts[parts.length - 2] + '/' : 'root/';
			if (!groups[folder]) groups[folder] = [];
			groups[folder].push(note);
		}
		// Sort folders alphabetically
		return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
	});

	function toSlug(title: string): string {
		return title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
	}

	function relativeTime(mtime: number | undefined): string {
		if (!mtime) return '';
		const diff = Date.now() - mtime;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		return `${Math.floor(days / 30)}mo ago`;
	}

	async function checkScaffold() {
		const res = await fetch(`/api/vault/scaffold/${projectName}`);
		if (res.ok) {
			const data = await res.json();
			scaffolded = data.scaffolded;
		}
	}

	async function doScaffold() {
		scaffolding = true;
		const res = await fetch(`/api/vault/scaffold/${projectName}`, { method: 'POST' });
		if (res.ok) {
			scaffolded = true;
			await fetchNotes();
			await store.invalidate('overview', 'graph');
		}
		scaffolding = false;
	}

	async function fetchNotes() {
		try {
			const res = await fetch(`/api/vault/notes?project=${encodeURIComponent(projectName)}&limit=50`);
			if (!res.ok) throw new Error('Failed to load notes');
			const data = await res.json();
			notes = (data.results ?? []).map((n: Record<string, unknown>) => ({
				path: n.path as string,
				title: n.title as string,
				type: (n.meta as Record<string, unknown>)?.type as string | undefined,
				mtime: n.mtime as number | undefined,
			}));
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	async function fetchGraph() {
		try {
			const res = await fetch(`/api/vault/graph?project=${encodeURIComponent(projectName)}`);
			if (!res.ok) return;
			const data = await res.json();
			const raw: GraphNode[] = data.nodes ?? [];
			const edges: GraphEdge[] = data.edges ?? [];

			// Simple circular layout
			const cx = 100, cy = 75, radius = 50;
			graphNodes = raw.map((n, i) => ({
				...n,
				x: cx + radius * Math.cos((2 * Math.PI * i) / Math.max(raw.length, 1)),
				y: cy + radius * Math.sin((2 * Math.PI * i) / Math.max(raw.length, 1)),
			}));
			graphEdges = edges;
		} catch {
			// graph is optional, fail silently
		}
	}

	async function handleQuickAdd() {
		if (!quickAddTitle.trim()) return;
		quickAddSaving = true;

		const today = new Date().toISOString().slice(0, 10);
		const slug = toSlug(quickAddTitle);
		const filename = `${today}-${slug}.md`;
		const pluralType = quickAddType + 's';
		const zone = `projects/${projectName}/${pluralType}`;

		try {
			const res = await fetch('/api/vault/notes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					zone,
					filename,
					meta: {
						type: quickAddType,
						created: today,
						tags: [projectName],
						project: projectName,
					},
					content: `# ${quickAddTitle.trim()}\n\n`,
				}),
			});

			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || 'Failed to create note');
			}

			const result = await res.json();
			showQuickAdd = false;
			quickAddTitle = '';

			// Refresh and select
			await fetchNotes();
			await store.invalidate('overview', 'recent', 'graph');
			if (result.path) onNoteSelect(result.path);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			quickAddSaving = false;
		}
	}

	onMount(() => {
		fetchNotes();
		fetchGraph();
		checkScaffold();
	});
</script>

<div class="h-full flex flex-col bg-hub-surface text-hub-text text-sm">
	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-hub-border">
		<span class="text-xs font-medium text-hub-muted truncate">
			Vault <span class="text-hub-dim mx-1">&middot;</span> <span class="text-hub-text">{projectName}</span>
		</span>
		<button
			onclick={() => { showQuickAdd = !showQuickAdd; }}
			class="p-1 rounded hover:bg-hub-card text-hub-dim hover:text-hub-cta transition-colors cursor-pointer"
			title="Create note"
		>
			<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
			</svg>
		</button>
	</div>

	<!-- Quick-add form (inline) -->
	{#if showQuickAdd}
		<div class="px-3 py-2 border-b border-hub-border bg-hub-card/50 space-y-2">
			<select
				bind:value={quickAddType}
				class="w-full bg-hub-bg border border-hub-border rounded px-2 py-1 text-xs text-hub-text focus:outline-none focus:border-hub-info"
			>
				<option value="learning">Learning</option>
				<option value="decision">Decision</option>
				<option value="debugging">Debugging</option>
				<option value="output">Output</option>
			</select>
			<input
				bind:value={quickAddTitle}
				placeholder="Note title..."
				class="w-full bg-hub-bg border border-hub-border rounded px-2 py-1 text-xs text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info"
				onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleQuickAdd(); if (e.key === 'Escape') showQuickAdd = false; }}
			/>
			<div class="flex gap-1.5">
				<button
					onclick={handleQuickAdd}
					disabled={quickAddSaving || !quickAddTitle.trim()}
					class="flex-1 px-2 py-1 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 disabled:opacity-40 transition-colors cursor-pointer"
				>
					{quickAddSaving ? 'Creating...' : 'Create'}
				</button>
				<button
					onclick={() => { showQuickAdd = false; }}
					class="px-2 py-1 rounded text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-card transition-colors cursor-pointer"
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}

	<!-- Mini graph -->
	{#if graphNodes.length > 0}
		<div class="px-3 py-2 border-b border-hub-border">
			<svg viewBox="0 0 200 150" class="w-full h-[150px]">
				{#each graphEdges as edge}
					{@const src = graphNodes.find((n) => n.id === edge.source)}
					{@const tgt = graphNodes.find((n) => n.id === edge.target)}
					{#if src && tgt}
						<line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke="#334155" stroke-width="0.5" opacity="0.6" />
					{/if}
				{/each}
				{#each graphNodes as node}
					<circle
						cx={node.x}
						cy={node.y}
						r={Math.max(3, Math.min(8, node.size + 2))}
						fill={node.color || '#6366f1'}
						opacity="0.85"
					>
						<title>{node.label}</title>
					</circle>
				{/each}
			</svg>
		</div>
	{/if}

	<!-- Search -->
	<div class="px-3 py-2 border-b border-hub-border">
		<input
			bind:value={searchQuery}
			placeholder="Search notes..."
			class="w-full bg-hub-bg border border-hub-border rounded px-2 py-1 text-xs text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info"
		/>
	</div>

	<!-- Notes list -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if loading}
			<div class="px-3 py-6 text-center text-hub-dim text-xs">Loading notes...</div>
		{:else if error}
			<div class="px-3 py-4 text-center text-xs">
				<p class="text-hub-danger mb-1">{error}</p>
				<button onclick={() => { error = null; loading = true; fetchNotes(); }} class="text-hub-muted hover:text-hub-text underline">Retry</button>
			</div>
		{:else if notes.length === 0}
			<!-- Empty state -->
			{#if scaffolded === false}
				<div class="text-center py-6">
					<p class="text-hub-muted text-sm mb-3">No vault zone for this project</p>
					<button onclick={doScaffold} disabled={scaffolding}
						class="px-4 py-2 rounded-lg bg-hub-cta text-white text-sm font-medium hover:bg-hub-cta-hover transition-colors disabled:opacity-50 cursor-pointer">
						{scaffolding ? 'Creating...' : 'Create Vault Zone'}
					</button>
					<p class="text-hub-dim text-xs mt-2">Creates decisions, learnings, debugging, outputs folders</p>
				</div>
			{:else}
				<div class="px-4 py-8 text-center">
					<svg class="w-8 h-8 mx-auto mb-2 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
						<polyline points="14 2 14 8 20 8"/>
					</svg>
					<p class="text-xs text-hub-dim mb-3">No vault notes yet</p>
					<button
						onclick={() => { showQuickAdd = true; }}
						class="text-xs text-hub-cta hover:text-hub-cta/80 cursor-pointer"
					>
						Create first note
					</button>
				</div>
			{/if}
		{:else if filteredNotes.length === 0}
			<div class="px-3 py-6 text-center text-hub-dim text-xs">No matching notes</div>
		{:else}
			<div class="px-2 py-1">
				<span class="px-1 text-[10px] font-medium uppercase tracking-wider text-hub-dim">
					Notes ({filteredNotes.length})
				</span>
			</div>
			{#each groupedNotes() as [folder, folderNotes]}
				<div class="px-2 mb-1">
					<div class="px-1 py-0.5 text-[10px] font-mono text-hub-dim">{folder}</div>
					{#each folderNotes as note}
						{@const typeColor = note.type ? TYPE_COLORS[note.type] ?? '#6b7280' : '#6b7280'}
						<button
							onclick={() => onNoteSelect(note.path)}
							class="w-full text-left px-2 py-1.5 rounded hover:bg-hub-card transition-colors cursor-pointer group flex items-center gap-2"
						>
							<span
								class="flex-shrink-0 w-1.5 h-1.5 rounded-full"
								style="background-color: {typeColor}"
							></span>
							<span class="flex-1 truncate text-xs text-hub-muted group-hover:text-hub-text transition-colors">
								{note.title}
							</span>
							{#if note.mtime}
								<span class="flex-shrink-0 text-[10px] text-hub-dim">{relativeTime(note.mtime)}</span>
							{/if}
						</button>
					{/each}
				</div>
			{/each}
		{/if}
	</div>

	<!-- Footer -->
	<div class="flex-shrink-0 px-3 py-2 border-t border-hub-border">
		<a
			href="/vault?project={encodeURIComponent(projectName)}"
			class="text-[10px] text-hub-dim hover:text-hub-info transition-colors"
		>
			View all in Vault &rarr;
		</a>
	</div>
</div>
