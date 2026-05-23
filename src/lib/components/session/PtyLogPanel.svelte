<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		ptyId: string;
	}

	let { ptyId }: Props = $props();

	interface PtyMeta {
		id: string;
		prompt?: string;
		cwd?: string;
		pid?: number;
		status?: string;
		startedAt?: string;
		endedAt?: string;
		logSize?: number;
		alive?: boolean;
		log?: string;
	}

	let loading = $state(true);
	let error = $state('');
	let meta = $state<PtyMeta | null>(null);

	async function load() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(ptyId)}?logBytes=16384`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			meta = await res.json();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function fmtBytes(n: number | undefined): string {
		if (!n) return '0 B';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}

	function shortCwd(p: string | undefined): string {
		if (!p) return '—';
		if (p.startsWith('/Users/jneaimi/')) return '~/' + p.split('/').slice(3).join('/');
		return p;
	}
</script>

<div class="h-full flex flex-col bg-[#0a0a0f] text-hub-text">
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-sm text-hub-dim">Loading PTY session…</p>
		</div>
	{:else if error}
		<div class="flex-1 flex items-center justify-center p-6">
			<div class="text-center max-w-md">
				<p class="text-sm text-hub-danger mb-2">Failed to load: {error}</p>
				<button onclick={load} class="text-xs text-hub-info hover:text-hub-text cursor-pointer">Retry</button>
			</div>
		</div>
	{:else if meta}
		<!-- Header summary -->
		<div class="flex-shrink-0 px-4 py-3 border-b border-hub-border/40 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Status</div>
				<div class="text-hub-text font-mono">{meta.status ?? '—'}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cwd</div>
				<div class="text-hub-text font-mono truncate" title={meta.cwd}>{shortCwd(meta.cwd)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Log size</div>
				<div class="text-hub-text font-mono">{fmtBytes(meta.logSize)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">PID</div>
				<div class="text-hub-text font-mono">{meta.pid ?? '—'}{meta.alive ? '' : ' (dead)'}</div>
			</div>
		</div>

		<!-- Body: prompt + log -->
		<div class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
			{#if meta.prompt && meta.prompt.trim()}
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider mb-1">Prompt</div>
					<pre class="text-xs text-hub-muted whitespace-pre-wrap font-mono bg-hub-bg/40 border border-hub-border/40 rounded p-2 max-h-48 overflow-y-auto">{meta.prompt}</pre>
				</div>
			{/if}

			{#if meta.log && meta.log.length > 0}
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider mb-1">Log tail ({fmtBytes(meta.log.length)})</div>
					<pre class="text-[11px] text-hub-text whitespace-pre-wrap font-mono bg-black/40 border border-hub-border/40 rounded p-2 max-h-72 overflow-y-auto">{meta.log}</pre>
				</div>
			{:else}
				<div class="text-[11px] text-hub-dim italic">No terminal output recorded for this session.</div>
			{/if}

			<div class="text-[10px] text-hub-dim italic pt-1">
				No Claude Code session matched this PTY — Claude was either never started, recorded under a different cwd, or this was a shell-only session.
			</div>
		</div>
	{/if}
</div>
