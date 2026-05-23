<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';
	type Provider = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'mistral';

	interface Budget {
		max_usd: number;
		max_turns: number;
		timeout_sec: number;
	}

	interface Initial {
		id?: string;
		name?: string;
		description?: string;
		model?: string;
		tools?: string[];
		skills?: string[];
		budget?: Partial<Budget>;
		system_prompt?: string;
		backend?: Backend;
		chat_dispatchable?: boolean;
		/** ADR-031 — when set, the PTY dispatcher sends `/goal <condition>`
		 *  into the session before the task so the agent self-iterates
		 *  until the condition is met or the budget timeout fires. */
		goal_condition?: string;
		// ai-sdk-specific
		provider?: Provider;
		// pty-specific
		worktree_isolated?: boolean;
	}

	interface Props {
		mode: 'create' | 'edit';
		initial?: Initial;
	}

	const props: Props = $props();
	// Snapshot props at component-creation time. The wizard is one-shot —
	// the parent waits for `initial` to load, then mounts this component.
	// Prop changes after mount aren't supported (and aren't expected).
	const seed = props.initial ?? {};
	const isEdit = props.mode === 'edit';

	// ─── form state ─────────────────────────────────────────────────────────
	let id = $state(seed.id ?? '');
	let name = $state(seed.name ?? '');
	let description = $state(seed.description ?? '');
	let toolsRaw = $state((seed.tools ?? []).join(', '));
	let skillsSelected = $state<string[]>([...(seed.skills ?? [])]);
	let skillSearch = $state('');
	let systemPrompt = $state(seed.system_prompt ?? '');

	// Skills catalogue — fetched from /api/skills; each entry: id + description.
	interface SkillOption {
		id: string;
		description: string;
	}
	let skillCatalogue = $state<SkillOption[]>([]);
	let skillCatalogueError = $state<string | null>(null);
	let skillCatalogueLoading = $state(true);

	async function loadSkillCatalogue() {
		try {
			const res = await fetch('/api/skills');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			skillCatalogue = (data.skills ?? []).map((s: { id: string; description: string }) => ({
				id: s.id,
				description: s.description,
			}));
			skillCatalogueError = null;
		} catch (err) {
			skillCatalogueError = (err as Error).message;
		} finally {
			skillCatalogueLoading = false;
		}
	}

	onMount(() => {
		loadSkillCatalogue();
		loadCredentials();
	});

	function toggleSkill(id: string) {
		if (skillsSelected.includes(id)) {
			skillsSelected = skillsSelected.filter((s) => s !== id);
		} else {
			skillsSelected = [...skillsSelected, id];
		}
	}

	const skillsFiltered = $derived.by(() => {
		const q = skillSearch.trim().toLowerCase();
		if (!q) return skillCatalogue;
		return skillCatalogue.filter(
			(s) => s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
		);
	});

	const orphanSkills = $derived(
		skillsSelected.filter((id) => !skillCatalogue.some((c) => c.id === id)),
	);

	let backend = $state<Backend>(seed.backend ?? 'claude-pty');

	// Common model field — used for claude-* backends. AI SDK uses the modelAiSdk slot.
	let modelClaude = $state(
		seed.backend !== 'ai-sdk' ? (seed.model ?? 'sonnet') : 'sonnet',
	);
	let modelAiSdk = $state(
		seed.backend === 'ai-sdk' ? (seed.model ?? '') : '',
	);
	let provider = $state<Provider>(seed.provider ?? 'anthropic');

	// ─── credential availability (ADR-001 Phase 3) ─────────────────────────
	// Fetched once on mount from `/api/secrets`. Drives:
	//   1. Auto-pre-select on create: Lane A if CLAUDE_CODE_OAUTH_TOKEN set,
	//      else first AI SDK provider with a key, else stay on claude-pty
	//      with a banner pointing to Settings.
	//   2. Provider dropdown: disabled options for providers with no key.
	const PROVIDER_TO_KEY: Record<Provider, string> = {
		anthropic: 'ANTHROPIC_API_KEY',
		openai: 'OPENAI_API_KEY',
		openrouter: 'OPENROUTER_API_KEY',
		google: 'GEMINI_API_KEY',
		mistral: 'MISTRAL_API_KEY',
	};
	const CLAUDE_CODE_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

	let credLoaded = $state(false);
	let credSet = $state<Record<string, boolean>>({});

	const claudeCodeAvailable = $derived(credSet[CLAUDE_CODE_KEY] === true);
	const anyAiSdkAvailable = $derived(
		(['anthropic', 'openai', 'openrouter', 'google', 'mistral'] as Provider[]).some(
			(p) => credSet[PROVIDER_TO_KEY[p]] === true,
		),
	);
	const noBackendAvailable = $derived(credLoaded && !claudeCodeAvailable && !anyAiSdkAvailable);

	// Plain function (not $derived) so each invocation reads the reactive
	// `credSet` directly. $derived returning a function is brittle in Svelte 5.
	function providerAvailable(p: Provider): boolean {
		return credSet[PROVIDER_TO_KEY[p]] === true;
	}

	async function loadCredentials() {
		try {
			const res = await fetch('/api/secrets');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as Array<{ key: string; set: boolean }>;
			const map: Record<string, boolean> = {};
			for (const s of data) map[s.key] = s.set;
			credSet = map;
		} catch {
			// Silent: credentials view degrades to "show all, no hints" — the
			// dispatcher will still error helpfully if the user picks an
			// unavailable provider. UI just loses the proactive cue.
		} finally {
			credLoaded = true;
			// Auto-pre-select on create, only when the seed didn't pin a backend.
			if (!isEdit && !seed.backend) {
				if (claudeCodeAvailable) {
					backend = 'claude-pty';
				} else if (anyAiSdkAvailable) {
					backend = 'ai-sdk';
					// Pick the first provider that has a key.
					const firstWithKey = (
						['anthropic', 'openrouter', 'google', 'openai', 'mistral'] as Provider[]
					).find((p) => credSet[PROVIDER_TO_KEY[p]] === true);
					if (firstWithKey) provider = firstWithKey;
				}
				// else: stay on claude-pty default; the noBackendAvailable
				// banner below points the user to Settings.
			}
		}
	}

	// PTY-specific
	let worktreeIsolated = $state(seed.worktree_isolated ?? true);

	// Budget
	let maxUsd = $state(seed.budget?.max_usd ?? 0.5);
	let maxTurns = $state(seed.budget?.max_turns ?? 20);
	let timeoutSec = $state(seed.budget?.timeout_sec ?? 60);

	// Per WhatsApp ADR-005 — explicit per-agent flag for chat dispatch.
	// Off by default; users opt in agents whose work is safe to trigger
	// from a single WhatsApp message.
	let chatDispatchable = $state(seed.chat_dispatchable ?? false);

	// ADR-031 — convergence condition for `/goal`. PTY-only effect today.
	// Empty string → one-shot (legacy behavior). Non-empty → goal-mode.
	let goalCondition = $state(seed.goal_condition ?? '');

	// ─── derived validation ──────────────────────────────────────────────────
	const idValid = $derived(/^[a-z0-9][a-z0-9_-]*$/.test(id));
	const nameValid = $derived(name.trim().length > 0);
	const promptValid = $derived(systemPrompt.trim().length > 0);
	const aiSdkValid = $derived(backend !== 'ai-sdk' || modelAiSdk.trim().length > 0);

	const formValid = $derived(idValid && nameValid && promptValid && aiSdkValid);

	// ─── save ────────────────────────────────────────────────────────────────
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	function buildDraft() {
		const tools = toolsRaw
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		const skills = [...skillsSelected];

		const draft: Record<string, unknown> = {
			id,
			name: name.trim() || id,
			description: description.trim(),
			tools,
			skills,
			budget: {
				max_usd: Number(maxUsd) || 0,
				max_turns: Number(maxTurns) || 1,
				timeout_sec: Number(timeoutSec) || 1,
			},
			system_prompt: systemPrompt,
			provenance: 'user-created',
			chat_dispatchable: chatDispatchable,
			goal_condition: goalCondition.trim() || undefined,
		};

		if (backend === 'claude-pty') {
			draft.model = modelClaude.trim() || undefined;
			draft.spec = {
				backend: 'claude-pty',
				worktree_isolated: worktreeIsolated,
			};
		} else if (backend === 'claude-cli-flag') {
			draft.model = modelClaude.trim() || undefined;
			draft.spec = { backend: 'claude-cli-flag' };
		} else {
			draft.model = modelAiSdk.trim();
			draft.spec = {
				backend: 'ai-sdk',
				provider,
				model: modelAiSdk.trim(),
			};
		}

		return draft;
	}

	async function save() {
		saveError = null;
		if (!formValid) {
			saveError = 'Please fix validation errors above before saving.';
			return;
		}
		saving = true;
		try {
			const draft = buildDraft();
			const url = isEdit ? `/api/agents/${encodeURIComponent(id)}` : '/api/agents';
			const method = isEdit ? 'PUT' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(draft),
			});
			const data = await res.json();
			if (!res.ok) {
				saveError = data.error ?? `HTTP ${res.status}`;
				if (data.issues) {
					saveError += ': ' + data.issues.map((i: { message?: string }) => i.message).join(', ');
				}
				saving = false;
				return;
			}
			goto('/orchestration/agents');
		} catch (err) {
			saveError = (err as Error).message;
			saving = false;
		}
	}

	function cancel() {
		goto('/orchestration/agents');
	}

	// ─── backend cards ──────────────────────────────────────────────────────
	interface BackendCard {
		id: Backend;
		label: string;
		oneLine: string;
		risk: string | null;
		colorActive: string;
	}

	const backendCards: BackendCard[] = [
		{
			id: 'claude-pty',
			label: 'PTY',
			oneLine: 'Parallel-safe interactive Claude Code session. Recommended.',
			risk: null,
			colorActive: 'border-hub-purple/60 bg-hub-purple/10 text-hub-text',
		},
		{
			id: 'claude-cli-flag',
			label: 'CLI flag',
			oneLine: '`claude -p --agent <id>`. Single-call only.',
			risk: '⚠ avoid concurrent dispatch (anthropics/claude-code#18666)',
			colorActive: 'border-hub-warning/60 bg-hub-warning/10 text-hub-text',
		},
		{
			id: 'ai-sdk',
			label: 'AI SDK',
			oneLine: 'BYOK — Anthropic, OpenAI, OpenRouter, Google, Mistral.',
			risk: null,
			colorActive: 'border-hub-info/60 bg-hub-info/10 text-hub-text',
		},
	];

	const providers: Provider[] = ['anthropic', 'openai', 'openrouter', 'google', 'mistral'];
