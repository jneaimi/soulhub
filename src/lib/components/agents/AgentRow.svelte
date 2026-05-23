<script lang="ts">
	import StatusPill from '$lib/components/scheduler/StatusPill.svelte';
	import BackendBadge from './BackendBadge.svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';
	type Provenance = 'builtin' | 'user-created' | 'external';
	type Lane = 'A' | 'B';
	type Health = 'ready' | 'unhealthy' | 'unknown';

	interface AgentStats {
		totalRuns: number;
		totalCostUsd: number;
		totalTurns: number;
		successRate: number;
		lastRunAt: number | null;
		lastStatus: string | null;
	}

	interface AgentSummary {
		id: string;
		name: string;
		description: string;
		backend: Backend;
		model?: string;
		provider?: string;
		tools: string[];
		skills: string[];
		provenance: Provenance;
		lane: Lane;
		health: Health;
		health_reason?: string;
		source_path: string;
		system_prompt: string;
		chat_dispatchable?: boolean;
		stats?: AgentStats | null;
	}

	interface Props {
		agent: AgentSummary;
		expanded?: boolean;
		onToggleExpand?: () => void;
		deleteConfirming?: boolean;
		onDelete?: () => void;
	}

	const {
		agent,
		expanded = false,
		onToggleExpand,
		deleteConfirming = false,
		onDelete,
	}: Props = $props();

	const provenanceLabel: Record<Provenance, string> = {
		builtin: 'Builtin',
		'user-created': 'Custom',
		external: 'External',
	};

	const provenanceColor: Record<Provenance, string> = {
		builtin: 'text-hub-purple',
		'user-created': 'text-hub-cta',
		external: 'text-hub-dim',
	};

	function relTime(ms: number): string {
		const diff = Date.now() - ms;
		const min = 60_000;
		const hr = 60 * min;
		const day = 24 * hr;
		if (diff < min) return 'just now';
		if (diff < hr) return `${Math.floor(diff / min)}m ago`;
		if (diff < day) return `${Math.floor(diff / hr)}h ago`;
		if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
		return new Date(ms).toISOString().slice(0, 10);
	}

	function fmtCost(usd: number): string {
		if (!usd) return '$0';
		if (usd < 0.01) return '<$0.01';
		if (usd < 1) return `$${usd.toFixed(2)}`;
		return `$${usd.toFixed(2)}`;
	}

	const statusColor: Record<string, string> = {
		success: 'text-hub-cta',
		error: 'text-hub-danger',
		cancelled: 'text-hub-muted',
		timeout: 'text-hub-warning',
		'budget-exceeded': 'text-hub-warning',
	};
</script>

