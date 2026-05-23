<script lang="ts">
	import { onMount } from 'svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';

	interface Root {
		id: string;
		name: string;
		path: string;
		resolvedPath: string;
		showHidden: boolean;
		createdAt: string;
	}

	let roots = $state<Root[]>([]);
	let expandedRoots = $state<Record<string, boolean>>({});
	let selectedRootId = $state<string | null>(null);

	// Selected file for preview (absolute path + filename)
	let selectedFile = $state<{ path: string; name: string } | null>(null);

	// Active directory for write ops (upload / new folder). Defaults to the
	// selected root when nothing else is picked.
	let activeDir = $state<string | null>(null);

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let mobileTab = $state<'sidebar' | 'main'>('sidebar');

	// Refresh handshake: bump the signal + set the path → FileTree re-fetches.
	let refreshSignal = $state(0);
	let refreshPath = $state<string | null>(null);

	// Toast/banner for write feedback (success + error)
	let banner = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	function showBanner(kind: 'ok' | 'err', text: string) {
		banner = { kind, text };
		if (bannerTimer) clearTimeout(bannerTimer);
		bannerTimer = setTimeout(() => { banner = null; }, 4000);
	}

	// Drag state for the main pane drop zone
	let dragDepth = $state(0);
	let busy = $state(false);

	let uploadInput = $state<HTMLInputElement | null>(null);

	function refreshDir(path: string) {
		refreshPath = path;
		refreshSignal++;
	}

	function activeRoot(): Root | null {
		return roots.find((r) => r.id === selectedRootId) ?? null;
	}

	function uploadTarget(): string | null {
		if (activeDir) return activeDir;
		const root = activeRoot();
		return root?.resolvedPath ?? null;
	}

	function handleDirSelect(path: string) {
		activeDir = path;
	}

	async function createFolder() {
		const target = uploadTarget();
		if (!target) {
			showBanner('err', 'Pick a folder first');
			return;
		}
		const name = window.prompt(`Create folder inside:\n${target}`, 'new-folder');
		if (!name) return;
		busy = true;
		try {
			const res = await fetch('/api/files?action=mkdir', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: target, name }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			showBanner('ok', `Created ${data.name}`);
			refreshDir(target);
		} catch (e) {
			showBanner('err', (e as Error).message);
		} finally {
			busy = false;
		}
	}

	async function uploadFiles(files: FileList | File[]) {
		const target = uploadTarget();
		if (!target) {
			showBanner('err', 'Pick a folder first');
			return;
		}
		const list = Array.from(files);
		if (list.length === 0) return;

		busy = true;
		try {
			const form = new FormData();
			form.set('path', target);
			for (const f of list) form.append('files', f);

			const res = await fetch('/api/files?action=upload', { method: 'POST', body: form });
			const data = await res.json().catch(() => ({}));
			if (!res.ok && (!data.uploaded || data.uploaded.length === 0)) {
				throw new Error(data.error || `HTTP ${res.status}`);
			}
			const okCount = data.uploaded?.length ?? 0;
			const skipCount = data.skipped?.length ?? 0;
			let msg = `Uploaded ${okCount} file${okCount === 1 ? '' : 's'}`;
			if (skipCount > 0) {
				const reasons = data.skipped.map((s: { name: string; reason: string }) => `${s.name} (${s.reason})`).join(', ');
				msg += ` — skipped: ${reasons}`;
			}
			showBanner(skipCount > 0 ? 'err' : 'ok', msg);
			refreshDir(target);
		} catch (e) {
			showBanner('err', (e as Error).message);
		} finally {
			busy = false;
		}
	}

	function pickFiles() {
		uploadInput?.click();
	}

	function onUploadInputChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			void uploadFiles(input.files);
		}
		input.value = '';
	}

	// Page-level drag handlers — count enter/leave so child elements don't
	// flicker the visible drop ring.
	function onDragEnter(e: DragEvent) {
		if (!e.dataTransfer?.types?.includes('Files')) return;
		e.preventDefault();
		dragDepth++;
	}
	function onDragLeave(e: DragEvent) {
		if (!e.dataTransfer?.types?.includes('Files')) return;
		e.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
	}
	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types?.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}
	function onDrop(e: DragEvent) {
		if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
		e.preventDefault();
		dragDepth = 0;
		void uploadFiles(e.dataTransfer.files);
	}

	async function loadRoots() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/settings/explorer-roots');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			roots = data.roots || [];
			// Auto-expand the first root if there's only one
			if (roots.length === 1) {
				expandedRoots = { [roots[0].id]: true };
				selectedRootId = roots[0].id;
			}
			// Apply ?path=<abs> deep link if present (e.g. from a Claude session
			// File-changes list). Find the matching root and pre-select the file.
			const params = new URLSearchParams(window.location.search);
			const deepPath = params.get('path');
			if (deepPath) {
				const matchedRoot = roots.find((r) => deepPath.startsWith(r.resolvedPath));
				if (matchedRoot) {
					selectedRootId = matchedRoot.id;
					expandedRoots = { ...expandedRoots, [matchedRoot.id]: true };
					const fileName = deepPath.substring(deepPath.lastIndexOf('/') + 1);
					selectedFile = { path: deepPath, name: fileName };
					mobileTab = 'main';
				}
			}
		} catch (e) {
			loadError = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(loadRoots);

	function toggleRoot(root: Root) {
		expandedRoots = { ...expandedRoots, [root.id]: !expandedRoots[root.id] };
		selectedRootId = root.id;
		activeDir = root.resolvedPath;
	}

	function handleFileSelect(absPath: string, fileName: string) {
		selectedFile = { path: absPath, name: fileName };
		mobileTab = 'main';
	}

	function clearSelection() {
		selectedFile = null;
		mobileTab = 'sidebar';
	}
</script>

<svelte:head>
	<title>Files — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col bg-hub-bg">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border bg-hub-surface">
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
				<h1 class="text-base font-semibold text-hub-text">Files</h1>
			</div>
			<div class="flex-1"></div>
			{#if selectedFile}
				<div class="text-xs text-hub-dim font-mono truncate max-w-md hidden sm:block" title={selectedFile.path}>
					{selectedFile.path}
				</div>
			{/if}

			{#if roots.length > 0}
				{@const target = uploadTarget()}
				<button
					type="button"
					onclick={createFolder}
					disabled={!target || busy}
					class="px-2.5 py-1 rounded-md text-xs text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
					title={target ? `New folder inside ${target}` : 'Pick a folder first'}
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
						<line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
					</svg>
					<span class="hidden sm:inline">New folder</span>
				</button>
				<button
					type="button"
					onclick={pickFiles}
					disabled={!target || busy}
					class="px-2.5 py-1 rounded-md text-xs bg-hub-cta/10 text-hub-cta hover:bg-hub-cta/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
					title={target ? `Upload to ${target}` : 'Pick a folder first'}
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
					</svg>
					<span class="hidden sm:inline">Upload</span>
				</button>
				<input
					bind:this={uploadInput}
					type="file"
					multiple
					class="hidden"
					onchange={onUploadInputChange}
				/>
			{/if}

			<a
				href="/settings"
				class="px-2.5 py-1 rounded-md text-xs text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="Manage roots in settings"
			>Manage roots</a>
		</div>

		{#if banner}
			<div
				class="mt-2 px-3 py-1.5 rounded text-xs {banner.kind === 'ok' ? 'bg-hub-cta/10 text-hub-cta' : 'bg-hub-danger/10 text-hub-danger'}"
				role="status"
			>{banner.text}</div>
		{/if}

		{#if uploadTarget()}
			<div class="mt-1 text-[10px] text-hub-dim font-mono truncate" title={uploadTarget() ?? ''}>
				Active folder: {uploadTarget()}
			</div>
		{/if}

		<!-- Mobile tab switch -->
		<div class="flex sm:hidden mt-2 gap-1">
			<button
				type="button"
				onclick={() => (mobileTab = 'sidebar')}
				class="flex-1 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer
					{mobileTab === 'sidebar' ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-dim'}"
			>Tree</button>
			<button
				type="button"
				onclick={() => (mobileTab = 'main')}
				disabled={!selectedFile}
				class="flex-1 px-3 py-1 rounded text-xs font-medium transition-colors cursor-pointer disabled:opacity-40
					{mobileTab === 'main' ? 'bg-hub-cta/10 text-hub-cta' : 'text-hub-dim'}"
			>Preview</button>
		</div>
	</header>

	<div class="flex-1 flex overflow-hidden">
		<!-- Sidebar -->
		<aside
			class="w-full sm:w-[300px] lg:w-[340px] flex-shrink-0 border-r border-hub-border overflow-y-auto bg-hub-surface
				{mobileTab === 'sidebar' ? 'flex' : 'hidden sm:flex'} flex-col"
		>
			{#if loading}
				<div class="p-6 text-center text-sm text-hub-dim">Loading roots…</div>
			{:else if loadError}
				<div class="p-6">
					<div class="text-sm text-hub-danger mb-2">Failed to load roots</div>
					<div class="text-xs text-hub-dim mb-3">{loadError}</div>
					<button onclick={loadRoots} class="text-xs text-hub-cta hover:underline cursor-pointer">Retry</button>
				</div>
			{:else if roots.length === 0}
				<div class="p-6 text-center">
					<svg class="w-10 h-10 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
					<div class="text-sm text-hub-text font-medium mb-1">No folders yet</div>
					<p class="text-xs text-hub-dim mb-4">
						Add a folder in Settings to start browsing. The explorer can read every file inside the folders you add — system paths like
						<code class="text-hub-text">~/.ssh</code> stay blocked even when covered.
					</p>
					<a href="/settings" class="inline-block px-3 py-1.5 rounded-md bg-hub-cta text-black text-xs font-medium hover:bg-hub-cta-hover transition-colors cursor-pointer">
						Open Settings
					</a>
				</div>
			{:else}
				<div class="py-2">
					{#each roots as root (root.id)}
						{@const expanded = expandedRoots[root.id]}
						<button
							type="button"
							onclick={() => toggleRoot(root)}
							class="w-full flex items-center gap-2 px-3 py-2 hover:bg-hub-card/50 transition-colors text-left cursor-pointer
								{selectedRootId === root.id ? 'bg-hub-card/40' : ''}"
						>
							<svg
								class="w-3 h-3 text-hub-dim flex-shrink-0 transition-transform {expanded ? 'rotate-90' : ''}"
								viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							>
								<polyline points="9 18 15 12 9 6"/>
							</svg>
							<svg class="w-4 h-4 text-hub-cta/80 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
							</svg>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-hub-text truncate">{root.name}</div>
								<div class="text-[10px] text-hub-dim font-mono truncate" title={root.resolvedPath}>{root.path}</div>
							</div>
						</button>
						{#if expanded}
							<div class="border-l border-hub-border/60 ml-[14px]">
								<FileTree
									codePath={root.resolvedPath}
									onFileSelect={handleFileSelect}
									onDirSelect={handleDirSelect}
									{activeDir}
									{refreshSignal}
									{refreshPath}
								/>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</aside>

		<!-- Main pane -->
		<main
			class="flex-1 overflow-hidden bg-hub-bg relative
				{mobileTab === 'main' ? 'flex' : 'hidden sm:flex'} flex-col"
			ondragenter={onDragEnter}
			ondragleave={onDragLeave}
			ondragover={onDragOver}
			ondrop={onDrop}
			role="region"
			aria-label="File preview and upload zone"
		>
			{#if selectedFile}
				<FilePreview
					filePath={selectedFile.path}
					fileName={selectedFile.name}
					onClose={clearSelection}
				/>
			{:else}
				<div class="flex-1 flex items-center justify-center p-6">
					<div class="text-center max-w-sm">
						<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
						</svg>
						<div class="text-sm text-hub-muted">Select a file from the tree to preview it</div>
						<div class="text-[11px] text-hub-dim mt-2">
							Markdown, code, CSV, images, video, audio, and PDFs render inline.
						</div>
						{#if uploadTarget()}
							<div class="text-[11px] text-hub-dim mt-3">
								Or drop files here to upload to
								<span class="font-mono text-hub-muted">{uploadTarget()}</span>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			{#if dragDepth > 0}
				<div class="absolute inset-2 pointer-events-none rounded-xl border-2 border-dashed border-hub-cta bg-hub-cta/5 flex items-center justify-center">
					<div class="text-center">
						<svg class="w-10 h-10 text-hub-cta mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
						</svg>
						<div class="text-sm text-hub-cta font-medium">Drop to upload</div>
						<div class="text-[11px] text-hub-dim mt-1 font-mono">{uploadTarget() ?? '(no folder selected)'}</div>
					</div>
				</div>
			{/if}

			{#if busy}
				<div class="absolute top-2 right-2 px-2 py-1 rounded bg-hub-surface text-[11px] text-hub-muted border border-hub-border">
					Working…
				</div>
			{/if}
		</main>
	</div>
</div>
