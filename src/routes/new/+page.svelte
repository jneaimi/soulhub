<script lang="ts">
	import { goto } from '$app/navigation';

	interface SimilarityMatch {
		slug: string;
		title: string;
		parentProject: string | null;
		reason: 'slug-exact' | 'slug-substring' | 'lexical' | 'semantic';
		score: number;
		snippet?: string;
	}
	interface SimilarityResult {
		proposedSlug: string;
		matches: SimilarityMatch[];
		lexicalHits: number;
		semanticCheck: 'duplicate' | 'related' | 'novel' | 'skipped' | 'error' | null;
		semanticReason?: string;
		confidence: 'high' | 'medium' | 'low';
	}

	let projectName = $state('');
	let description = $state('');
	let creating = $state(false);
	let error = $state('');
	let similarity = $state<SimilarityResult | null>(null);
	let similarityLoading = $state(false);
	let similarityOverride = $state(false);

	const nameValid = $derived(/^[a-z][a-z0-9-]*$/.test(projectName) && projectName.length >= 2);
	const canCreate = $derived(
		nameValid &&
			description.trim().length > 0 &&
			(similarity?.confidence !== 'high' || similarityOverride),
	);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** ADR-038 Phase 3 — pre-flight similarity check. Hits the vault to
	 *  flag duplicate or near-duplicate projects before creation. Soft
	 *  gate: only the `high` confidence bucket blocks Create (overridable
	 *  via the "Create anyway" button). */
	function scheduleSimilarityCheck() {
		similarityOverride = false;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (!nameValid) {
			similarity = null;
			return;
		}
		const slug = projectName.trim();
		const desc = description.trim();
		debounceTimer = setTimeout(async () => {
			similarityLoading = true;
			try {
				const params = new URLSearchParams({ slug });
				if (desc) params.set('description', desc);
				const res = await fetch(`/api/vault/projects/similar?${params}`);
				if (!res.ok) {
					similarity = null;
					return;
				}
				similarity = await res.json();
			} catch {
				// Network error — silently skip the hint; create is still allowed.
				similarity = null;
			} finally {
				similarityLoading = false;
			}
		}, 400);
	}

	$effect(() => {
		// Re-run whenever name or description changes; the references make
		// Svelte's reactivity track them without an explicit subscriber.
		void projectName;
		void description;
		scheduleSimilarityCheck();
	});

	async function createProject() {
		if (creating || !canCreate) return;
		creating = true;
		error = '';

		try {
			const res = await fetch('/api/workspaces/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: projectName.trim(),
					description: description.trim(),
					type: 'web-app', // placeholder — AI will determine the real type during setup
				}),
			});

			const data = await res.json();

			if (!res.ok) {
				error = data.error || data.errors?.join(', ') || 'Failed to create workspace';
				return;
			}

			goto(`/workspace/${encodeURIComponent(projectName.trim())}?setup=true`);
		} catch {
			error = 'Network error';
		} finally {
			creating = false;
		}
	}

	function reasonLabel(reason: SimilarityMatch['reason']): string {
		return reason === 'slug-exact'
			? 'Same name'
			: reason === 'slug-substring'
				? 'Similar name'
				: reason === 'lexical'
					? 'Similar description'
					: 'Looks related';
	}
</script>

<svelte:head>
	<title>New Workspace | Soul Hub</title>
</svelte:head>