<div class="bg-hub-card rounded-xl border border-hub-border overflow-hidden">
	<div class="px-4 py-3 grid grid-cols-1 md:grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-start md:items-center">
		<!-- Status pill -->
		<div class="md:pr-2">
			<StatusPill state={agent.health === 'ready' ? 'ready' : 'unhealthy'} size="sm" />
		</div>

		<!-- Name + provenance + description -->
		<div class="min-w-0">
			<div class="flex items-center gap-2 mb-0.5 flex-wrap">
				<h3 class="text-sm font-semibold text-hub-text truncate">{agent.id}</h3>
				<span class="text-[10px] {provenanceColor[agent.provenance]} flex-shrink-0">
					{provenanceLabel[agent.provenance]}
				</span>
				<BackendBadge backend={agent.backend} size="sm" />
				<span
					class="text-[10px] text-hub-dim font-mono px-1.5 py-0.5 bg-hub-bg rounded border border-hub-border/60 flex-shrink-0"
					title="Storage lane"
				>
					Lane {agent.lane}
				</span>
				{#if agent.health_reason?.startsWith('shadowed')}
					<span
						class="text-[10px] text-hub-warning font-medium px-1.5 py-0.5 bg-hub-warning/10 rounded border border-hub-warning/40 flex-shrink-0"
						title={agent.health_reason}
					>
						⚠ shadowed
					</span>
				{/if}
				{#if agent.chat_dispatchable}
					<span
						class="text-[10px] text-hub-cta font-medium px-1.5 py-0.5 bg-hub-cta/10 rounded border border-hub-cta/40 flex-shrink-0"
						title="The WhatsApp orchestrator may dispatch this agent from chat (ADR-005)."
					>
						💬 chat
					</span>
				{/if}
			</div>
			{#if agent.description}
				<p class="text-xs text-hub-muted truncate" title={agent.description}>{agent.description}</p>
			{/if}
		</div>

		<!-- Model -->
		<div class="text-xs text-hub-muted min-w-[120px] font-mono">
			{#if agent.model}
				{agent.model}
			{:else}
				<span class="text-hub-dim">—</span>
			{/if}
			{#if agent.provider}
				<div class="text-[10px] text-hub-dim mt-0.5">{agent.provider}</div>
			{/if}
		</div>

		<!-- Skills/tools count -->
		<div class="text-[11px] text-hub-muted min-w-[120px]">
			<div>{agent.skills.length} skill{agent.skills.length === 1 ? '' : 's'}</div>
			<div class="text-hub-dim text-[10px]">{agent.tools.length} tool{agent.tools.length === 1 ? '' : 's'}</div>
		</div>

		<!-- Lifetime stats -->
		<a
			href="/orchestration/agents/{encodeURIComponent(agent.id)}/runs"
			class="text-[11px] text-hub-muted hover:text-hub-text min-w-[110px] block group cursor-pointer"
			title="Open run history"
		>
			{#if agent.stats && agent.stats.totalRuns > 0}
				<div class="flex items-center gap-1.5">
					<span class="font-medium {statusColor[agent.stats.lastStatus ?? ''] ?? 'text-hub-text'}">
						{agent.stats.totalRuns}
					</span>
					<span class="text-hub-dim text-[10px]">run{agent.stats.totalRuns === 1 ? '' : 's'}</span>
				</div>
				<div class="text-hub-dim text-[10px] mt-0.5">
					{agent.stats.lastRunAt ? relTime(agent.stats.lastRunAt) : '—'}
					{#if agent.stats.totalCostUsd > 0}
						· {fmtCost(agent.stats.totalCostUsd)}
					{/if}
				</div>
			{:else}
				<div class="text-hub-dim text-[10px] group-hover:text-hub-muted">never run</div>
			{/if}
		</a>

		<!-- Actions -->
		<div class="flex items-center gap-1.5 flex-shrink-0">
			<a
				href="/orchestration/agents/{encodeURIComponent(agent.id)}/test"
				class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-info hover:text-hub-text hover:bg-hub-info/10 transition-colors cursor-pointer"
				title="Test in chat"
			>
				▶ Test
			</a>
			<a
				href="/orchestration/agents/{encodeURIComponent(agent.id)}/runs"
				class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
				title="Run history"
			>
				⏱ Runs
			</a>
			<a
				href="/orchestration/agents/{encodeURIComponent(agent.id)}/edit"
				class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
				title="Edit agent"
			>
				✎ Edit
			</a>
			{#if onDelete}
				<button
					type="button"
					onclick={onDelete}
					class="px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
						{deleteConfirming
							? 'bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25'
							: 'text-hub-dim hover:text-hub-danger hover:bg-hub-danger/10'}"
					title={deleteConfirming ? 'Click again to confirm delete' : 'Delete agent'}
				>
					{deleteConfirming ? '✕ Confirm?' : '× Delete'}
				</button>
			{/if}
			<button
				type="button"
				onclick={onToggleExpand}
				class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
				title={expanded ? 'Hide details' : 'Show system prompt + skills'}
				aria-expanded={expanded}
			>
				{expanded ? '↓ Hide' : '↗ Details'}
			</button>
		</div>
	</div>

	<!-- Expanded panel -->
	{#if expanded}
		<div class="bg-hub-bg/50 border-t border-hub-border/60 px-4 py-3 space-y-3">
			{#if agent.skills.length > 0}
				<div>
					<div class="text-[10px] uppercase tracking-wide text-hub-dim font-medium mb-1">
						Skills
					</div>
					<div class="flex flex-wrap gap-1">
						{#each agent.skills as skill (skill)}
							<span class="text-[10px] font-mono px-1.5 py-0.5 bg-hub-card text-hub-muted rounded border border-hub-border/60">
								{skill}
							</span>
						{/each}
					</div>
				</div>
			{/if}
			{#if agent.tools.length > 0}
				<div>
					<div class="text-[10px] uppercase tracking-wide text-hub-dim font-medium mb-1">
						Tools
					</div>
					<div class="flex flex-wrap gap-1">
						{#each agent.tools as tool (tool)}
							<span class="text-[10px] font-mono px-1.5 py-0.5 bg-hub-card text-hub-muted rounded border border-hub-border/60">
								{tool}
							</span>
						{/each}
					</div>
				</div>
			{/if}
			{#if agent.system_prompt}
				<div>
					<div class="text-[10px] uppercase tracking-wide text-hub-dim font-medium mb-1">
						System prompt
					</div>
					<pre class="text-[11px] text-hub-muted font-mono bg-hub-card border border-hub-border/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">{agent.system_prompt}</pre>
				</div>
			{/if}
			<div class="text-[10px] text-hub-dim font-mono truncate" title={agent.source_path}>
				source: {agent.source_path}
			</div>
		</div>
	{/if}
</div>
