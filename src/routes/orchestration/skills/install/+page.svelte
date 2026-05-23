<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface SkillSummary {
		id: string;
		name: string;
		description: string;
		body_lines: number;
		has_scripts: boolean;
		has_references: boolean;
		is_symlink: boolean;
		symlink_target?: string;
		source_path: string;
		modified_at: number;
		parse_error?: string;
	}

	type Filter = 'all' | 'symlink' | 'unhealthy';

	let skills = $state<SkillSummary[]>([]);
	let dir = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<Filter>('all');
	let search = $state('');
	let toast = $state<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
	let deleteConfirm = $state(new Map<string, number>());
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// Install panel state
	let installRepo = $state('');
	let installSubpath = $state('');
	let installName = $state('');
	let installRef = $state('');
	let installing = $state(false);
	let installError = $state<string | null>(null);

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
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return skills.filter((s) => {
			if (q && !s.id.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q))
				return false;
			if (filter === 'symlink' && !s.is_symlink) return false;
			if (filter === 'unhealthy' && !s.parse_error) return false;
			return true;
		});
	});

	const summary = $derived.by(() => {
		const total = skills.length;
		const symlinks = skills.filter((s) => s.is_symlink).length;
		const unhealthy = skills.filter((s) => s.parse_error).length;
		return { total, symlinks, unhealthy };
	});

	function formatDate(ms: number): string {
		if (!ms) return '—';
		const d = new Date(ms);
		const now = Date.now();
		const diffMs = now - ms;
		const day = 86_400_000;
		if (diffMs < day) return 'today';
		if (diffMs < 2 * day) return 'yesterday';
		if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`;
		return d.toISOString().slice(0, 10);
	}

	async function handleDelete(id: string) {
		const last = deleteConfirm.get(id);
		const now = Date.now();
		if (last && now - last < 5000) {
			try {
				const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
				const data = await res.json();
				if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
				flashToast('success', `Uninstalled ${id}`);
				const next = new Map(deleteConfirm);
				next.delete(id);
				deleteConfirm = next;
				loadSkills();
			} catch (err) {
				flashToast('error', `Uninstall failed: ${(err as Error).message}`);
			}
			return;
		}
		const next = new Map(deleteConfirm);
		next.set(id, now);
		deleteConfirm = next;
		flashToast('info', `Click again within 5s to uninstall ${id}`);
		setTimeout(() => {
			const n2 = new Map(deleteConfirm);
			if (n2.get(id) === now) {
				n2.delete(id);
				deleteConfirm = n2;
			}
		}, 5000);
	}

	async function handleInstall() {
		installError = null;
		if (!installRepo.trim()) {
			installError = 'repo is required';
			return;
		}
		installing = true;
		try {
			const res = await fetch('/api/skills/install', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					source: 'github',
					repo: installRepo.trim(),
					subpath: installSubpath.trim() || undefined,
					name: installName.trim() || undefined,
					ref: installRef.trim() || undefined,
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			flashToast('success', `Installed ${data.id}`);
			installRepo = '';
			installSubpath = '';
			installName = '';
			installRef = '';
			loadSkills();
		} catch (err) {
			installError = (err as Error).message;
		} finally {
			installing = false;
		}
	}

	interface QuickInstall {
		label: string;
		repo: string;
		subpath: string;
		name: string;
		hint: string;
	}
	const quickInstalls: QuickInstall[] = [
		{
			label: 'anthropics/skills · webapp-testing',
			repo: 'anthropics/skills',
			subpath: 'skills/webapp-testing',
			name: 'webapp-testing',
			hint: 'Web app QA via Playwright + screenshots',
		},
		{
			label: 'anthropics/skills · skill-creator',
			repo: 'anthropics/skills',
			subpath: 'skills/skill-creator',
			name: 'skill-creator',
			hint: 'Helper for authoring new SKILL.md files',
		},
		{
			label: 'anthropics/skills · slack-gif-creator',
			repo: 'anthropics/skills',
			subpath: 'skills/slack-gif-creator',
			name: 'slack-gif-creator',
			hint: 'Generate Slack-ready animated GIFs',
		},
		{
			label: 'anthropics/skills · theme-factory',
			repo: 'anthropics/skills',
			subpath: 'skills/theme-factory',
			name: 'theme-factory',
			hint: 'Generates UI themes / palettes',
		},
	];

	function pickQuick(q: QuickInstall) {
		installRepo = q.repo;
		installSubpath = q.subpath;
		installName = q.name;
		installRef = '';
		installError = null;
	}

	const filterChips: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'symlink', label: 'Symlinked' },
		{ id: 'unhealthy', label: 'Unhealthy' },
	];

	onMount(() => {
		loadSkills();
		pollInterval = setInterval(loadSkills, 30_000);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});
</script>

<svelte:head>
	<title>Skills · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<a
				href="/orchestration/skills"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to skills"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text">Skills · Install</h1>
			</div>
			<div class="flex-1"></div>
			<a
				href="/orchestration/skills"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="Configure which skills the WhatsApp orchestrator can invoke"
			>
				💬 Chat overlay
			</a>
			<a
				href="/orchestration/agents"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			>
				Agents
			</a>
		</div>
	</header>

	<!-- Summary -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-hub-muted">
			<span><span class="text-hub-text font-medium">{summary.total}</span> installed</span>
			{#if summary.symlinks > 0}
				<span class="text-hub-dim">·</span>
				<span><span class="text-hub-info font-medium">{summary.symlinks}</span> symlinked</span>
			{/if}
			{#if summary.unhealthy > 0}
				<span class="text-hub-dim">·</span>
				<span class="text-hub-warning"><span class="font-medium">{summary.unhealthy}</span> unhealthy</span>
			{/if}
			{#if dir}
				<span class="text-hub-dim">·</span>
				<span class="font-mono text-hub-dim">{dir}</span>
			{/if}
		</div>
	</div>

	<!-- Body -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-4">
			<!-- Install panel -->
			<aside class="lg:col-span-1 space-y-3">
				<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-3">
					<h2 class="text-sm font-semibold text-hub-text">Install a skill</h2>
					<p class="text-[11px] text-hub-dim">
						Clone any GitHub repo (or subfolder) containing a <code class="text-hub-muted">SKILL.md</code> file into <code class="text-hub-muted">~/.claude/skills/</code>.
					</p>
					<div>
						<label for="skill-repo" class="block text-xs text-hub-muted mb-1">Repo</label>
						<input
							id="skill-repo"
							type="text"
							bind:value={installRepo}
							placeholder="anthropics/skills"
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						/>
					</div>
					<div>
						<label for="skill-subpath" class="block text-xs text-hub-muted mb-1">
							Subpath <span class="text-hub-dim">(optional — folder containing SKILL.md)</span>
						</label>
						<input
							id="skill-subpath"
							type="text"
							bind:value={installSubpath}
							placeholder="document-skills/pdf"
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						/>
					</div>
					<div class="grid grid-cols-2 gap-2">
						<div>
							<label for="skill-name" class="block text-xs text-hub-muted mb-1">
								Name <span class="text-hub-dim">(opt.)</span>
							</label>
							<input
								id="skill-name"
								type="text"
								bind:value={installName}
								placeholder="auto"
								class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
							/>
						</div>
						<div>
							<label for="skill-ref" class="block text-xs text-hub-muted mb-1">
								Ref <span class="text-hub-dim">(opt.)</span>
							</label>
							<input
								id="skill-ref"
								type="text"
								bind:value={installRef}
								placeholder="main"
								class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
							/>
						</div>
					</div>
					{#if installError}
						<div class="bg-hub-danger/10 border border-hub-danger/40 rounded-lg p-2 text-xs text-hub-danger">
							{installError}
						</div>
					{/if}
					<button
						type="button"
						onclick={handleInstall}
						disabled={installing || !installRepo.trim()}
						class="w-full px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{installing ? 'Cloning…' : 'Install'}
					</button>
				</section>

				<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-2">
					<h3 class="text-xs font-semibold text-hub-muted uppercase tracking-wider">Quick installs</h3>
					<p class="text-[11px] text-hub-dim">Pre-fills the form with a known-good registry skill.</p>
					<div class="space-y-1.5">
						{#each quickInstalls as q (q.label)}
							<button
								type="button"
								onclick={() => pickQuick(q)}
								class="w-full text-left px-2.5 py-2 rounded-lg bg-hub-bg hover:bg-hub-bg/60 border border-hub-border hover:border-hub-cta/40 transition-colors cursor-pointer"
							>
								<div class="text-xs text-hub-text font-mono">{q.label}</div>
								<div class="text-[11px] text-hub-dim mt-0.5">{q.hint}</div>
							</button>
						{/each}
					</div>
					<p class="text-[10px] text-hub-dim pt-1">
						Browse: <a class="text-hub-info hover:text-hub-text" target="_blank" rel="noopener" href="https://github.com/anthropics/skills">anthropics/skills</a> · <a class="text-hub-info hover:text-hub-text" target="_blank" rel="noopener" href="https://github.com/ComposioHQ/awesome-claude-skills">ComposioHQ/awesome-claude-skills</a>
					</p>
				</section>
			</aside>

			<!-- Installed list -->
			<section class="lg:col-span-2 space-y-3">
				<!-- Filter + search -->
				<div class="flex flex-wrap items-center gap-2">
					{#each filterChips as f (f.id)}
						<button
							type="button"
							onclick={() => (filter = f.id)}
							class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
								{filter === f.id
									? 'bg-hub-cta text-black'
									: 'bg-hub-card text-hub-muted hover:text-hub-text border border-hub-border'}"
						>
							{f.label}
						</button>
					{/each}
					<div class="flex-1 min-w-[180px]">
						<input
							type="search"
							bind:value={search}
							placeholder="Search by id or description…"
							class="w-full px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-xs text-hub-text placeholder-hub-dim focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						/>
					</div>
				</div>

				{#if loading}
					<div class="space-y-2">
						{#each Array(5) as _, i (i)}
							<div class="h-14 bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
						{/each}
					</div>
				{:else if loadError}
					<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
						Failed to load skills: {loadError}
					</div>
				{:else if filtered.length === 0}
					<div class="bg-hub-card rounded-xl border border-hub-border p-8 text-center">
						{#if skills.length === 0}
							<p class="text-sm text-hub-muted">
								No skills installed yet — use the panel on the left or pick a quick install.
							</p>
						{:else}
							<p class="text-sm text-hub-muted">No skills match this filter.</p>
						{/if}
					</div>
				{:else}
					<div class="space-y-1.5">
						{#each filtered as skill (skill.id)}
							<div class="bg-hub-card rounded-xl border border-hub-border px-3 py-2.5 flex items-center gap-3">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="text-sm font-mono text-hub-text">{skill.id}</span>
										{#if skill.is_symlink}
											<span class="px-1.5 py-0.5 rounded text-[10px] bg-hub-info/15 text-hub-info border border-hub-info/30">↪ symlink</span>
										{/if}
										{#if skill.parse_error}
											<span class="px-1.5 py-0.5 rounded text-[10px] bg-hub-warning/15 text-hub-warning border border-hub-warning/30">parse error</span>
										{/if}
										{#if skill.has_scripts}
											<span class="px-1.5 py-0.5 rounded text-[10px] bg-hub-purple/15 text-hub-purple border border-hub-purple/30">scripts</span>
										{/if}
										{#if skill.has_references}
											<span class="px-1.5 py-0.5 rounded text-[10px] bg-hub-card text-hub-muted border border-hub-border">references</span>
										{/if}
									</div>
									{#if skill.description}
										<p class="text-[11px] text-hub-muted mt-0.5 line-clamp-2">{skill.description}</p>
									{:else if skill.parse_error}
										<p class="text-[11px] text-hub-warning mt-0.5">{skill.parse_error}</p>
									{/if}
								</div>
								<div class="flex-shrink-0 text-[10px] text-hub-dim font-mono whitespace-nowrap">
									{skill.body_lines} lines · {formatDate(skill.modified_at)}
								</div>
								<button
									type="button"
									onclick={() => handleDelete(skill.id)}
									class="px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
										{deleteConfirm.has(skill.id)
											? 'bg-hub-danger text-white hover:bg-hub-danger/90'
											: 'text-hub-muted hover:text-hub-danger hover:bg-hub-danger/10'}"
									title={skill.is_symlink ? 'Removes the symlink only (target preserved)' : 'Removes the skill folder'}
								>
									{deleteConfirm.has(skill.id) ? 'Confirm' : '× Uninstall'}
								</button>
							</div>
						{/each}
					</div>
					<p class="text-[10px] text-hub-dim mt-2 text-center">
						Showing {filtered.length} of {skills.length}.
					</p>
				{/if}
			</section>
		</div>
	</div>

	<!-- Toast -->
	{#if toast}
		<div
			class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg
				{toast.kind === 'success' ? 'bg-hub-cta text-black'
				: toast.kind === 'error' ? 'bg-hub-danger text-white'
				: 'bg-hub-card text-hub-text border border-hub-border'}"
			role="status"
		>
			{toast.text}
		</div>
	{/if}
</div>