<div class="min-h-screen bg-hub-bg text-hub-text">
	<div class="max-w-lg mx-auto px-6 py-10">
		<div class="flex items-center gap-3 mb-8">
			<a href="/workspaces" class="text-hub-muted hover:text-hub-text text-sm transition-colors cursor-pointer">&lt; Back</a>
			<h1 class="text-xl font-bold">New Workspace</h1>
		</div>

		<div class="space-y-6">
			<div>
				<label for="project-name" class="block text-sm font-medium mb-2">Workspace name</label>
				<input
					id="project-name"
					type="text"
					bind:value={projectName}
					placeholder="my-awesome-workspace"
					class="w-full bg-hub-surface border border-hub-border rounded-lg px-4 py-2.5 text-hub-text font-mono focus:outline-none focus:ring-2 focus:ring-hub-cta/30 focus:border-hub-cta/50"
				/>
				{#if projectName && !nameValid}
					<p class="text-xs text-hub-danger mt-1">Lowercase letters, numbers, hyphens only. Min 2 characters.</p>
				{:else}
					<p class="text-xs text-hub-dim mt-1">Creates ~/dev/{projectName || '...'}/</p>
				{/if}
			</div>

			<div>
				<label for="description" class="block text-sm font-medium mb-2">What are you building?</label>
				<textarea
					id="description"
					bind:value={description}
					placeholder="Describe your project — what it does, who it's for, key features. The more detail you give, the better the AI can configure your setup.

Example: A Python script that uses the Gemini API to generate images and video clips from text prompts, with a CLI interface for batch processing."
					rows="5"
					class="w-full bg-hub-surface border border-hub-border rounded-lg px-4 py-3 text-hub-text text-sm leading-relaxed resize-y min-h-[120px] focus:outline-none focus:ring-2 focus:ring-hub-cta/30 focus:border-hub-cta/50"
				></textarea>
				<p class="text-xs text-hub-dim mt-1">This description helps the AI suggest the right stack, tooling, and pipelines</p>
			</div>

			<div class="bg-hub-surface border border-hub-border/50 rounded-lg p-4">
				<div class="flex items-start gap-3">
					<svg class="w-5 h-5 text-hub-info flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
					</svg>
					<p class="text-xs text-hub-muted">
						After creating, the AI will guide you through stack, governance, tooling, and pipeline setup — one question at a time.
					</p>
				</div>
			</div>

			{#if similarity && similarity.matches.length > 0}
				{@const isHigh = similarity.confidence === 'high'}
				{@const isMedium = similarity.confidence === 'medium'}
				<div
					class="rounded-lg border px-4 py-3 text-sm"
					class:border-hub-danger={isHigh}
					class:bg-hub-danger={isHigh}
					class:bg-opacity-10={isHigh}
					class:border-hub-warning={isMedium}
					class:bg-hub-warning={isMedium}
					class:border-hub-info={!isHigh && !isMedium}
					class:bg-hub-info={!isHigh && !isMedium}
				>
					<div class="flex items-start justify-between gap-2 mb-2">
						<div class="font-medium" class:text-hub-danger={isHigh} class:text-hub-warning={isMedium} class:text-hub-info={!isHigh && !isMedium}>
							{#if isHigh}
								Looks like a duplicate
							{:else if isMedium}
								Might overlap with an existing project
							{:else}
								Related project{similarity.matches.length === 1 ? '' : 's'} in the vault
							{/if}
						</div>
						{#if similarityLoading}
							<span class="text-[10px] text-hub-dim">refreshing…</span>
						{/if}
					</div>
					<ul class="space-y-1.5">
						{#each similarity.matches as match}
							<li class="flex items-start gap-2 text-xs">
								<span class="text-hub-dim flex-shrink-0 mt-0.5">·</span>
								<div class="min-w-0 flex-1">
									<a href="/projects/{match.slug}" target="_blank" class="font-mono text-hub-text hover:text-hub-cta cursor-pointer">{match.slug}</a>
									<span class="text-hub-dim ml-1">({reasonLabel(match.reason)})</span>
									{#if match.parentProject}
										<span class="text-[10px] text-hub-dim ml-1">→ {match.parentProject}</span>
									{/if}
									{#if match.snippet}
										<div class="text-[11px] text-hub-muted mt-0.5 line-clamp-2">{match.snippet}</div>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					{#if similarity.semanticCheck === 'duplicate' || similarity.semanticCheck === 'related'}
						{#if similarity.semanticReason}
							<p class="text-[11px] text-hub-muted mt-2 italic">AI: {similarity.semanticReason}</p>
						{/if}
					{/if}
					{#if isHigh}
						<button
							type="button"
							onclick={() => (similarityOverride = true)}
							disabled={similarityOverride}
							class="mt-3 text-xs px-3 py-1.5 rounded border border-hub-danger/40 text-hub-danger hover:bg-hub-danger/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
						>
							{similarityOverride ? '✓ Will create anyway' : 'Create anyway'}
						</button>
					{/if}
				</div>
			{/if}

			{#if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{/if}

			<button
				onclick={createProject}
				disabled={!canCreate || creating}
				class="w-full bg-hub-cta text-hub-bg font-medium py-3 rounded-lg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{creating ? 'Creating...' : 'Create & Start Setup'}
			</button>
		</div>
	</div>
</div>