</script>

<div class="space-y-4">
	<!-- Step 1: Backend -->
	<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-3">
		<div class="flex items-center gap-2">
			<span
				class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-hub-cta text-black text-[11px] font-semibold"
				>1</span
			>
			<h2 class="text-sm font-semibold text-hub-text">Backend</h2>
			{#if isEdit}
				<span class="text-[10px] text-hub-warning">⚠ changing backend rewrites the agent in a new lane</span>
			{/if}
		</div>
		{#if noBackendAvailable}
			<div class="bg-hub-warning/10 border border-hub-warning/40 rounded-lg p-3 text-xs text-hub-warning">
				No Claude Code OAuth token or AI SDK provider key configured. Add at least one in
				<a href="/settings" class="underline">Settings</a>
				before creating an agent.
			</div>
		{/if}
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
			{#each backendCards as card (card.id)}
				{@const cardAvailable =
					card.id === 'ai-sdk' ? anyAiSdkAvailable : claudeCodeAvailable}
				{@const showHint = credLoaded && !cardAvailable}
				<button
					type="button"
					onclick={() => (backend = card.id)}
					class="text-left p-3 rounded-lg border transition-colors cursor-pointer
						{backend === card.id
							? card.colorActive
							: 'border-hub-border bg-hub-bg text-hub-muted hover:text-hub-text hover:border-hub-border/80'}"
				>
					<div class="text-sm font-semibold mb-1 flex items-center gap-1.5">
						{card.label}
						{#if credLoaded && cardAvailable}
							<span class="text-hub-cta text-[10px]" title="Credential available">✓</span>
						{/if}
					</div>
					<div class="text-[11px] text-hub-muted leading-snug">{card.oneLine}</div>
					{#if card.risk}
						<div class="text-[10px] text-hub-warning mt-1.5">{card.risk}</div>
					{/if}
					{#if showHint}
						<div class="text-[10px] text-hub-dim mt-1.5">
							{card.id === 'ai-sdk'
								? 'No provider keys set'
								: 'No Claude Code OAuth'}
							— <a href="/settings" class="underline" onclick={(e) => e.stopPropagation()}>Add in Settings</a>
						</div>
					{/if}
				</button>
			{/each}
		</div>
	</section>

	<!-- Step 2: Identity -->
	<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-3">
		<div class="flex items-center gap-2">
			<span
				class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-hub-cta text-black text-[11px] font-semibold"
				>2</span
			>
			<h2 class="text-sm font-semibold text-hub-text">Identity</h2>
		</div>
		<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
			<div>
				<label for="agent-id" class="block text-xs text-hub-muted mb-1">
					ID <span class="text-hub-dim">(lowercase, hyphens, no spaces)</span>
				</label>
				<input
					id="agent-id"
					type="text"
					bind:value={id}
					disabled={isEdit}
					placeholder="research-junior"
					class="w-full px-3 py-2 rounded-lg bg-hub-bg border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 disabled:opacity-60 disabled:cursor-not-allowed
						{idValid || !id
							? 'border-hub-border focus:border-hub-cta/50 focus:ring-hub-cta/50'
							: 'border-hub-danger/60 focus:border-hub-danger focus:ring-hub-danger/30'}"
				/>
				{#if id && !idValid}
					<p class="text-[11px] text-hub-danger mt-1">
						Use lowercase letters, digits, hyphens, or underscores. Must start with a letter or
						digit.
					</p>
				{/if}
			</div>
			<div>
				<label for="agent-name" class="block text-xs text-hub-muted mb-1">
					Name <span class="text-hub-dim">(display label)</span>
				</label>
				<input
					id="agent-name"
					type="text"
					bind:value={name}
					placeholder="Research Junior"
					class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
				/>
			</div>
		</div>
		<div>
			<label for="agent-desc" class="block text-xs text-hub-muted mb-1">
				Description <span class="text-hub-dim">(one line — appears in lists)</span>
			</label>
			<input
				id="agent-desc"
				type="text"
				bind:value={description}
				placeholder="Quick research agent for time-sensitive lookups"
				class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
			/>
		</div>
	</section>

	<!-- Step 3: Configure -->
	<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-4">
		<div class="flex items-center gap-2">
			<span
				class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-hub-cta text-black text-[11px] font-semibold"
				>3</span
			>
			<h2 class="text-sm font-semibold text-hub-text">Configure</h2>
		</div>

		<!-- System prompt -->
		<div>
			<label for="agent-prompt" class="block text-xs text-hub-muted mb-1">
				System prompt
			</label>
			<textarea
				id="agent-prompt"
				bind:value={systemPrompt}
				rows="10"
				placeholder="You are a focused research agent…"
				class="w-full px-3 py-2 rounded-lg bg-hub-bg border text-[13px] text-hub-text font-mono focus:outline-none focus:ring-1
					{promptValid || !systemPrompt
						? 'border-hub-border focus:border-hub-cta/50 focus:ring-hub-cta/50'
						: 'border-hub-danger/60 focus:border-hub-danger focus:ring-hub-danger/30'}"
			></textarea>
			{#if !systemPrompt}
				<p class="text-[11px] text-hub-dim mt-1">
					This is what the agent reads at the start of every dispatch. Be specific about role,
					inputs, expected outputs, and stop conditions.
				</p>
			{:else if !promptValid}
				<p class="text-[11px] text-hub-danger mt-1">System prompt cannot be empty.</p>
			{/if}
		</div>

		<!-- Tools -->
		<div>
			<label for="agent-tools" class="block text-xs text-hub-muted mb-1">
				Tools <span class="text-hub-dim">(comma-separated)</span>
			</label>
			<input
				id="agent-tools"
				type="text"
				bind:value={toolsRaw}
				placeholder="Read, Write, Bash, WebFetch"
				class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
			/>
		</div>

		<!-- Skills multi-select -->
		<div>
			<div class="flex items-center justify-between mb-1">
				<label for="agent-skill-search" class="block text-xs text-hub-muted">
					Skills <span class="text-hub-dim">— pick from installed</span>
				</label>
				<a
					href="/orchestration/skills"
					target="_blank"
					rel="noopener"
					class="text-[11px] text-hub-info hover:text-hub-text"
				>
					Manage skills →
				</a>
			</div>
			{#if skillsSelected.length > 0}
				<div class="flex flex-wrap gap-1.5 mb-2">
					{#each skillsSelected as id (id)}
						{@const isOrphan = orphanSkills.includes(id)}
						<button
							type="button"
							onclick={() => toggleSkill(id)}
							class="px-2 py-0.5 rounded-md text-[11px] font-mono cursor-pointer transition-colors
								{isOrphan
									? 'bg-hub-warning/15 text-hub-warning border border-hub-warning/40 hover:bg-hub-warning/25'
									: 'bg-hub-cta/15 text-hub-cta border border-hub-cta/40 hover:bg-hub-cta/25'}"
							title={isOrphan ? 'Selected but not installed locally' : 'Click to remove'}
						>
							{id} ×
						</button>
					{/each}
				</div>
			{/if}
			<input
				id="agent-skill-search"
				type="search"
				bind:value={skillSearch}
				placeholder={skillCatalogueLoading
					? 'Loading skills…'
					: skillCatalogue.length === 0
						? 'No skills installed — click Manage skills →'
						: `Search ${skillCatalogue.length} installed skills…`}
				disabled={skillCatalogueLoading || skillCatalogue.length === 0}
				class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50 disabled:opacity-50"
			/>
			{#if skillCatalogueError}
				<p class="text-[11px] text-hub-danger mt-1">Failed to load skills: {skillCatalogueError}</p>
			{:else if !skillCatalogueLoading && skillCatalogue.length > 0}
				<div class="mt-2 max-h-40 overflow-y-auto bg-hub-bg border border-hub-border rounded-lg p-1.5 space-y-0.5">
					{#each skillsFiltered.slice(0, 50) as skill (skill.id)}
						{@const selected = skillsSelected.includes(skill.id)}
						<button
							type="button"
							onclick={() => toggleSkill(skill.id)}
							class="w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 cursor-pointer transition-colors
								{selected
									? 'bg-hub-cta/15 text-hub-cta'
									: 'text-hub-muted hover:text-hub-text hover:bg-hub-card'}"
						>
							<span class="w-3 h-3 flex-shrink-0">
								{#if selected}
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
										<polyline points="20 6 9 17 4 12"/>
									</svg>
								{/if}
							</span>
							<span class="font-mono">{skill.id}</span>
							{#if skill.description}
								<span class="text-hub-dim truncate">— {skill.description}</span>
							{/if}
						</button>
					{/each}
					{#if skillsFiltered.length > 50}
						<p class="text-[10px] text-hub-dim px-2 py-1">
							+{skillsFiltered.length - 50} more — refine search to see them.
						</p>
					{/if}
					{#if skillsFiltered.length === 0}
						<p class="text-[11px] text-hub-dim px-2 py-1">No matches.</p>
					{/if}
				</div>
			{/if}
			{#if orphanSkills.length > 0}
				<p class="text-[11px] text-hub-warning mt-1">
					⚠ Selected but not installed: {orphanSkills.join(', ')} — install via <a href="/orchestration/skills" class="underline">/orchestration/skills</a> or remove.
				</p>
			{/if}
		</div>

		<!-- Chat dispatch policy (ADR-005) -->
		<div>
			<div class="text-xs text-hub-muted mb-1.5">Chat dispatch</div>
			<label class="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-hub-bg border border-hub-border text-xs text-hub-muted cursor-pointer hover:text-hub-text transition-colors">
				<input
					type="checkbox"
					bind:checked={chatDispatchable}
					class="accent-hub-cta cursor-pointer mt-0.5"
				/>
				<span>
					<span class="text-hub-text font-medium">Dispatchable from chat</span>
					<span class="block text-[10px] text-hub-dim mt-0.5 leading-snug">
						When on, the WhatsApp orchestrator may dispatch this agent based on the user's natural-language message. Leave off for code-modifying or admin-class agents.
					</span>
				</span>
			</label>
		</div>

		<!-- Goal condition (ADR-031) -->
		<div>
			<div class="text-xs text-hub-muted mb-1.5">Goal condition <span class="text-hub-dim font-normal">(optional)</span></div>
			<input
				id="agent-goal"
				type="text"
				bind:value={goalCondition}
				placeholder="e.g. all tests pass and no type-check errors"
				class="w-full px-2.5 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
			/>
			<p class="text-[10px] text-hub-dim mt-1 leading-snug">
				When set, the PTY dispatcher sends <code class="font-mono">/goal &lt;condition&gt;</code> into the Claude Code session before the task so the agent self-iterates until the condition is met or the budget timeout fires. PTY backend only today — has no effect on <code class="font-mono">claude-cli-flag</code> or <code class="font-mono">ai-sdk</code> agents. Best for agents whose deliverable is "code that works" (inspector, developer, security-reviewer); leave empty for one-shot artifact producers.
			</p>
		</div>

		<!-- Budget -->
		<div>
			<div class="text-xs text-hub-muted mb-1.5">Budget</div>
			<div class="grid grid-cols-3 gap-2">
				<div>
					<label for="agent-usd" class="block text-[10px] text-hub-dim mb-0.5 uppercase tracking-wider">Max USD</label>
					<input
						id="agent-usd"
						type="number"
						min="0"
						step="0.05"
						bind:value={maxUsd}
						class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
				</div>
				<div>
					<label for="agent-turns" class="block text-[10px] text-hub-dim mb-0.5 uppercase tracking-wider">Max turns</label>
					<input
						id="agent-turns"
						type="number"
						min="1"
						bind:value={maxTurns}
						class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
				</div>
				<div>
					<label for="agent-timeout" class="block text-[10px] text-hub-dim mb-0.5 uppercase tracking-wider">Timeout (s)</label>
					<input
						id="agent-timeout"
						type="number"
						min="1"
						bind:value={timeoutSec}
						class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
				</div>
			</div>
		</div>

		<!-- Backend-specific -->
		<div class="border-t border-hub-border/60 pt-4 space-y-3">
			<div class="text-xs text-hub-muted">
				Backend-specific
				<span class="text-hub-dim">— shows fields for {backend}</span>
			</div>

			{#if backend === 'claude-pty'}
				<div>
					<label for="claude-model" class="block text-xs text-hub-muted mb-1">Model</label>
					<input
						id="claude-model"
						type="text"
						bind:value={modelClaude}
						placeholder="sonnet"
						class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
					/>
				</div>
				<div class="flex flex-wrap gap-3 pt-1">
					<label class="flex items-center gap-2 text-xs text-hub-muted cursor-pointer">
						<input type="checkbox" bind:checked={worktreeIsolated} class="accent-hub-cta cursor-pointer" />
						Worktree-isolated
					</label>
				</div>
			{:else if backend === 'claude-cli-flag'}
				<div class="bg-hub-warning/10 border border-hub-warning/40 rounded-lg p-3 text-xs text-hub-warning">
					Single-call only. Avoid concurrent dispatch — see anthropics/claude-code#18666.
				</div>
				<div>
					<label for="claude-cli-model" class="block text-xs text-hub-muted mb-1">Model</label>
					<input
						id="claude-cli-model"
						type="text"
						bind:value={modelClaude}
						placeholder="sonnet"
						class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
					/>
				</div>
			{:else if backend === 'ai-sdk'}
				<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
					<div>
						<label for="ai-provider" class="block text-xs text-hub-muted mb-1">Provider</label>
						<select
							id="ai-provider"
							bind:value={provider}
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						>
							{#each providers as p (p)}
								{@const has = providerAvailable(p)}
								<option value={p}>
									{p}{credLoaded ? (has ? ' ✓' : ' (no key)') : ''}
								</option>
							{/each}
						</select>
						{#if credLoaded && !providerAvailable(provider)}
							<p class="text-[11px] text-hub-warning mt-1">
								No <code class="font-mono">{PROVIDER_TO_KEY[provider]}</code> set.
								<a href="/settings" class="underline">Add in Settings →</a>
							</p>
						{/if}
					</div>
					<div>
						<label for="ai-model" class="block text-xs text-hub-muted mb-1">Model</label>
						<input
							id="ai-model"
							type="text"
							bind:value={modelAiSdk}
							placeholder={provider === 'anthropic'
								? 'claude-sonnet-4-6'
								: provider === 'openrouter'
									? 'moonshotai/kimi-k2-6'
									: 'model-id'}
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border text-sm text-hub-text font-mono focus:outline-none focus:ring-1
								{aiSdkValid || !modelAiSdk
									? 'border-hub-border focus:border-hub-cta/50 focus:ring-hub-cta/50'
									: 'border-hub-danger/60 focus:border-hub-danger focus:ring-hub-danger/30'}"
						/>
						{#if !aiSdkValid && backend === 'ai-sdk'}
							<p class="text-[11px] text-hub-danger mt-1">Model is required for AI SDK agents.</p>
						{/if}
					</div>
				</div>
				<p class="text-[11px] text-hub-dim">
					API key resolved from <code class="text-hub-muted">~/.soul-hub/.env</code> at dispatch time. Add keys
					in <a href="/settings" class="text-hub-info hover:text-hub-text">Settings</a> if missing.
				</p>
			{/if}
		</div>
	</section>

	<!-- Save / Cancel -->
	<div class="flex items-center gap-2">
		{#if saveError}
			<div class="flex-1 bg-hub-danger/10 border border-hub-danger/40 rounded-lg p-2.5 text-xs text-hub-danger">
				{saveError}
			</div>
		{:else}
			<div class="flex-1 text-[11px] text-hub-dim">
				{#if !formValid}
					Fix the highlighted fields above to enable save.
				{:else if backend === 'claude-pty' || backend === 'claude-cli-flag'}
					Saves to <code class="text-hub-muted">~/.claude/agents/{id || '<id>'}.md</code> (Lane A)
				{:else}
					Saves to <code class="text-hub-muted">~/.soul-hub/data/agents/{id || '<id>'}.yaml</code> (Lane B)
				{/if}
			</div>
		{/if}
		<button
			type="button"
			onclick={cancel}
			class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
		>
			Cancel
		</button>
		<button
			type="button"
			onclick={save}
			disabled={!formValid || saving}
			class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
		>
			{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
		</button>
	</div>
</div>
