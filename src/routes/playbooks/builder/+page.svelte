<script lang="ts">
	import { onMount } from 'svelte';
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';

	const { data } = $props();

	// Build types
	type BuildType = 'playbook' | 'chain' | 'fork';
	const buildTypes: { value: BuildType; label: string }[] = [
		{ value: 'playbook', label: 'New Playbook' },
		{ value: 'chain', label: 'New Chain' },
		{ value: 'fork', label: 'Fork Existing' },
	];

	const placeholders: Record<BuildType, string> = {
		playbook: 'Describe what your playbook should do...',
		chain: 'Describe how you want to orchestrate multiple playbooks...',
		fork: 'Which playbook do you want to customize and why?',
	};

	// Initialize from URL context
	function getInitialBuildType(): BuildType {
		if (data.forkName) return 'fork';
		if (data.chainName) return 'chain';
		return 'playbook';
	}

	let buildType = $state<BuildType>(getInitialBuildType());
	let selectedTemplate = $state<string | null>(null);
	let userPrompt = $state('');
	let sessionStarted = $state(false);
	let loading = $state(false);
	let composedPrompt = $state('');
	let bannerDismissed = $state(false);

	// Staged playbooks as references
	let stagedPlaybooks = $state<{ name: string; roleCount: number; phaseCount: number }[]>([]);
	const stagedNames = $derived(new Set(stagedPlaybooks.map((p) => p.name)));

	// Sidebar
	let sidebarOpen = $state(true);
	let sidebarWidth = $state(240);
	let resizing = $state(false);

	const label = $derived(
		data.playbookName && data.playbookYaml
			? `Editing ${data.playbookName}`
			: data.forkName
				? `Forking ${data.forkName}`
				: data.chainName
					? `Editing chain ${data.chainName}`
					: buildTypes.find((bt) => bt.value === buildType)?.label || 'Builder'
	);

	const troubleshootContext = $derived(data.troubleshootContext);

	const bannerType = $derived.by<'troubleshoot' | 'edit' | 'edit-error' | 'fork' | 'fork-error' | null>(() => {
		if (bannerDismissed) return null;
		if (troubleshootContext) return 'troubleshoot';
		if (data.playbookName && data.playbookYaml) return 'edit';
		if (data.playbookName && !data.playbookYaml) return 'edit-error';
		if (data.forkName && data.forkYaml) return 'fork';
		if (data.forkName && !data.forkYaml) return 'fork-error';
		return null;
	});

	onMount(() => {
		if (troubleshootContext) {
			userPrompt = `Run failed: ${troubleshootContext.error}`;
			startSession();
		} else if (data.playbookName && data.playbookYaml) {
			userPrompt = `Editing "${data.playbookName}".\n\nCurrent playbook.yaml:\n\`\`\`yaml\n${data.playbookYaml}\`\`\``;
			startSession();
		} else if (data.forkName && data.forkYaml) {
			userPrompt = `Fork "${data.forkName}" and customize it.`;
			buildType = 'fork';
		} else if (data.chainYaml && data.chainName) {
			buildType = 'chain';
			userPrompt = `Editing chain "${data.chainName}".\n\`\`\`yaml\n${data.chainYaml}\`\`\``;
			startSession();
		}
	});

	function stagePlaybook(pb: { name: string; roleCount: number; phaseCount: number }) {
		if (stagedNames.has(pb.name)) {
			stagedPlaybooks = stagedPlaybooks.filter((p) => p.name !== pb.name);
		} else {
			stagedPlaybooks = [...stagedPlaybooks, pb];
		}
	}

	function removeStagedPlaybook(name: string) {
		stagedPlaybooks = stagedPlaybooks.filter((p) => p.name !== name);
	}

	function composePrompt(): string {
		if (troubleshootContext) {
			const parts: string[] = [];
			parts.push(`Playbook "${troubleshootContext.playbookName}" run failed.`);
			parts.push(`Error: ${troubleshootContext.error}`);
			parts.push(`Playbook YAML:\n\`\`\`yaml\n${troubleshootContext.playbookYaml}\`\`\``);
			if (troubleshootContext.roleFiles.length > 0) {
				parts.push(`Role files:\n${troubleshootContext.roleFiles.join('\n\n')}`);
			}
			if (userPrompt.trim()) {
				parts.push(`Additional context: ${userPrompt.trim()}`);
			}
			parts.push('Diagnose the root cause and suggest fixes.');
			return parts.join('\n\n');
		}

		const parts: string[] = [];

		parts.push(`You are building a Soul Hub playbook. Read CLAUDE.md and CONTRACTS.md for governance rules.

WORKFLOW — follow these steps in order:

Step 1: DISCOVER (ask ONE question at a time)
- What business process is this automating?
- How would a professional team do this? (who does what, in what order)
- What inputs does the user provide? What outputs do they expect?
- What could go wrong? (timeout, bad input, 0 results)

Step 2: DESIGN (propose plan — get approval before creating files)
- Map the professional workflow to phase types:
  Independent experts → parallel | Sequential handoff → sequential
  Iterative refinement → handoff | Need human input → human + revision + gate
  Need human approval → gate | Fast pre-work → pre_run hooks
- Identify roles, inputs, prerequisites
- Sketch the phase flow

Step 3: BUILD (only after user approves the plan)
- Copy the closest template from templates/ — never write from scratch
- Create playbook.yaml, roles/*.md, hooks/*.py (if needed)
- Guard hooks will BLOCK invalid files automatically:
  • playbook.yaml must have: type, roles, phases, output
  • Model must be aliases: sonnet, opus, haiku (NOT claude-sonnet-4)
  • Handoff phases must have between: and loop_until:
  • Variable refs ($inputs.X) must match declared inputs

Step 4: VALIDATE (mandatory before finishing)
- Run: python3 -c "import yaml; yaml.safe_load(open('playbooks/<name>/playbook.yaml'))"
- Verify every role's agent .md file exists
- Verify variable references ($inputs.X, $phases.X.Y) resolve
- Check prerequisites are declared for any external tools
- Confirm the playbook appears in the library: curl -s http://localhost:5173/api/playbooks | python3 -m json.tool | grep <name>`);

		parts.push(`Build type: ${buildTypes.find((bt) => bt.value === buildType)?.label || buildType}`);

		if (selectedTemplate) {
			parts.push(`Template: Start from templates/${selectedTemplate}/`);
		}

		if (stagedPlaybooks.length > 0) {
			const stagedList = stagedPlaybooks.map((p) => `- ${p.name} (${p.roleCount} roles, ${p.phaseCount} phases)`).join('\n');
			parts.push(`Reference these playbooks:\n${stagedList}`);
		}

		if (userPrompt.trim()) {
			parts.push(`My goal: ${userPrompt.trim()}`);
		}

		return parts.join('\n\n') || 'Start a new playbook builder session.';
	}

	function startSession() {
		composedPrompt = composePrompt();
		loading = true;
		sessionStarted = true;
	}

	function openTerminal() {
		composedPrompt = '';
		loading = true;
		sessionStarted = true;
	}

	function handleReady() {
		loading = false;
	}

	function dismissBanner() {
		bannerDismissed = true;
	}

	function startResize(e: MouseEvent) {
		e.preventDefault();
		resizing = true;
		const startX = e.clientX;
		const startWidth = sidebarWidth;

		function onMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			sidebarWidth = Math.max(180, Math.min(400, startWidth + delta));
		}

		function onUp() {
			resizing = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		}

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	function handleKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (meta && e.key === 'b') {
			e.preventDefault();
			sidebarOpen = !sidebarOpen;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{label} — Soul Hub Builder</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header -->
	<div class="flex items-center gap-3 px-4 py-3 border-b border-hub-border flex-shrink-0">
		<a href="/playbooks" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Back to playbooks">
			<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
			</svg>
		</a>
		<span class="text-xs text-hub-dim">Playbooks</span>
		<h1 class="text-base font-semibold text-hub-text">{label}</h1>

		<div class="flex items-center gap-1 ml-auto">
			<button
				onclick={() => (sidebarOpen = !sidebarOpen)}
				class="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer
					{sidebarOpen ? 'bg-hub-warning/15 text-hub-warning' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-card'}"
				title="Toggle sidebar (Cmd+B)"
			>
				<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
				</svg>
				Library
			</button>
		</div>
	</div>

	<!-- Context banners -->
	{#if bannerType === 'troubleshoot'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-danger/10 border-l-4 border-hub-danger flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-danger flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
				</svg>
				<span class="text-sm text-hub-text">Troubleshooting failed run <strong class="text-hub-danger">{troubleshootContext?.runId}</strong> in <strong class="text-hub-danger">{troubleshootContext?.playbookName}</strong></span>
			</div>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'edit'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-purple/10 border-l-4 border-hub-purple flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-purple flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
				</svg>
				<span class="text-sm text-hub-text">Editing <strong class="text-hub-purple">{data.playbookName}</strong></span>
			</div>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'edit-error'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-danger/10 border-l-4 border-hub-danger flex items-center justify-between">
			<span class="text-sm text-hub-text">Playbook <strong class="text-hub-danger">{data.playbookName}</strong> not found</span>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'fork'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-purple/10 border-l-4 border-hub-purple flex items-center justify-between">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-hub-purple flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 01-2 2H8a2 2 0 01-2-2V9M12 12v3"/>
				</svg>
				<span class="text-sm text-hub-text">Forking <strong class="text-hub-purple">{data.forkName}</strong></span>
			</div>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{:else if bannerType === 'fork-error'}
		<div class="flex-shrink-0 mx-4 mt-3 rounded-lg px-4 py-2 bg-hub-danger/10 border-l-4 border-hub-danger flex items-center justify-between">
			<span class="text-sm text-hub-text">Playbook <strong class="text-hub-danger">{data.forkName}</strong> not found</span>
			<button onclick={dismissBanner} class="p-1 rounded hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer" aria-label="Dismiss">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</div>
	{/if}

	<!-- Main content: sidebar + composer/terminal -->
	<div class="flex-1 min-h-0 flex">
		<!-- Sidebar -->
		{#if sidebarOpen}
			<div class="flex-shrink-0 border-r border-hub-border overflow-hidden" style="width: {sidebarWidth}px">
				<div class="h-full flex flex-col">
					<div class="px-3 py-2 border-b border-hub-border">
						<span class="text-[10px] font-medium text-hub-dim uppercase tracking-wider">Existing Playbooks</span>
					</div>
					<div class="flex-1 overflow-y-auto py-1">
						{#each data.existingPlaybooks as pb}
							{@const isStaged = stagedNames.has(pb.name)}
							<button
								onclick={() => stagePlaybook(pb)}
								class="w-full text-left px-3 py-2 text-xs hover:bg-hub-card transition-colors cursor-pointer
									{isStaged ? 'bg-hub-cta/5 border-l-2 border-hub-cta' : ''}"
							>
								<span class="font-medium text-hub-text truncate block">{pb.name}</span>
								<span class="text-[10px] text-hub-dim">{pb.roleCount}R {pb.phaseCount}P</span>
							</button>
						{/each}
						{#if data.existingPlaybooks.length === 0}
							<p class="text-xs text-hub-dim px-3 py-4 text-center">No playbooks found</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- Resize handle -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="flex-shrink-0 w-1 cursor-col-resize hover:bg-hub-cta/30 active:bg-hub-cta/50 transition-colors {resizing ? 'bg-hub-cta/50' : ''}"
				onmousedown={startResize}
			></div>
		{/if}

		<!-- Right pane: composer or terminal -->
		<div class="flex-1 min-w-0 min-h-0 flex flex-col">
			{#if !sessionStarted}
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-2xl mx-auto py-8 px-4 flex flex-col gap-6">
						<!-- Step 1: What are you building? -->
						<div class="bg-hub-surface/30 border border-hub-border rounded-lg p-4">
							<h3 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-3">Step 1: What are you building?</h3>
							<div class="grid grid-cols-3 gap-2">
								{#each buildTypes as bt (bt.value)}
									<button
										onclick={() => (buildType = bt.value)}
										class="p-3 rounded-lg border text-left transition-colors cursor-pointer
											{buildType === bt.value ? 'border-hub-cta bg-hub-cta/5 text-hub-text' : 'border-hub-border text-hub-muted hover:border-hub-dim hover:text-hub-text'}"
									>
										<span class="text-sm font-medium">{bt.label}</span>
									</button>
								{/each}
							</div>

							<!-- Template picker for new playbook -->
							{#if buildType === 'playbook' && data.templates.length > 0}
								<div class="mt-3">
									<span class="text-[10px] font-medium text-hub-dim uppercase tracking-wider">Template</span>
									<div class="flex gap-2 flex-wrap mt-1.5">
										{#each data.templates as tmpl}
											<button
												onclick={() => selectedTemplate = selectedTemplate === tmpl.id ? null : tmpl.id}
												class="px-3 py-1.5 rounded-lg text-xs border transition-colors cursor-pointer
													{selectedTemplate === tmpl.id
														? 'border-hub-cta text-hub-cta bg-hub-cta/10'
														: 'border-hub-border text-hub-dim hover:text-hub-muted'}"
											>
												{tmpl.name}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						</div>

						<!-- Step 2: References (optional) -->
						<div class="bg-hub-surface/30 border border-hub-border rounded-lg p-4">
							<h3 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-3">Step 2: References (optional)</h3>
							{#if stagedPlaybooks.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each stagedPlaybooks as pb (pb.name)}
										<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-hub-cta/10 text-hub-cta border border-hub-cta/20">
											{pb.name}
											<button
												onclick={() => removeStagedPlaybook(pb.name)}
												class="ml-0.5 hover:text-hub-danger transition-colors cursor-pointer"
												aria-label="Remove {pb.name}"
											>
												<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
												</svg>
											</button>
										</span>
									{/each}
								</div>
							{:else}
								<p class="text-xs text-hub-dim">Click playbooks in the sidebar to add references</p>
							{/if}
						</div>

						<!-- Step 3: Describe your goal -->
						<div class="bg-hub-surface/30 border border-hub-border rounded-lg p-4">
							<h3 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-3">Step 3: Describe your goal</h3>
							<textarea
								bind:value={userPrompt}
								placeholder={placeholders[buildType]}
								rows="6"
								class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 resize-y min-h-[120px] max-h-[300px]"
								onkeydown={(e) => {
									if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
										e.preventDefault();
										startSession();
									}
								}}
							></textarea>
						</div>

						<!-- Action buttons -->
						<div class="flex items-center justify-center gap-3">
							<button
								onclick={startSession}
								disabled={!userPrompt.trim() && stagedPlaybooks.length === 0}
								class="px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors cursor-pointer
									{!userPrompt.trim() && stagedPlaybooks.length === 0
										? 'bg-hub-card text-hub-dim cursor-not-allowed'
										: 'bg-hub-cta text-white hover:bg-hub-cta/90'}"
							>
								Start Session
								<span class="text-[10px] opacity-60 ml-1">{'\u2318'}Enter</span>
							</button>
							<button
								onclick={openTerminal}
								class="px-6 py-2.5 rounded-lg text-sm font-medium border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-dim transition-colors cursor-pointer"
							>
								Open Terminal
							</button>
						</div>
					</div>
				</div>
			{:else}
				<!-- Terminal with loading overlay -->
				<div class="flex-1 min-w-0 min-h-0 overflow-hidden relative">
					{#if loading}
						<div class="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0a0f]">
							<div class="text-center">
								<div class="inline-block w-8 h-8 border-2 border-hub-dim border-t-hub-cta rounded-full animate-spin mb-3"></div>
								<p class="text-sm text-hub-muted">Starting Claude...</p>
							</div>
						</div>
					{/if}
					<TerminalTabs
						cwd={data.cwd}
						projectName="_builder"
						initialPrompt={composedPrompt}
						autoStart={true}
						onReady={handleReady}
					/>
				</div>
			{/if}
		</div>
	</div>
</div>
