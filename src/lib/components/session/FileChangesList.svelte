<script lang="ts">
	import type { FileSnapshot } from '$lib/sessions/types.js';

	interface Props {
		filesTouched: string[];
		fileSnapshots: FileSnapshot[];
	}

	let { filesTouched, fileSnapshots }: Props = $props();

	// snapshot count per file path — gives a sense of how many times a file was checkpointed
	const snapshotCounts = $derived.by(() => {
		const m = new Map<string, number>();
		for (const snap of fileSnapshots) {
			for (const p of snap.paths) m.set(p, (m.get(p) ?? 0) + 1);
		}
		return m;
	});

	function shortPath(p: string): string {
		return p.startsWith('/Users/') ? '~/' + p.split('/').slice(3).join('/') : p;
	}

	function dirOf(p: string): string {
		return p.substring(0, p.lastIndexOf('/'));
	}

	function nameOf(p: string): string {
		return p.substring(p.lastIndexOf('/') + 1);
	}
</script>

{#if filesTouched.length === 0}
	<p class="text-xs text-hub-dim py-6 text-center">No files touched in this session.</p>
{:else}
	<div class="space-y-1">
		<p class="text-[11px] text-hub-dim mb-2">{filesTouched.length} file{filesTouched.length === 1 ? '' : 's'} touched</p>
		{#each filesTouched as path}
			{@const count = snapshotCounts.get(path) ?? 0}
			<a
				href="/files?path={encodeURIComponent(path)}"
				class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
				title={path}
			>
				<svg class="w-3.5 h-3.5 text-hub-cta/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
				</svg>
				<span class="text-xs text-hub-text font-mono truncate group-hover:text-hub-cta transition-colors">{nameOf(path)}</span>
				<span class="text-[10px] text-hub-dim/70 truncate flex-1 font-mono">{shortPath(dirOf(path))}</span>
				{#if count > 0}
					<span class="text-[10px] text-hub-dim flex-shrink-0">{count} snapshot{count === 1 ? '' : 's'}</span>
				{/if}
			</a>
		{/each}
	</div>
{/if}
