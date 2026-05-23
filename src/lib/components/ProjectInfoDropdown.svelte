<script lang="ts">
	import { marked } from 'marked';
	import { onMount } from 'svelte';

	interface GitInfo {
		isGit: boolean;
		branch: string | null;
		dirty: boolean;
		uncommittedCount: number;
		recentCommits: { hash: string; message: string; relativeTime: string }[];
	}

	interface Props {
		projectName: string;
		devPath: string | null;
		gitInfo?: GitInfo | null;
	}

	let { projectName, devPath, gitInfo = null }: Props = $props();

	let open = $state(false);
	let readmeContent = $state('');
	let gitLog = $state<string[]>([]);
	let loading = $state(false);

	export function toggle() {
		open = !open;
		if (open && !readmeContent && !gitLog.length) load();
	}

	async function load() {
		loading = true;

		// Try to read README or CLAUDE.md
		if (devPath) {
			for (const name of ['README.md', 'CLAUDE.md', 'readme.md']) {
				try {
					const res = await fetch(`/api/files?path=${encodeURIComponent(devPath)}&action=read&file=${encodeURIComponent(name)}`);
					if (res.ok) {
						const data = await res.json();
						readmeContent = data.content.slice(0, 1500); // First ~1500 chars
						break;
					}
				} catch { /* try next */ }
			}
		}

		loading = false;
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (open && !target.closest('.project-info-dropdown')) {
			open = false;
		}
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div class="relative project-info-dropdown">
	<button
		onclick={() => toggle()}
		class="flex items-center gap-1 cursor-pointer hover:text-hub-cta transition-colors"
	>
		<div>
			<h1 class="text-lg font-bold text-hub-text text-left">{projectName}</h1>
			<p class="text-xs text-hub-dim">{devPath || '~'}</p>
		</div>
		<svg class="w-4 h-4 text-hub-dim transition-transform {open ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="6 9 12 15 18 9"/>
		</svg>
	</button>

	{#if open}
		<div class="absolute top-full left-0 mt-2 w-80 max-h-96 overflow-y-auto bg-hub-surface border border-hub-border rounded-xl shadow-2xl z-40">
			{#if loading}
				<div class="px-4 py-6 text-center text-xs text-hub-dim">Loading project info...</div>
			{:else}
				<!-- README/CLAUDE.md snippet -->
				{#if readmeContent}
					<div class="px-4 py-3 border-b border-hub-border/50">
						<h3 class="text-[10px] text-hub-dim uppercase tracking-wider mb-2">README</h3>
						<div class="prose-hub text-xs max-h-40 overflow-y-auto">
							{@html marked.parse(readmeContent + (readmeContent.length >= 1500 ? '\n\n...' : ''), { async: false })}
						</div>
					</div>
				{/if}

				<!-- Git info -->
				{#if gitInfo?.isGit}
					<div class="px-4 py-3 border-b border-hub-border/50">
						<h3 class="text-[10px] text-hub-dim uppercase tracking-wider mb-2">Git</h3>
						<!-- Branch + dirty -->
						<div class="flex items-center gap-2 mb-2">
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-hub-purple/10 text-hub-purple text-[11px] font-mono">
								{gitInfo.branch || 'detached'}
							</span>
							{#if gitInfo.dirty}
								<span class="flex items-center gap-1 text-[11px] text-hub-warning">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-warning"></span>
									{gitInfo.uncommittedCount} uncommitted
								</span>
							{/if}
						</div>
						<!-- Recent commits -->
						{#if gitInfo.recentCommits.length > 0}
							<div class="space-y-1">
								{#each gitInfo.recentCommits as commit}
									<div class="flex items-baseline gap-2 text-[11px]">
										<span class="text-hub-dim font-mono flex-shrink-0">{commit.hash}</span>
										<span class="text-hub-muted truncate flex-1">{commit.message}</span>
										<span class="text-hub-dim flex-shrink-0">{commit.relativeTime}</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Paths -->
				<div class="px-4 py-3">
					<h3 class="text-[10px] text-hub-dim uppercase tracking-wider mb-2">Paths</h3>
					{#if devPath}
						<div class="flex items-center gap-1.5 text-xs text-hub-muted mb-1">
							<svg class="w-3 h-3 text-hub-cta/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
							<span class="font-mono truncate">{devPath}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
