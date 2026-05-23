<script lang="ts">
	import { onMount } from 'svelte';

	interface Prereq {
		name: string;
		check: string;
		install?: string;
		required?: boolean;
	}

	interface PrereqResult {
		name: string;
		available: boolean;
		required: boolean;
	}

	let { prerequisites = [], playbookName = '', allMet = $bindable(true) } = $props<{
		prerequisites: Prereq[];
		playbookName: string;
		allMet: boolean;
	}>();

	let results = $state<PrereqResult[]>([]);
	let checking = $state(false);
	let checked = $state(false);

	const computedAllMet = $derived(results.length === 0 || results.every(r => !r.required || r.available));

	// Sync bindable prop with computed value
	$effect(() => { allMet = computedAllMet; });
	const missingRequired = $derived(results.filter(r => r.required && !r.available));

	async function check() {
		checking = true;
		try {
			const res = await fetch('/api/playbooks/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'check_prereqs', playbook: playbookName }),
			});
			if (res.ok) {
				const data = await res.json();
				results = data.prerequisites || [];
				checked = true;
			}
		} catch { /* silent */ }
		finally { checking = false; }
	}

	onMount(() => { if (prerequisites.length > 0) check(); });
</script>

{#if prerequisites.length > 0}
	<section>
		<h3 class="text-hub-dim text-xs uppercase tracking-wider mb-2">Prerequisites</h3>
		{#if missingRequired.length > 0}
			<div class="border border-hub-danger/30 bg-hub-danger/5 rounded-lg px-3 py-2 mb-2 text-xs text-hub-danger">
				{missingRequired.length} required prerequisite{missingRequired.length > 1 ? 's' : ''} missing — run is blocked
			</div>
		{/if}
		<div class="space-y-1">
			{#each prerequisites as prereq}
				{@const result = results.find(r => r.name === prereq.name)}
				<div class="flex items-center gap-2 text-sm">
					{#if checking}
						<span class="w-2 h-2 rounded-full bg-hub-border animate-pulse"></span>
					{:else if result}
						<span class="w-2 h-2 rounded-full {result.available ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
					{:else}
						<span class="w-2 h-2 rounded-full bg-hub-border"></span>
					{/if}
					<span class="text-hub-text">{prereq.name}</span>
					{#if prereq.required === false}
						<span class="text-[10px] text-hub-dim">(optional)</span>
					{/if}
					{#if result && !result.available && prereq.install}
						<span class="text-[10px] text-hub-warning">{prereq.install}</span>
					{/if}
				</div>
			{/each}
		</div>
		{#if checked}
			<button
				onclick={check}
				class="mt-2 text-[10px] text-hub-dim hover:text-hub-muted transition-colors duration-200 cursor-pointer"
			>
				Re-check
			</button>
		{/if}
	</section>
{/if}
