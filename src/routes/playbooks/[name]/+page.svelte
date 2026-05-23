<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import PlaybookPrereqs from '$lib/components/playbook/PlaybookPrereqs.svelte';
	import PlaybookRoles from '$lib/components/playbook/PlaybookRoles.svelte';
	import PlaybookInputs from '$lib/components/playbook/PlaybookInputs.svelte';
	import PlaybookRunner from '$lib/components/playbook/PlaybookRunner.svelte';

	interface PlaybookInput {
		id: string;
		type: string;
		description?: string;
		required?: boolean;
		default?: string | number;
		options?: string[];
	}

	interface PhaseDetail {
		id: string;
		type: string;
		depends_on?: string[];
		prompt?: string;
		assignments?: { role: string; output: string }[];
	}

	let { data } = $props<{ data: { inputs: PlaybookInput[]; phases: PhaseDetail[] } }>();

	const specInputs = $derived(data.inputs || []);
	const specPhases = $derived(data.phases || []);
	const playbookName = $derived(decodeURIComponent($page.params.name || ''));

	const phaseTypeColors: Record<string, string> = {
		sequential: 'bg-hub-info/15 text-hub-info',
		parallel: 'bg-hub-purple/15 text-hub-purple',
		handoff: 'bg-hub-warning/15 text-hub-warning',
		human: 'bg-hub-cta/15 text-hub-cta',
		gate: 'bg-hub-danger/15 text-hub-danger',
		consensus: 'bg-hub-dim/15 text-hub-dim',
	};

	let config = $state<any>(null);
	let providers = $state<Record<string, boolean>>({});
	let loading = $state(true);
	let loadError = $state('');
	let inputValues = $state<Record<string, string | number>>({});
	let prereqsMet = $state(true);

	// Run state (bound from PlaybookRunner)
	let isRunning = $state(false);
	let runElapsed = $state('');
	let runStatus = $state('');
	let runner: any = $state(null);

	function canRun(): boolean {
		if (isRunning || !prereqsMet || !config) return false;
		for (const inp of specInputs) {
			if (inp.required !== false && !inputValues[inp.id]) return false;
		}
		return true;
	}

	async function loadConfig() {
		try {
			const res = await fetch('/api/playbooks');
			if (!res.ok) throw new Error('Failed to load playbooks');
			const data = await res.json();
			const found = (data.playbooks || []).find((p: any) => {
				const dirN = p.dir.split('/').pop();
				return dirN === playbookName || p.name === playbookName;
			});
			if (!found) throw new Error(`Playbook "${playbookName}" not found`);
			config = found;
			providers = data.providers || {};

			// Set defaults from server-loaded input definitions
			for (const inp of specInputs) {
				if (inp.default !== undefined && inputValues[inp.id] === undefined) {
					inputValues[inp.id] = inp.default;
				}
			}
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	onMount(loadConfig);
</script>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto flex items-center gap-3">
			<a href="/playbooks" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors duration-200 cursor-pointer" aria-label="Back to playbooks">
				<svg class="w-4 h-4 text-hub-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</a>
			<span class="text-xs text-hub-dim">Playbooks</span>
			{#if config}
				<h1 class="text-lg font-semibold text-hub-text truncate">{config.name}</h1>
				{#if config.hasHooks}
					<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple">hooks</span>
				{/if}
				{#if config.timeoutStrategy === 'auto'}
					<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-cta/15 text-hub-cta">auto-timeout</span>
				{/if}

				<!-- Edit / Run / Stop controls in header -->
				<div class="ml-auto flex items-center gap-2">
					{#if !isRunning && runStatus !== 'completed' && runStatus !== 'failed'}
						<a
							href="/playbooks/builder?playbook={encodeURIComponent(playbookName)}"
							class="px-3 py-1.5 rounded-lg text-xs font-medium text-hub-muted border border-hub-border hover:border-hub-dim transition-colors duration-200 cursor-pointer"
						>
							Edit
						</a>
					{/if}
					{#if isRunning}
						<svg class="w-3.5 h-3.5 text-hub-cta animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
						</svg>
						<span class="text-xs text-hub-cta">Running</span>
						<span class="text-xs text-hub-dim">{runElapsed}</span>
						<button
							onclick={() => runner?.stop()}
							class="px-4 py-1.5 rounded-lg text-xs font-medium text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/10 transition-colors duration-200 cursor-pointer"
						>
							Stop
						</button>
					{:else if runStatus === 'completed' || runStatus === 'failed'}
						<!-- show nothing in header after completion -->
					{:else}
						<button
							onclick={() => runner?.start()}
							disabled={!canRun()}
							class="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors duration-200
								{canRun()
									? 'bg-hub-cta text-black hover:bg-hub-cta-hover cursor-pointer'
									: 'bg-hub-border text-hub-dim cursor-not-allowed'}"
						>
							Run Playbook
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto space-y-5">
			<!-- Loading -->
			{#if loading}
				<div class="flex items-center justify-center py-16">
					<svg class="w-5 h-5 text-hub-info animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
					<span class="ml-2 text-sm text-hub-dim">Loading playbook...</span>
				</div>

			<!-- Error -->
			{:else if loadError}
				<div class="border border-hub-danger/30 bg-hub-danger/5 rounded-lg p-4 text-sm text-hub-danger">
					{loadError}
				</div>

			<!-- Config loaded -->
			{:else if config}
				<!-- Description -->
				{#if config.description}
					<p class="text-sm text-hub-muted">{config.description}</p>
				{/if}

				<PlaybookPrereqs
					prerequisites={config.prerequisites || []}
					{playbookName}
					bind:allMet={prereqsMet}
				/>

				<PlaybookRoles roles={config.roles} {providers} />

				<!-- Phases (static spec from server) -->
				<section>
					<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Phases</h2>
					<div class="border border-hub-border rounded-lg divide-y divide-hub-border/50">
						{#each specPhases as phase, i}
							<div class="px-3 py-2.5">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="text-xs text-hub-dim w-4">{i + 1}.</span>
									<span class="text-sm text-hub-text font-medium">{phase.id}</span>
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {phaseTypeColors[phase.type] || 'bg-hub-dim/15 text-hub-dim'}">
										{phase.type}
									</span>
									{#if phase.depends_on?.length}
										<span class="text-[10px] text-hub-dim">
											depends: {phase.depends_on.join(', ')}
										</span>
									{/if}
								</div>
								{#if phase.assignments?.length}
									<div class="mt-1.5 ml-6 space-y-0.5">
										{#each phase.assignments as a}
											<div class="text-xs text-hub-dim flex items-center gap-1.5">
												<span class="text-hub-muted">{a.role}</span>
												<span class="text-hub-dim/60">-></span>
												<span class="font-mono text-hub-dim/80">{a.output}</span>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>

				<PlaybookInputs
					inputs={specInputs}
					bind:values={inputValues}
				/>

				<PlaybookRunner
					bind:this={runner}
					{playbookName}
					{inputValues}
					disabled={!prereqsMet}
					configPhases={config.phases}
					{specInputs}
					bind:isRunning
					bind:runElapsed
					bind:runStatus
				/>
			{/if}
		</div>
	</div>
</div>
