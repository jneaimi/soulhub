<script lang="ts">
	import { onMount } from 'svelte';
	import ChatSkillRow from '$lib/components/skills/ChatSkillRow.svelte';

	type InvocationKind = 'script' | 'prompt-injection' | 'cli-subsession';

	interface SkillOverlay {
		name: string;
		chat_invokable: boolean;
		display_name?: string;
		chat_description: string;
		invocation: {
			kind: InvocationKind;
			cmd?: string[];
			cwd?: string;
			timeout_ms?: number;
			max_bytes?: number;
			extra_args?: string[];
		};
		examples?: { args: string; description: string }[];
		provenance?: 'user-created' | 'seed-roster' | 'discovered';
	}

	interface SkillEnriched {
		id: string;
		name: string;
		description: string;
		body_lines: number;
		has_scripts: boolean;
		has_references: boolean;
		is_symlink: boolean;
		source_path: string;
		modified_at: number;
		chat_overlay: SkillOverlay | null;
	}

	type FilterMode = 'all' | 'invokable' | 'has-overlay' | 'no-overlay';

	let skills = $state<SkillEnriched[]>([]);
	let dir = $state('');
	let count = $state(0);
	let chatInvokableCount = $state(0);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<FilterMode>('invokable');
	let search = $state('');
	let expandedIds = $state(new Set<string>());
	let busyIds = $state(new Set<string>());
	let toast = $state<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

	function flashToast(kind: 'success' | 'error' | 'info', text: string) {
		toast = { kind, text };
		setTimeout(() => {
			toast = null;
		}, 3500);
	}

	async function loadSkills() {
		try {
			const res = await fetch('/api/skills');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			skills = data.skills ?? [];
			dir = data.dir ?? '';
			count = data.count ?? 0;
			chatInvokableCount = data.chat_invokable_count ?? 0;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	async function saveOverlay(id: string, overlay: SkillOverlay) {
		busyIds = new Set([...busyIds, id]);
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(id)}/overlay`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(overlay),
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
				throw new Error(errBody.message ?? errBody.error ?? `HTTP ${res.status}`);
			}
			flashToast('success', `Saved overlay for ${id}`);
			await loadSkills();
		} catch (err) {
			flashToast('error', `Save failed: ${(err as Error).message}`);
		} finally {
			busyIds = new Set([...busyIds].filter((x) => x !== id));
		}
	}

	async function deleteOverlay(id: string) {
		busyIds = new Set([...busyIds, id]);
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(id)}/overlay`, {
				method: 'DELETE',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			flashToast('info', `Removed overlay for ${id}`);
			await loadSkills();
		} catch (err) {
			flashToast('error', `Remove failed: ${(err as Error).message}`);
		} finally {
			busyIds = new Set([...busyIds].filter((x) => x !== id));
		}
	}

	async function testSkill(id: string, args: string) {
		try {
			const trimmed = args.trim();
			const body = trimmed
				? trimmed.startsWith('{') || trimmed.startsWith('[')
					? { args: JSON.parse(trimmed) }
					: { args: trimmed }
				: {};
			const res = await fetch(`/api/skills/${encodeURIComponent(id)}/test`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
				return { ok: false, error: errBody.message ?? errBody.error ?? `HTTP ${res.status}`, durationMs: 0 };
			}
			return await res.json();
		} catch (err) {
			return { ok: false, error: (err as Error).message, durationMs: 0 };
		}
	}

	async function rediscover() {
		loading = true;
		try {
			const res = await fetch('/api/skills/discover', { method: 'POST' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			skills = data.skills ?? [];
			count = data.count ?? 0;
			chatInvokableCount = data.chat_invokable_count ?? 0;
			flashToast('info', `Re-scanned: ${data.count} skills (${data.chat_invokable_count} chat-invokable)`);
		} catch (err) {
			flashToast('error', `Re-scan failed: ${(err as Error).message}`);
		} finally {
			loading = false;
		}
	}

	function toggleExpand(id: string) {
		if (expandedIds.has(id)) {
			const next = new Set(expandedIds);
			next.delete(id);
			expandedIds = next;
		} else {
			expandedIds = new Set([...expandedIds, id]);
		}
	}

	const filteredSkills = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return skills.filter((s) => {
			if (filter === 'invokable' && !s.chat_overlay?.chat_invokable) return false;
			if (filter === 'has-overlay' && !s.chat_overlay) return false;
			if (filter === 'no-overlay' && s.chat_overlay) return false;
			if (q) {
				const haystack = `${s.id} ${s.name} ${s.description} ${s.chat_overlay?.chat_description ?? ''}`.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			return true;
		});
	});

	const summary = $derived({
		total: skills.length,
		invokable: skills.filter((s) => s.chat_overlay?.chat_invokable).length,
		configured: skills.filter((s) => s.chat_overlay).length,
		seed: skills.filter((s) => s.chat_overlay?.provenance === 'seed-roster').length,
	});

	onMount(() => {
		loadSkills();
	});
</script>

<svelte:head>
	<title>Chat Skills · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<div class="flex items-center gap-2">
				<span class="text-lg">💬</span>
				<h1 class="text-lg font-semibold text-hub-text">Chat Skills</h1>
				<span class="text-[11px] text-hub-dim font-mono">ADR-009 §7</span>
			</div>
			<div class="flex-1"></div>
			<button
				type="button"
				onclick={rediscover}
				disabled={loading}
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer disabled:opacity-50"
				title="Force re-scan ~/.claude/skills/"
			>
				↻ Discover
			</button>
			<a
				href="/orchestration/skills/install"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="Install / uninstall skills from ~/.claude/skills/"
			>
				Install / manage
			</a>
			<a
				href="/orchestration/agents"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			>
				Agents
			</a>
		</div>
	</header>

	<!-- Summary strip -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-hub-muted">
			<span><span class="text-hub-text font-medium">{summary.total}</span> installed</span>
			<span class="text-hub-dim">·</span>
			<span><span class="text-hub-cta font-medium">{summary.invokable}</span> chat-invokable</span>
			<span class="text-hub-dim">·</span>
			<span><span class="text-hub-warning font-medium">{summary.configured - summary.invokable}</span> configured but disabled</span>
			{#if summary.seed > 0}
				<span class="text-hub-dim">·</span>
				<span><span class="text-hub-purple font-medium">{summary.seed}</span> seed</span>
			{/if}
			<span class="text-hub-dim">·</span>
			<span class="text-hub-dim font-mono truncate" title={dir}>{dir}</span>
		</div>
	</div>

	<!-- Filter + search -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap gap-2 items-center">
			{#each [
				{ id: 'invokable', label: '💬 Chat-invokable', count: summary.invokable },
				{ id: 'has-overlay', label: 'Has overlay', count: summary.configured },
				{ id: 'no-overlay', label: 'No overlay', count: summary.total - summary.configured },
				{ id: 'all', label: 'All', count: summary.total },
			] as f (f.id)}
				<button
					type="button"
					onclick={() => (filter = f.id as FilterMode)}
					class="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
						{filter === f.id
							? 'bg-hub-cta/15 text-hub-cta border border-hub-cta/40'
							: 'text-hub-muted hover:text-hub-text hover:bg-hub-card border border-hub-border/60'}"
				>
					{f.label} <span class="text-hub-dim ml-1">{f.count}</span>
				</button>
			{/each}
			<div class="flex-1"></div>
			<input
				bind:value={search}
				placeholder="Search by name or description…"
				class="w-64 text-xs bg-hub-card border border-hub-border/60 rounded-lg px-3 py-1.5 text-hub-text"
			/>
		</div>
	</div>

	<!-- Skill list -->
	<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full">
			{#if loading}
				<div class="text-center text-sm text-hub-muted py-12">Loading skills…</div>
			{:else if loadError}
				<div class="text-center text-sm text-hub-danger py-12">
					Failed to load: {loadError}
				</div>
			{:else if filteredSkills.length === 0}
				<div class="text-center text-sm text-hub-muted py-12">
					{search ? `No skills match "${search}"` : 'No skills in this filter.'}
				</div>
			{:else}
				<div class="space-y-2">
					{#each filteredSkills as skill (skill.id)}
						<ChatSkillRow
							{skill}
							expanded={expandedIds.has(skill.id)}
							busy={busyIds.has(skill.id)}
							onToggleExpand={() => toggleExpand(skill.id)}
							onSave={(o) => saveOverlay(skill.id, o)}
							onDelete={() => deleteOverlay(skill.id)}
							onTest={(args) => testSkill(skill.id, args)}
						/>
					{/each}
				</div>
			{/if}
		</div>
	</main>

	{#if toast}
		<div
			class="fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm border
				{toast.kind === 'success'
					? 'bg-hub-cta/15 text-hub-cta border-hub-cta/40'
					: toast.kind === 'error'
						? 'bg-hub-danger/15 text-hub-danger border-hub-danger/40'
						: 'bg-hub-card text-hub-text border-hub-border'}"
			role="status"
		>
			{toast.text}
		</div>
	{/if}
</div>
