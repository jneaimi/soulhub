<script lang="ts">
	import { onMount } from 'svelte';

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let counts = $state({ agents: 0, skills: 0, tools: 0, recent: 0 });

	async function load() {
		try {
			const [agentsRes, skillsRes, toolsRes] = await Promise.all([
				fetch('/api/agents'),
				fetch('/api/skills'),
				fetch('/api/orchestrator/tools'),
			]);
			const [agentsData, skillsData, toolsData] = await Promise.all([
				agentsRes.json(),
				skillsRes.json(),
				toolsRes.json(),
			]);
			counts = {
				agents: (agentsData.agents ?? []).length,
				skills: (skillsData.skills ?? skillsData.installed ?? []).length,
				tools: toolsData.count ?? (toolsData.tools ?? []).length,
				recent: (toolsData.recent_calls ?? []).length,
			};
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const SECTIONS = [
		{
			href: '/orchestration/agents',
			title: 'Agents',
			blurb:
				'Long-running specialists the orchestrator can dispatch via dispatchAgent. Each agent has a system prompt, model, and chat-dispatchable flag.',
		},
		{
			href: '/orchestration/skills',
			title: 'Skills',
			blurb:
				'Synchronous tools the orchestrator can invoke via invokeSkill. Sourced from ~/.claude/skills/ + per-skill chat overlay.',
		},
		{
			href: '/orchestration/tools',
			title: 'Tools',
			blurb:
				'The fixed set of primitive actions exposed to the orchestrator-v2 LLM each turn (reply, vaultSearch, generateImage, dispatchAgent, invokeSkill, etc).',
		},
		{
			href: '/orchestration/metrics',
			title: 'Metrics',
			blurb:
				'ADR-005 falsifier dashboard — recent orchestrator decisions, dispatch outcomes, abstention rates, and agent run history.',
		},
		{
			href: '/orchestration/audit',
			title: 'Audit',
			blurb:
				'Append-only agent_actions log (ADR-L3 §D7 G2) — every Layer 3 tool invocation with filters, byTool histogram, and the L3 confirmation-gate trust-trainer panel.',
		},
		{
			href: '/orchestration/intent',
			title: 'Intent',
			blurb:
				'ADR-023 router intelligence — intent_log source distribution, learned-pattern hits, P2/P3 gate status, and the analyst proposal approval queue.',
		},
	];
</script>

<svelte:head>
	<title>Orchestration · Soul Hub</title>
</svelte:head>

<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
	<div class="max-w-6xl mx-auto w-full space-y-6">
		<div>
			<h1 class="text-xl font-semibold text-hub-text">Orchestration</h1>
			<p class="text-sm text-hub-muted mt-1 max-w-3xl">
				All dispatchable layers of the orchestrator-v2 LLM, plus the metrics dashboard for what
				it's been doing. Agents are long-running specialists; skills are synchronous tools;
				tools are the primitive actions the LLM picks from each turn.
			</p>
		</div>

		{#if loadError}
			<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
				Failed to load counts: {loadError}
			</div>
		{/if}

		<!-- 4-stat row -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
			{#each [
				{ label: 'Agents', value: counts.agents, href: '/orchestration/agents' },
				{ label: 'Skills', value: counts.skills, href: '/orchestration/skills' },
				{ label: 'Tools', value: counts.tools, href: '/orchestration/tools' },
				{ label: 'Recent', value: counts.recent, href: '/orchestration/metrics' },
			] as stat}
				<a
					href={stat.href}
					class="rounded-lg border border-hub-border bg-hub-card px-4 py-3 hover:border-hub-info transition-colors group"
				>
					<div class="text-2xl font-semibold text-hub-text group-hover:text-hub-info transition-colors">
						{loading ? '…' : stat.value}
					</div>
					<div class="text-[11px] uppercase tracking-wide text-hub-muted mt-0.5">
						{stat.label}
					</div>
				</a>
			{/each}
		</div>

		<!-- Section cards -->
		<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
			{#each SECTIONS as section}
				<a
					href={section.href}
					class="rounded-lg border border-hub-border bg-hub-card p-4 hover:border-hub-info transition-colors group"
				>
					<div class="flex items-center justify-between">
						<h2 class="text-sm font-semibold text-hub-text group-hover:text-hub-info transition-colors">
							{section.title}
						</h2>
						<svg class="w-4 h-4 text-hub-muted group-hover:text-hub-info transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>
					</div>
					<p class="text-xs text-hub-muted mt-2 leading-relaxed">{section.blurb}</p>
				</a>
			{/each}
		</div>
	</div>
</main>
