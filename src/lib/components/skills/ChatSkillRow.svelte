<script lang="ts">
	type InvocationKind = 'script' | 'prompt-injection' | 'cli-subsession';

	interface SkillInvocation {
		kind: InvocationKind;
		cmd?: string[];
		cwd?: string;
		timeout_ms?: number;
		max_bytes?: number;
		extra_args?: string[];
	}

	interface SkillOverlay {
		name: string;
		chat_invokable: boolean;
		display_name?: string;
		chat_description: string;
		invocation: SkillInvocation;
		examples?: { args: string; description: string }[];
		provenance?: 'user-created' | 'seed-roster' | 'discovered';
	}

	interface SkillEnriched {
		id: string;
		name: string;
		description: string;
		body_lines: number;
		has_scripts: boolean;
		is_symlink: boolean;
		source_path: string;
		chat_overlay: SkillOverlay | null;
	}

	interface Props {
		skill: SkillEnriched;
		expanded: boolean;
		busy: boolean;
		onToggleExpand: () => void;
		onSave: (overlay: SkillOverlay) => Promise<void>;
		onDelete: () => Promise<void>;
		onTest: (args: string) => Promise<{ ok: boolean; output?: string; error?: string; durationMs: number }>;
	}

	const { skill, expanded, busy, onToggleExpand, onSave, onDelete, onTest }: Props = $props();

	// Editor state — rebuilt from the overlay when the row expands.
	let chatInvokable = $state(skill.chat_overlay?.chat_invokable ?? true);
	let chatDescription = $state(
		skill.chat_overlay?.chat_description ?? skill.description ?? '',
	);
	let invocationKind = $state<InvocationKind>(
		skill.chat_overlay?.invocation.kind ?? 'prompt-injection',
	);
	let cmdText = $state((skill.chat_overlay?.invocation.cmd ?? []).join(' '));
	let cwd = $state(skill.chat_overlay?.invocation.cwd ?? '');
	let timeoutMs = $state(skill.chat_overlay?.invocation.timeout_ms ?? 30000);
	let maxBytes = $state(skill.chat_overlay?.invocation.max_bytes ?? 8192);
	let extraArgsText = $state((skill.chat_overlay?.invocation.extra_args ?? []).join(' '));

	let testArgs = $state('');
	let testOutput = $state<{ ok: boolean; output?: string; error?: string; durationMs: number } | null>(null);
	let testRunning = $state(false);

	$effect(() => {
		// Resync editor fields if the overlay reference changes (e.g. after save).
		if (!expanded) return;
		chatInvokable = skill.chat_overlay?.chat_invokable ?? true;
		chatDescription = skill.chat_overlay?.chat_description ?? skill.description ?? '';
		invocationKind = skill.chat_overlay?.invocation.kind ?? 'prompt-injection';
		cmdText = (skill.chat_overlay?.invocation.cmd ?? []).join(' ');
		cwd = skill.chat_overlay?.invocation.cwd ?? '';
		timeoutMs = skill.chat_overlay?.invocation.timeout_ms ?? 30000;
		maxBytes = skill.chat_overlay?.invocation.max_bytes ?? 8192;
		extraArgsText = (skill.chat_overlay?.invocation.extra_args ?? []).join(' ');
	});

	function buildOverlay(): SkillOverlay {
		const invocation: SkillInvocation =
			invocationKind === 'script'
				? {
						kind: 'script',
						cmd: cmdText.trim().split(/\s+/).filter(Boolean),
						cwd: cwd.trim() || undefined,
						timeout_ms: timeoutMs,
					}
				: invocationKind === 'cli-subsession'
					? {
							kind: 'cli-subsession',
							extra_args: extraArgsText.trim().split(/\s+/).filter(Boolean),
							timeout_ms: timeoutMs,
						}
					: {
							kind: 'prompt-injection',
							max_bytes: maxBytes,
						};
		return {
			name: skill.id,
			chat_invokable: chatInvokable,
			chat_description: chatDescription.trim(),
			invocation,
			provenance: skill.chat_overlay?.provenance ?? 'user-created',
		};
	}

	async function handleSave() {
		await onSave(buildOverlay());
	}

	async function handleQuickToggle() {
		// Used by the row-level Toggle button — no expansion required when an
		// overlay already exists; we just flip the bit and re-save.
		if (!skill.chat_overlay) {
			// No overlay yet — open the editor so the user can fill in
			// chat_description + invocation.
			onToggleExpand();
			return;
		}
		const flipped: SkillOverlay = {
			...skill.chat_overlay,
			chat_invokable: !skill.chat_overlay.chat_invokable,
		};
		await onSave(flipped);
	}

	async function handleTest() {
		testRunning = true;
		testOutput = null;
		try {
			testOutput = await onTest(testArgs);
		} finally {
			testRunning = false;
		}
	}

	const overlay = $derived(skill.chat_overlay);
	const isInvokable = $derived(overlay?.chat_invokable === true);
