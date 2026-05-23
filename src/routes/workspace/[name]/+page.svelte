<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';
	import FileTree from '$lib/components/FileTree.svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';
	import VaultProjectLens from '$lib/components/vault/VaultProjectLens.svelte';
	import ProjectInfoDropdown from '$lib/components/ProjectInfoDropdown.svelte';
	import type { SoulHubConfig } from '$lib/project/schema.js';

	const { data } = $props();
	const projectName = $derived(page.params.name ?? '');
	const projectConfig = $derived(data.projectConfig as SoulHubConfig | null);

	// Panel state (defaults, overridden from localStorage in onMount)
	let sidePanel = $state<'code' | 'vault' | null>('code');
	let sidePanelWidth = $state(260);
	let resizing = $state(false);

	// Setup mode: auto-start terminal with guided Q&A after project creation
	let isSetupMode = $state(false);
	const showSetupBanner = $derived(!data.setupComplete && data.devPath != null && !isSetupMode);

	// File preview state
	let previewFile = $state<{ path: string; name: string } | null>(null);

	// Mobile state
	let isMobile = $state(false);
	let mobileView = $state<'terminal' | 'files' | 'vault'>('terminal');

	// Git state
	let gitInfo = $state<{
		isGit: boolean;
		branch: string | null;
		dirty: boolean;
		uncommittedCount: number;
		recentCommits: { hash: string; message: string; relativeTime: string }[];
	} | null>(null);

	// Component refs
	let terminalTabsRef: TerminalTabs | undefined = $state();

	function startSetup() {
		const pName = data.projectConfig?.name || data.name;
		const desc = data.projectConfig?.description || '';
		const pType = data.projectConfig?.type || 'web-app';

		const soulHubRoot = data.soulHubRoot;
		const prompt = [
			`New project "${pName}" (type: ${pType}): "${desc}".`,
			'',
			'SETUP INSTRUCTIONS:',
			'1. Read CLAUDE.md in the project root for the full Evaluate → Analyze → Apply framework.',
			`2. Read ${soulHubRoot}/src/lib/project/schema.ts for TEMPLATE_FOR_FRAMEWORK mapping and SoulHubConfig interface.`,
			`3. Read ${soulHubRoot}/src/lib/project/claude-md-generator.ts for CLAUDE.md generation patterns.`,
			`4. Read ${soulHubRoot}/src/lib/project/hook-generator.ts for guard.sh generation patterns.`,
			'',
			'WORKFLOW:',
			'- Ask ONE question at a time using AskUserQuestion tool (7 total: type, framework, database, focus, avoid, tooling, pipelines).',
			'- After all answers: propose the full .soul-hub.json config and wait for approval.',
			'- After approval: update .soul-hub.json, regenerate CLAUDE.md, regenerate guard.sh, copy template files using `cp -r`, run npm install or uv init.',
			'',
			'START by reading CLAUDE.md, then ask Question 1.',
		].join('\n');

		isSetupMode = true;

		if (terminalTabsRef) {
			terminalTabsRef.sendToActive(prompt);
		}
	}

	onMount(() => {
		// Load UI prefs from localStorage
		try {
			const prefs = localStorage.getItem('soul-hub-prefs');
			if (prefs) {
				const p = JSON.parse(prefs);
				if (p.defaultPanel) {
					sidePanel = p.defaultPanel === 'closed' ? null : p.defaultPanel;
				}
				if (p.panelWidth) sidePanelWidth = p.panelWidth;
			}
		} catch { /* use defaults */ }

		// Check for setup mode (redirected from project creation wizard)
		const url = new URL(window.location.href);
		if (url.searchParams.has('setup')) {
			// Clean URL so refresh doesn't re-trigger
			url.searchParams.delete('setup');
			window.history.replaceState(null, '', url.toString());

			// Auto-start setup after terminal mounts
			setTimeout(() => startSetup(), 500);
		}

		// Fetch git info
		if (data.devPath) {
			fetch(`/api/git?path=${encodeURIComponent(data.devPath)}`)
				.then((r) => r.ok ? r.json() : null)
				.then((d) => { if (d) gitInfo = d; })
				.catch(() => {});
		}

		const checkMobile = () => {
			isMobile = window.innerWidth < 768;
			if (isMobile) sidePanel = null;
		};
		checkMobile();
		window.addEventListener('resize', checkMobile);
		return () => window.removeEventListener('resize', checkMobile);
	});

	function handleFileSelect(path: string, fileName: string) {
		previewFile = { path, name: fileName };
	}

	function closePreview() {
		previewFile = null;
	}

	// Resizable panel drag
	function startResize(e: MouseEvent) {
		e.preventDefault();
		resizing = true;
		const startX = e.clientX;
		const startWidth = sidePanelWidth;

		function onMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			sidePanelWidth = Math.max(180, Math.min(500, startWidth + delta));
		}

		function onUp() {
			resizing = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		}

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'b') {
			e.preventDefault();
			if (isMobile) {
				mobileView = mobileView === 'files' ? 'terminal' : 'files';
			} else {
				sidePanel = sidePanel ? null : 'code';
			}
		}

		if (e.key === 'v' && e.shiftKey) {
			e.preventDefault();
			if (isMobile) {
				mobileView = mobileView === 'vault' ? 'terminal' : 'vault';
			} else {
				setSidePanel('vault');
			}
		}
	}

	// Toggle side panel tab — clicking the active tab closes it
	function setSidePanel(tab: 'code' | 'vault') {
		sidePanel = sidePanel === tab ? null : tab;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{projectName} — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-surface/50">
		<div class="flex items-center gap-3">
			<a href="/workspaces" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text" aria-label="Back to workspaces">
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>

			<ProjectInfoDropdown
				{projectName}
				devPath={data.devPath}
								{gitInfo}
			/>

			<!-- Project type badge -->
			{#if projectConfig?.type}
				{@const typeColors: Record<string, string> = {
					development: 'bg-hub-cta/10 text-hub-cta',
					content: 'bg-hub-purple/10 text-hub-purple',
					research: 'bg-hub-info/10 text-hub-info',
					media: 'bg-hub-warning/10 text-hub-warning',
					operations: 'bg-hub-danger/10 text-hub-danger',
				}}
				<span class="hidden md:inline-flex items-center px-2 py-0.5 rounded text-xs font-medium {typeColors[projectConfig.type] ?? 'bg-hub-dim/10 text-hub-dim'}">
					{projectConfig.type}
				</span>
			{/if}

			<!-- Stack badges -->
			{#if projectConfig?.stack}
				<div class="hidden md:flex items-center gap-1">
					{#if projectConfig.stack.framework}
						<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-hub-surface text-hub-muted border border-hub-border">
							{projectConfig.stack.framework}
						</span>
					{/if}
					{#if projectConfig.stack.language}
						<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-hub-surface text-hub-muted border border-hub-border">
							{projectConfig.stack.language}
						</span>
					{/if}
					{#if projectConfig.stack.styling && projectConfig.stack.styling !== 'none'}
						<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-hub-surface text-hub-muted border border-hub-border">
							{projectConfig.stack.styling}
						</span>
					{/if}
				</div>
			{/if}

			<!-- Git branch badge -->
			{#if gitInfo?.isGit && gitInfo.branch}
				<span class="hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-hub-purple/10 text-hub-purple text-xs font-mono">
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
					{gitInfo.branch}
					{#if gitInfo.dirty}
						<span class="w-1.5 h-1.5 rounded-full bg-hub-warning" title="{gitInfo.uncommittedCount} uncommitted"></span>
					{/if}
				</span>
			{/if}

			<!-- Orchestration link -->
			<a
				href="/workspace/{projectName}/orchestration"
				class="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border border-purple-500/30 text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 hover:border-purple-500/50"
				title="Multi-agent orchestration"
			>
				<svg class="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
				Orchestration
			</a>

			<!-- Sessions link -->
			<a
				href="/workspace/{projectName}/sessions"
				class="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border border-hub-cta/30 text-hub-cta hover:text-hub-cta/80 hover:bg-hub-cta/10 hover:border-hub-cta/50"
				title="Unified session timeline (terminal · pipelines · playbooks · claude)"
			>
				<svg class="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
				Sessions
			</a>

			<!-- Desktop panel toggles -->
			<div class="hidden md:flex items-center gap-1 ml-auto">
				{#if data.devPath}
					<button
						onclick={() => setSidePanel('code')}
						class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
							{sidePanel === 'code' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
						title="Toggle file browser (Cmd+B)"
					>
						<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
						Files
					</button>
				{/if}
				<button
					onclick={() => setSidePanel('vault')}
					class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
						{sidePanel === 'vault' ? 'bg-hub-purple/15 text-hub-purple' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
					title="Toggle vault (Cmd+Shift+V)"
				>
					<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
					Vault
				</button>
			</div>

			<!-- Mobile view toggles -->
			<div class="flex md:hidden items-center gap-1 ml-auto">
				<button
					onclick={() => mobileView = 'terminal'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'terminal' ? 'bg-hub-cta/15 text-hub-cta' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
				</button>
				<button
					onclick={() => mobileView = 'files'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'files' ? 'bg-hub-info/15 text-hub-info' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
				</button>
				<button
					onclick={() => mobileView = 'vault'}
					class="px-2 py-1.5 rounded text-xs cursor-pointer
						{mobileView === 'vault' ? 'bg-hub-purple/15 text-hub-purple' : 'text-hub-dim'}"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
				</button>
			</div>
		</div>
	</header>

	<!-- Project info bar: description + pipelines -->
	{#if projectConfig?.description || (projectConfig?.pipelines && projectConfig.pipelines.length > 0)}
		<div class="flex-shrink-0 px-4 py-2 border-b border-hub-border bg-hub-surface/30 flex items-center gap-4 text-xs overflow-x-auto">
			{#if projectConfig.description}
				<span class="text-hub-muted truncate">{projectConfig.description}</span>
			{/if}
			{#if projectConfig.pipelines && projectConfig.pipelines.length > 0}
				<span class="text-hub-dim">|</span>
				<div class="flex items-center gap-2 flex-shrink-0">
					<svg class="w-3.5 h-3.5 text-hub-info flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="5 3 19 12 5 21 5 3"/>
					</svg>
					{#each projectConfig.pipelines as pipeline}
						{@const triggerColors: Record<string, string> = {
							manual: 'text-hub-muted',
							'on-commit': 'text-hub-cta',
							scheduled: 'text-hub-purple',
						}}
						<span
							class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-hub-card border border-hub-border opacity-70"
							title="Pipeline module retired (ADR-002) — see /naseej for the replacement"
						>
							<span class="text-hub-text">{pipeline.name}</span>
							<span class="text-hub-dim">{pipeline.role}</span>
							<span class="px-1 py-px rounded text-[9px] font-medium {triggerColors[pipeline.trigger] ?? 'text-hub-dim'} bg-hub-surface">
								{pipeline.trigger}
							</span>
						</span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if showSetupBanner}
		<div class="mx-4 mt-2 mb-2 bg-hub-warning/10 border border-hub-warning/30 rounded-lg px-4 py-3 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-warning flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
				</svg>
				<span class="text-sm text-hub-warning">Project setup incomplete — stack and governance not configured yet.</span>
			</div>
			<button
				onclick={startSetup}
				class="text-xs bg-hub-warning/20 hover:bg-hub-warning/30 text-hub-warning px-3 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap"
			>
				Run Setup
			</button>
		</div>
	{/if}

	<!-- Main content area -->
	<div class="flex-1 min-h-0 flex">
		<!-- Desktop: Side panel -->
		{#if !isMobile && sidePanel}
			<div
				class="flex-shrink-0 border-r border-hub-border overflow-hidden"
				style="width: {sidePanelWidth}px"
			>
				{#if sidePanel === 'code'}
					<FileTree
						codePath={data.devPath}
												onFileSelect={handleFileSelect}
					/>
				{:else if sidePanel === 'vault'}
					<VaultProjectLens
						{projectName}
						onNoteSelect={(path) => { handleFileSelect(`${data.vaultDir}/${path}`, path.split('/').pop() ?? path); }}
					/>
				{/if}
			</div>

			<!-- Resize handle -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
				onmousedown={startResize}
			></div>
		{/if}

		<!-- Terminal area (desktop) / Active view (mobile) -->
		<div class="flex-1 min-w-0 min-h-0">
			{#if isMobile}
				<!-- Mobile views -->
				{#if mobileView === 'terminal'}
					<TerminalTabs
						bind:this={terminalTabsRef}
						cwd={data.cwd}
						{projectName}
					/>
				{:else if mobileView === 'files'}
					<FileTree
						codePath={data.devPath}
												onFileSelect={handleFileSelect}
					/>
				{:else if mobileView === 'vault'}
					<VaultProjectLens
						{projectName}
						onNoteSelect={(path) => { handleFileSelect(`${data.vaultDir}/${path}`, path.split('/').pop() ?? path); }}
					/>
				{/if}
			{:else}
				<!-- Desktop: terminal always visible -->
				<TerminalTabs
					bind:this={terminalTabsRef}
					cwd={data.cwd}
					{projectName}
				/>
			{/if}
		</div>
	</div>
</div>

<!-- File preview slide-over -->
{#if previewFile}
	<FilePreview
		filePath={previewFile.path}
		fileName={previewFile.name}
		onClose={closePreview}
	/>
{/if}
