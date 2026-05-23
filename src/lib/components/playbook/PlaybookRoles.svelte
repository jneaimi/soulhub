<script lang="ts">
	interface PlaybookRole {
		id: string;
		provider: string;
		model?: string;
		skills?: string[];
		mcp?: string[];
	}

	let { roles = [], providers = {} } = $props<{
		roles: PlaybookRole[];
		providers: Record<string, boolean>;
	}>();
</script>

<section>
	<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Roles</h2>
	<div class="border border-hub-border rounded-lg divide-y divide-hub-border/50">
		{#each roles as role}
			<div class="px-3 py-2 flex items-center gap-2">
				<span class="text-sm text-hub-text font-medium">{role.id}</span>
				<span class="text-xs text-hub-dim">
					{role.provider}{role.model ? `/${role.model}` : ''}
				</span>
				{#if role.skills?.length}
					{#each role.skills as skill}
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple">{skill}</span>
					{/each}
				{/if}
				{#if role.mcp?.length}
					{#each role.mcp as server}
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-info/15 text-hub-info">{server}</span>
					{/each}
				{/if}
				{#if providers[role.provider] !== undefined}
					<span class="ml-auto w-2 h-2 rounded-full {providers[role.provider] ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
				{/if}
			</div>
		{/each}
	</div>
</section>
