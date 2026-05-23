<script lang="ts">
	import { onMount } from 'svelte';

	interface Root {
		id: string;
		name: string;
		path: string;
		resolvedPath: string;
		showHidden: boolean;
		createdAt: string;
	}

	let roots = $state<Root[]>([]);
	let denied = $state<string[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Add form
	let newName = $state('');
	let newPath = $state('');
	let newShowHidden = $state(false);
	let adding = $state(false);

	// Per-row UI state
	let editingId = $state<string | null>(null);
	let editName = $state('');

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/settings/explorer-roots');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			roots = data.roots || [];
			denied = data.denied || [];
			error = null;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function addNewRoot() {
		if (!newName.trim() || !newPath.trim()) {
			error = 'Name and path are both required';
			return;
		}
		adding = true;
		error = null;
		try {
			const res = await fetch('/api/settings/explorer-roots', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newName.trim(),
					path: newPath.trim(),
					showHidden: newShowHidden,
				}),
			});
			const data = await res.json();
			if (!res.ok) {
				error = data.error || `HTTP ${res.status}`;
				return;
			}
			roots = [...roots, data.root];
			newName = '';
			newPath = '';
			newShowHidden = false;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			adding = false;
		}
	}

	async function removeRoot(id: string) {
		if (!confirm('Remove this root from File Explorer?')) return;
		try {
			const res = await fetch(`/api/settings/explorer-roots?id=${encodeURIComponent(id)}`, {
				method: 'DELETE',
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				error = data.error || `HTTP ${res.status}`;
				return;
			}
			roots = roots.filter((r) => r.id !== id);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function toggleHidden(root: Root) {
		try {
			const res = await fetch('/api/settings/explorer-roots', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: root.id, showHidden: !root.showHidden }),
			});
			const data = await res.json();
			if (!res.ok) {
				error = data.error || `HTTP ${res.status}`;
				return;
			}
			roots = roots.map((r) => (r.id === root.id ? data.root : r));
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function commitRename(root: Root) {
		const trimmed = editName.trim();
		if (!trimmed || trimmed === root.name) {
			editingId = null;
			return;
		}
		try {
			const res = await fetch('/api/settings/explorer-roots', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: root.id, name: trimmed }),
			});
			const data = await res.json();
			if (!res.ok) {
				error = data.error || `HTTP ${res.status}`;
				return;
			}
			roots = roots.map((r) => (r.id === root.id ? data.root : r));
			editingId = null;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	function startRename(root: Root) {
		editingId = root.id;
		editName = root.name;
	}
</script>

<section class="mb-6">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-1">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">File Explorer Roots</h2>
			<a href="/files" class="text-[10px] text-hub-cta hover:underline">Open Explorer →</a>
		</div>
		<p class="text-xs text-hub-muted mb-4 leading-relaxed">
			Folders the file explorer can browse. Each root opens up its full subtree to the
			browser at <code class="text-hub-text bg-hub-bg px-1 rounded">/files</code>. System
			paths like <code class="text-hub-text bg-hub-bg px-1 rounded">~/.ssh</code>,
			<code class="text-hub-text bg-hub-bg px-1 rounded">Keychains</code> and browser
			profiles are blocked even when covered by a root.
		</p>

		{#if error}
			<div class="mb-3 px-3 py-2 rounded-md bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
				{error}
			</div>
		{/if}

		<!-- Existing roots list -->
		{#if loading}
			<div class="text-xs text-hub-dim py-3">Loading…</div>
		{:else if roots.length === 0}
			<div class="text-xs text-hub-dim py-3 italic">No roots configured. Add one below to enable the file explorer.</div>
		{:else}
			<div class="space-y-1.5 mb-4">
				{#each roots as root (root.id)}
					<div class="flex items-center gap-3 px-3 py-2 rounded-md bg-hub-bg border border-hub-border hover:border-hub-cta/30 transition-colors">
						<svg class="w-4 h-4 text-hub-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
						</svg>
						<div class="flex-1 min-w-0">
							{#if editingId === root.id}
								<input
									type="text"
									bind:value={editName}
									onblur={() => commitRename(root)}
									onkeydown={(e) => {
										if (e.key === 'Enter') commitRename(root);
										if (e.key === 'Escape') { editingId = null; }
									}}
									class="w-full bg-hub-card border border-hub-cta/50 rounded px-1.5 py-0.5 text-sm text-hub-text focus:outline-none"
									autofocus
								/>
							{:else}
								<button
									type="button"
									class="text-sm font-medium text-hub-text truncate text-left hover:text-hub-cta cursor-pointer"
									onclick={() => startRename(root)}
									title="Click to rename"
								>{root.name}</button>
							{/if}
							<div class="text-[11px] text-hub-dim font-mono truncate" title={root.resolvedPath}>{root.path}</div>
						</div>
						<button
							type="button"
							onclick={() => toggleHidden(root)}
							class="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer
								{root.showHidden
									? 'bg-hub-cta/10 text-hub-cta border border-hub-cta/30'
									: 'bg-hub-card text-hub-dim border border-hub-border hover:text-hub-text'}"
							title="Toggle hidden file visibility"
						>{root.showHidden ? 'Hidden ON' : 'Hidden OFF'}</button>
						<button
							type="button"
							onclick={() => removeRoot(root.id)}
							class="p-1 rounded hover:bg-hub-danger/10 text-hub-dim hover:text-hub-danger transition-colors cursor-pointer"
							aria-label="Remove root"
							title="Remove root"
						>
							<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 01-2 2h-7a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>
							</svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Add new root form -->
		<div class="border-t border-hub-border pt-3">
			<h3 class="text-[11px] font-medium text-hub-muted uppercase tracking-wider mb-2">Add a root</h3>
			<div class="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
				<div>
					<label for="newRootName" class="block text-xs text-hub-muted mb-1">Name</label>
					<input
						id="newRootName"
						type="text"
						bind:value={newName}
						placeholder="Documents"
						class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
				</div>
				<div>
					<label for="newRootPath" class="block text-xs text-hub-muted mb-1">Path</label>
					<input
						id="newRootPath"
						type="text"
						bind:value={newPath}
						onkeydown={(e) => { if (e.key === 'Enter') addNewRoot(); }}
						placeholder="~/Documents"
						class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
				</div>
				<button
					type="button"
					onclick={addNewRoot}
					disabled={adding || !newName.trim() || !newPath.trim()}
					class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer
						{newName.trim() && newPath.trim() && !adding
							? 'bg-hub-cta text-black hover:bg-hub-cta-hover'
							: 'bg-hub-card text-hub-dim cursor-not-allowed'}"
				>{adding ? 'Adding…' : 'Add'}</button>
			</div>
			<label class="flex items-center gap-2 mt-2 text-xs text-hub-muted cursor-pointer">
				<input type="checkbox" bind:checked={newShowHidden} class="accent-hub-cta" />
				Show hidden files (dotfiles) in this root
			</label>
		</div>
	</div>
</section>
