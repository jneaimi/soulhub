<script lang="ts">
	interface Props {
		codePath: string | null;
		onFileSelect: (path: string, fileName: string) => void;
		/** Notified when a directory row is clicked — used by the parent to set the
		 *  active upload/mkdir target. Optional so existing call-sites still work. */
		onDirSelect?: (path: string) => void;
		/** The currently active directory (highlighted) — provided by the parent. */
		activeDir?: string | null;
		/** Bumped by the parent to force a reload of `refreshPath`'s entries. */
		refreshSignal?: number;
		refreshPath?: string | null;
	}

	interface FileEntry {
		name: string;
		type: 'dir' | 'file';
		size?: number;
	}

	interface DirState {
		entries: FileEntry[];
		loading: boolean;
		expanded: boolean;
	}

	let {
		codePath,
		onFileSelect,
		onDirSelect,
		activeDir = null,
		refreshSignal = 0,
		refreshPath = null,
	}: Props = $props();

	let dirCache = $state<Record<string, DirState>>({});

	const rootPath = $derived(codePath);

	// Load root when tab changes
	$effect(() => {
		if (rootPath && !dirCache[rootPath]) {
			loadDir(rootPath);
		}
	});

	// Re-fetch a specific path when the parent bumps the refresh signal
	// (after upload / mkdir success). Keeps expanded state intact.
	$effect(() => {
		// Track the signal so this effect re-runs on every bump
		refreshSignal;
		if (refreshPath && dirCache[refreshPath]) {
			loadDir(refreshPath);
		}
	});

	async function loadDir(path: string) {
		if (dirCache[path]?.loading) return;

		dirCache[path] = { entries: [], loading: true, expanded: true };

		try {
			const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
			if (res.ok) {
				const data = await res.json();
				dirCache[path] = { entries: data.entries, loading: false, expanded: true };
			} else {
				dirCache[path] = { entries: [], loading: false, expanded: true };
			}
		} catch {
			dirCache[path] = { entries: [], loading: false, expanded: true };
		}
	}

	function toggleDir(path: string) {
		const state = dirCache[path];
		if (!state) {
			loadDir(path);
		} else {
			dirCache[path] = { ...state, expanded: !state.expanded };
		}
		onDirSelect?.(path);
	}

	function getFileIcon(name: string, type: 'dir' | 'file'): string {
		if (type === 'dir') return 'dir';
		const ext = name.split('.').pop()?.toLowerCase() || '';
		if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return 'code';
		if (['svelte', 'vue'].includes(ext)) return 'component';
		if (['md', 'mdx', 'txt'].includes(ext)) return 'doc';
		if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return 'config';
		if (['css', 'scss', 'less'].includes(ext)) return 'style';
		if (['py', 'rb', 'go', 'rs'].includes(ext)) return 'code';
		if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
		return 'file';
	}

	function formatSize(bytes: number | undefined): string {
		if (!bytes) return '';
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}K`;
		return `${(bytes / 1048576).toFixed(1)}M`;
	}
</script>

<div class="flex flex-col h-full bg-hub-surface/50">
	<!-- File tree -->
	<div class="flex-1 overflow-y-auto text-xs py-1">
		{#if rootPath}
			{@render dirNode(rootPath, 0)}
		{:else}
			<div class="px-3 py-6 text-center text-hub-dim">
				No code directory
			</div>
		{/if}
	</div>
</div>

{#snippet dirNode(path: string, depth: number)}
	{@const state = dirCache[path]}
	{#if state?.loading}
		<div class="px-3 py-1 text-hub-dim" style="padding-left: {12 + depth * 16}px">Loading...</div>
	{:else if state?.expanded && state.entries}
		{#each state.entries as entry (entry.name)}
			{@const entryPath = `${path}/${entry.name}`}
			{@const icon = getFileIcon(entry.name, entry.type)}
			{#if entry.type === 'dir'}
				<button
					onclick={() => toggleDir(entryPath)}
					class="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-hub-card/50 transition-colors text-left cursor-pointer
						{activeDir === entryPath ? 'bg-hub-cta/10 text-hub-cta' : ''}"
					style="padding-left: {12 + depth * 16}px"
				>
					<svg class="w-3 h-3 text-hub-dim flex-shrink-0 transition-transform {dirCache[entryPath]?.expanded ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="9 18 15 12 9 6"/>
					</svg>
					<svg class="w-3.5 h-3.5 text-hub-warning/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
					<span class="text-hub-text truncate">{entry.name}</span>
				</button>
				{#if dirCache[entryPath]?.expanded}
					{@render dirNode(entryPath, depth + 1)}
				{/if}
			{:else}
				<button
					onclick={() => onFileSelect(entryPath, entry.name)}
					class="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-hub-card/50 transition-colors text-left cursor-pointer group"
					style="padding-left: {28 + depth * 16}px"
				>
					{#if icon === 'code'}
						<svg class="w-3.5 h-3.5 text-hub-info/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
					{:else if icon === 'component'}
						<svg class="w-3.5 h-3.5 text-hub-cta/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
					{:else if icon === 'doc'}
						<svg class="w-3.5 h-3.5 text-hub-muted flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
					{:else if icon === 'config'}
						<svg class="w-3.5 h-3.5 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
					{:else if icon === 'style'}
						<svg class="w-3.5 h-3.5 text-hub-purple/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					{:else if icon === 'image'}
						<svg class="w-3.5 h-3.5 text-hub-warning/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					{:else}
						<svg class="w-3.5 h-3.5 text-hub-dim flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
					{/if}
					<span class="text-hub-muted group-hover:text-hub-text truncate">{entry.name}</span>
					{#if entry.size}
						<span class="ml-auto text-hub-dim/60 text-[10px] flex-shrink-0">{formatSize(entry.size)}</span>
					{/if}
				</button>
			{/if}
		{/each}
	{/if}
{/snippet}