</script>

<div class="bg-hub-card rounded-xl border border-hub-border overflow-hidden">
	<div class="px-4 py-3 grid grid-cols-1 md:grid-cols-[auto_1fr_auto_auto] gap-4 items-start md:items-center">
		<!-- Status indicator -->
		<div class="md:pr-2 flex items-center gap-1.5">
			<span
				class="w-2 h-2 rounded-full {isInvokable ? 'bg-hub-cta' : overlay ? 'bg-hub-warning' : 'bg-hub-dim/40'}"
				title={isInvokable ? 'Chat-invokable' : overlay ? 'Configured but disabled' : 'No overlay'}
			></span>
			{#if skill.is_symlink}
				<span class="text-[10px] text-hub-dim" title="Symlink to a plugin directory">⇲</span>
			{/if}
		</div>

		<!-- Name + description + chat chip -->
		<div class="min-w-0">
			<div class="flex items-center gap-2 mb-0.5 flex-wrap">
				<h3 class="text-sm font-semibold text-hub-text truncate">{skill.id}</h3>
				{#if isInvokable}
					<span
						class="text-[10px] text-hub-cta font-medium px-1.5 py-0.5 bg-hub-cta/10 rounded border border-hub-cta/40 flex-shrink-0"
						title="The v2 orchestrator can invoke this skill from chat (ADR-009 §7)"
					>
						💬 chat
					</span>
				{/if}
				{#if overlay?.provenance === 'seed-roster'}
					<span
						class="text-[10px] text-hub-purple font-medium px-1.5 py-0.5 bg-hub-purple/10 rounded border border-hub-purple/40 flex-shrink-0"
						title="Shipped as a default chat-invokable skill"
					>
						seed
					</span>
				{/if}
			</div>
			{#if overlay?.chat_description}
				<p class="text-xs text-hub-muted truncate" title={overlay.chat_description}>
					{overlay.chat_description}
				</p>
			{:else if skill.description}
				<p class="text-xs text-hub-dim truncate" title={skill.description}>{skill.description}</p>
			{/if}
		</div>

		<!-- Invocation kind -->
		<div class="text-[11px] text-hub-muted font-mono min-w-[110px]">
			{#if overlay}
				{overlay.invocation.kind}
			{:else}
				<span class="text-hub-dim">—</span>
			{/if}
		</div>

		<!-- Actions -->
		<div class="flex items-center gap-1.5 flex-shrink-0">
			<button
				type="button"
				onclick={handleQuickToggle}
				disabled={busy}
				class="px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50
					{isInvokable
						? 'text-hub-cta hover:bg-hub-cta/10'
						: 'text-hub-dim hover:text-hub-text hover:bg-hub-bg'}"
				title={overlay
					? isInvokable
						? 'Disable for chat'
						: 'Enable for chat'
					: 'Open editor to configure'}
			>
				{isInvokable ? '✓ On' : overlay ? '○ Off' : '+ Enable'}
			</button>
			<button
				type="button"
				onclick={onToggleExpand}
				class="px-2 py-1 rounded-md text-[11px] font-medium text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
				title={expanded ? 'Hide editor' : 'Configure / test'}
				aria-expanded={expanded}
			>
				{expanded ? '↓ Hide' : '⚙ Configure'}
			</button>
		</div>
	</div>

	{#if expanded}
		<div class="bg-hub-bg/50 border-t border-hub-border/60 px-4 py-4 space-y-4">
			<!-- chat_description + chat_invokable -->
			<div class="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-3 items-start">
				<label class="flex items-center gap-2 text-xs text-hub-muted cursor-pointer pt-1">
					<input type="checkbox" bind:checked={chatInvokable} class="cursor-pointer" />
					<span>Chat-invokable</span>
				</label>
				<div>
					<label class="block text-[10px] uppercase tracking-wide text-hub-dim font-medium mb-1">
						chat_description (what the model sees)
					</label>
					<textarea
						bind:value={chatDescription}
						rows="3"
						maxlength="2000"
						class="w-full text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						placeholder="One concise paragraph telling the orchestrator when to invoke this skill."
					></textarea>
				</div>
			</div>

			<!-- Invocation kind selector -->
			<div>
				<label class="block text-[10px] uppercase tracking-wide text-hub-dim font-medium mb-1">
					Invocation
				</label>
				<div class="flex gap-2 mb-2">
					{#each ['prompt-injection', 'script', 'cli-subsession'] as k (k)}
						<button
							type="button"
							onclick={() => (invocationKind = k as InvocationKind)}
							class="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
								{invocationKind === k
									? 'bg-hub-cta/15 text-hub-cta border border-hub-cta/40'
									: 'text-hub-muted hover:text-hub-text hover:bg-hub-bg border border-hub-border/60'}"
						>
							{k}
						</button>
					{/each}
				</div>

				{#if invocationKind === 'script'}
					<div class="space-y-2">
						<input
							bind:value={cmdText}
							placeholder="python3 ~/.claude/skills/research/scripts/social_collector.py"
							class="w-full text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						/>
						<div class="grid grid-cols-2 gap-2">
							<input
								bind:value={cwd}
								placeholder="cwd (optional, defaults to skill dir)"
								class="text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
							/>
							<input
								type="number"
								bind:value={timeoutMs}
								placeholder="timeout_ms"
								class="text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
							/>
						</div>
						<p class="text-[10px] text-hub-dim">
							Args are JSON-stringified and appended as the last argv element. Most argparse-based
							scripts don't read JSON — write a wrapper if needed.
						</p>
					</div>
				{:else if invocationKind === 'prompt-injection'}
					<div class="space-y-2">
						<input
							type="number"
							bind:value={maxBytes}
							placeholder="max_bytes (default 8192)"
							class="w-full text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						/>
						<p class="text-[10px] text-hub-dim">
							Returns the SKILL.md body (capped at max_bytes) + any args. The orchestrator threads
							this back to the model so the next assistant turn synthesizes the user's request.
						</p>
					</div>
				{:else}
					<div class="space-y-2">
						<input
							bind:value={extraArgsText}
							placeholder="extra_args (e.g. --model claude-sonnet-4.6)"
							class="w-full text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						/>
						<input
							type="number"
							bind:value={timeoutMs}
							placeholder="timeout_ms (default 120000)"
							class="w-full text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						/>
						<p class="text-[10px] text-hub-warning">
							⚠ Spawns a fresh `claude -p` subprocess per invocation. Heavyweight; don't use for
							skills that already have a script entry point.
						</p>
					</div>
				{/if}
			</div>

			<!-- Save / Delete -->
			<div class="flex items-center gap-2 pt-2 border-t border-hub-border/40">
				<button
					type="button"
					onclick={handleSave}
					disabled={busy || !chatDescription.trim()}
					class="px-3 py-1.5 rounded-md text-[12px] font-medium bg-hub-cta text-black hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
				>
					{busy ? 'Saving…' : '✓ Save overlay'}
				</button>
				{#if overlay}
					<button
						type="button"
						onclick={onDelete}
						disabled={busy}
						class="px-3 py-1.5 rounded-md text-[12px] font-medium text-hub-danger hover:bg-hub-danger/10 transition-colors cursor-pointer disabled:opacity-50"
					>
						× Remove overlay
					</button>
				{/if}
				<a
					href="file://{skill.source_path}"
					class="ml-auto text-[10px] text-hub-dim font-mono hover:text-hub-muted truncate"
					title={skill.source_path}
				>
					source: {skill.source_path.replace('/Users/jneaimi', '~').slice(-60)}
				</a>
			</div>

			<!-- Test panel -->
			{#if isInvokable}
				<div class="pt-3 border-t border-hub-border/40 space-y-2">
					<label class="block text-[10px] uppercase tracking-wide text-hub-dim font-medium">
						Test run
					</label>
					<div class="flex gap-2">
						<input
							bind:value={testArgs}
							placeholder="Sample args — natural language or JSON"
							class="flex-1 text-xs bg-hub-card border border-hub-border/60 rounded-lg p-2 font-mono text-hub-text"
						/>
						<button
							type="button"
							onclick={handleTest}
							disabled={testRunning}
							class="px-3 py-1.5 rounded-md text-[12px] font-medium text-hub-info hover:bg-hub-info/10 border border-hub-info/40 transition-colors cursor-pointer disabled:opacity-50"
						>
							{testRunning ? 'Running…' : '▶ Run'}
						</button>
					</div>
					{#if testOutput}
						<div class="text-[11px]">
							<div class="flex items-center gap-2 mb-1">
								<span class={testOutput.ok ? 'text-hub-cta' : 'text-hub-danger'}>
									{testOutput.ok ? '✓' : '✗'}
								</span>
								<span class="text-hub-muted">{testOutput.durationMs}ms</span>
							</div>
							<pre class="bg-hub-card border border-hub-border/60 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-hub-muted">{testOutput.ok ? testOutput.output : testOutput.error}</pre>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
