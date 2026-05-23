<script lang="ts">
	import BackendBadge from './BackendBadge.svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';

	interface AgentLite {
		id: string;
		name: string;
		backend: Backend;
		model?: string;
		provider?: string;
		budget?: { max_usd?: number; max_turns?: number; timeout_sec?: number };
	}

	// Production defaults — must stay in sync with `PRODUCTION_DEFAULTS` in
	// src/lib/agents/dispatch/budget.ts. Used to render the production-budget
	// hint when the agent has no per-agent override.
	const PRODUCTION_DEFAULTS = { max_usd: 0.5, max_turns: 25, timeout_sec: 180 };

	interface DispatchResult {
		runId: string;
		agentId: string;
		backend: string;
		status:
			| 'success'
			| 'error'
			| 'cancelled'
			| 'timeout'
			| 'budget-exceeded'
			| 'goal_achieved';
		output: string;
		cost_usd: number;
		num_turns: number;
		duration_ms: number;
		error?: string;
	}

	type Mode = 'test' | 'production';

	interface Message {
		role: 'user' | 'agent' | 'system';
		text: string;
		ts: number;
		meta?: {
			runId?: string;
			result?: DispatchResult;
			error?: string;
		};
	}

	interface Props {
		agent: AgentLite;
	}

	const { agent }: Props = $props();

	let messages = $state<Message[]>([]);
	let task = $state('');
	let running = $state(false);
	let abortController: AbortController | null = null;
	let chatEl: HTMLDivElement | null = $state(null);
	// ADR-001 §6 test caps vs the agent's full production budget. Default
	// to `test` so an accidental click can't burn real spend. The button
	// label morphs to make the active mode unmissable.
	let mode = $state<Mode>('test');

	// Production budget hints — derived once per agent change.
	const prodMaxUsd = $derived(agent.budget?.max_usd ?? PRODUCTION_DEFAULTS.max_usd);
	const prodMaxTurns = $derived(agent.budget?.max_turns ?? PRODUCTION_DEFAULTS.max_turns);
	const prodTimeout = $derived(agent.budget?.timeout_sec ?? PRODUCTION_DEFAULTS.timeout_sec);
	const prodIsCustom = $derived(
		!!(agent.budget?.max_usd || agent.budget?.max_turns || agent.budget?.timeout_sec),
	);

	const examples: Record<Backend, string[]> = {
		'claude-pty': [
			'Say hello and confirm you can see this prompt.',
			'List the first 5 markdown files in the vault root.',
		],
		'claude-cli-flag': [
			'Reply with the single word "ready".',
			'Echo this task back verbatim.',
		],
		'ai-sdk': [
			'Reply with one sentence about your role.',
			'List 3 things you would do for a user.',
		],
	};

	function scrollToBottom() {
		queueMicrotask(() => {
			if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
		});
	}

	function pushAgentChunk(text: string) {
		const last = messages[messages.length - 1];
		if (last && last.role === 'agent' && !last.meta?.result) {
			messages = [
				...messages.slice(0, -1),
				{ ...last, text: last.text + text },
			];
		} else {
			messages = [...messages, { role: 'agent', text, ts: Date.now() }];
		}
		scrollToBottom();
	}

	async function send() {
		if (!task.trim() || running) return;

		const sentTask = task.trim();
		task = '';
		messages = [
			...messages,
			{ role: 'user', text: sentTask, ts: Date.now() },
		];
		scrollToBottom();

		running = true;
		abortController = new AbortController();

		try {
			const url =
				`/api/agents/${encodeURIComponent(agent.id)}/test` +
				(mode === 'production' ? '?mode=production' : '');
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: sentTask }),
				signal: abortController.signal,
			});

			if (!res.ok || !res.body) {
				const errText = await res.text().catch(() => '');
				let errMsg = `HTTP ${res.status}`;
				try {
					errMsg = JSON.parse(errText).message ?? errMsg;
				} catch { /* keep status */ }
				messages = [
					...messages,
					{ role: 'system', text: `Error: ${errMsg}`, ts: Date.now(), meta: { error: errMsg } },
				];
				scrollToBottom();
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl = buffer.indexOf('\n');
				while (nl >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf('\n');
					if (!line) continue;
					try {
						const ev = JSON.parse(line);
						handleEvent(ev);
					} catch {
						// ignore malformed line
					}
				}
			}
			if (buffer.trim()) {
				try { handleEvent(JSON.parse(buffer.trim())); } catch { /* drop */ }
			}
		} catch (err) {
			const msg = (err as Error).message ?? 'request failed';
			if (msg !== 'AbortError' && !abortController?.signal.aborted) {
				messages = [
					...messages,
					{ role: 'system', text: `Error: ${msg}`, ts: Date.now(), meta: { error: msg } },
				];
				scrollToBottom();
			}
		} finally {
			running = false;
			abortController = null;
		}
	}

	function handleEvent(ev: { type: string; [k: string]: unknown }) {
		if (ev.type === 'started') {
			messages = [
				...messages,
				{
					role: 'system',
					text: `Run started · ${ev.backend ?? agent.backend}${ev.model ? ' · ' + ev.model : ''}`,
					ts: Date.now(),
					meta: { runId: typeof ev.runId === 'string' ? ev.runId : undefined },
				},
			];
			scrollToBottom();
		} else if (ev.type === 'output' && typeof ev.data === 'string') {
			pushAgentChunk(ev.data);
		} else if (ev.type === 'step') {
			// Show step badges only if there are tool turns; v1 ai-sdk has no tools.
		} else if (ev.type === 'tool_call') {
			pushAgentChunk(`\n[tool: ${ev.name}]\n`);
		} else if (ev.type === 'error') {
			messages = [
				...messages,
				{
					role: 'system',
					text: `Error: ${ev.message ?? 'unknown'}`,
					ts: Date.now(),
					meta: { error: String(ev.message ?? '') },
				},
			];
			scrollToBottom();
		} else if (ev.type === 'done' && typeof ev.result === 'object') {
			const result = ev.result as DispatchResult;
			messages = [
				...messages,
				{
					role: 'system',
					text:
						`Done · ${result.status}` +
						` · ${(result.duration_ms / 1000).toFixed(1)}s` +
						(result.cost_usd > 0 ? ` · $${result.cost_usd.toFixed(4)}` : '') +
						(result.num_turns > 0 ? ` · ${result.num_turns} turn${result.num_turns === 1 ? '' : 's'}` : ''),
					ts: Date.now(),
					meta: { result },
				},
			];
			scrollToBottom();
		}
	}

	function cancel() {
		abortController?.abort();
	}

	function clear() {
		if (running) return;
		messages = [];
	}

	function useExample(text: string) {
		task = text;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="flex flex-col h-full bg-hub-card border border-hub-border rounded-xl overflow-hidden">
	<!-- Header -->
	<div class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-bg/40">
		<div class="flex items-center gap-2 flex-wrap">
			<h2 class="text-sm font-semibold text-hub-text">Test in chat</h2>
			<BackendBadge backend={agent.backend} size="sm" />
			{#if agent.model}
				<code class="text-[10px] text-hub-dim font-mono">{agent.model}</code>
			{/if}
			{#if agent.provider}
				<span class="text-[10px] text-hub-dim">via {agent.provider}</span>
			{/if}
			<div class="flex-1"></div>
			<button
				type="button"
				onclick={clear}
				disabled={running || messages.length === 0}
				class="text-[11px] text-hub-muted hover:text-hub-text disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
			>
				Clear
			</button>
		</div>
		<p class="text-[10px] text-hub-dim mt-1.5">
			Test runs use hard caps: <span class="text-hub-warning">max $0.10 · 5 turns · 60s timeout</span>.
			Production dispatches use
			<span class="text-hub-text">max ${prodMaxUsd.toFixed(2)} · {prodMaxTurns} turns · {prodTimeout}s timeout</span>
			{#if prodIsCustom}<span class="text-hub-muted">(per-agent override)</span>{:else}<span class="text-hub-muted">(default)</span>{/if}.
		</p>

		<!-- Mode toggle — defaults to test. Production sends through the same
		     `dispatchAgent` path as a chat-triggered run, so goal_condition
		     on PTY-backed agents fires correctly. -->
		<div class="mt-2 inline-flex rounded-md border border-hub-border overflow-hidden text-[11px]">
			<button
				type="button"
				onclick={() => (mode = 'test')}
				disabled={running}
				class="px-2.5 py-1 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60
					{mode === 'test'
						? 'bg-hub-warning/20 text-hub-warning'
						: 'bg-transparent text-hub-muted hover:text-hub-text'}"
			>
				Test mode <span class="text-[9px] opacity-75">($0.10 cap)</span>
			</button>
			<button
				type="button"
				onclick={() => (mode = 'production')}
				disabled={running}
				class="px-2.5 py-1 border-l border-hub-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60
					{mode === 'production'
						? 'bg-hub-cta/20 text-hub-cta'
						: 'bg-transparent text-hub-muted hover:text-hub-text'}"
			>
				Production <span class="text-[9px] opacity-75">(${prodMaxUsd.toFixed(2)} cap)</span>
			</button>
		</div>
	</div>

	<!-- Messages -->
	<div bind:this={chatEl} class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
		{#if messages.length === 0}
			<div class="text-center py-8">
				<p class="text-xs text-hub-dim mb-3">Try a sample task:</p>
				<div class="flex flex-col gap-1.5 items-center">
					{#each examples[agent.backend] ?? [] as ex (ex)}
						<button
							type="button"
							onclick={() => useExample(ex)}
							class="text-[11px] text-hub-info hover:text-hub-text bg-hub-bg/40 hover:bg-hub-bg border border-hub-border/60 rounded-md px-3 py-1.5 transition-colors cursor-pointer max-w-md"
						>
							{ex}
						</button>
					{/each}
				</div>
			</div>
		{:else}
			{#each messages as msg, i (i)}
				<div
					class="flex gap-2 {msg.role === 'user' ? 'flex-row-reverse' : ''}"
				>
					<div class="flex-shrink-0 mt-0.5 text-[10px] uppercase tracking-wide font-medium
						{msg.role === 'user' ? 'text-hub-cta'
						: msg.role === 'agent' ? 'text-hub-purple'
						: 'text-hub-dim'}">
						{msg.role}
					</div>
					<div class="flex-1 min-w-0 {msg.role === 'user' ? 'text-right' : ''}">
						<div
							class="inline-block px-3 py-2 rounded-lg text-[13px] whitespace-pre-wrap break-words text-left
								{msg.role === 'user'
									? 'bg-hub-cta/15 border border-hub-cta/30 text-hub-text'
									: msg.role === 'agent'
										? 'bg-hub-bg/60 border border-hub-border text-hub-text font-mono'
										: msg.meta?.error
											? 'bg-hub-danger/10 border border-hub-danger/40 text-hub-danger'
											: msg.meta?.result?.status === 'success'
												? 'bg-hub-cta/10 border border-hub-cta/30 text-hub-muted'
												: 'bg-hub-bg/60 border border-hub-border text-hub-muted'}"
						>
							{msg.text || '…'}
						</div>
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Composer -->
	<div class="flex-shrink-0 px-4 py-3 border-t border-hub-border bg-hub-bg/40">
		<div class="flex gap-2">
			<textarea
				bind:value={task}
				onkeydown={onKey}
				rows="2"
				placeholder={mode === 'production'
					? `Type a task and press ⌘↩ — production caps ($${prodMaxUsd.toFixed(2)} · ${prodMaxTurns} turns · ${prodTimeout}s) apply`
					: 'Type a task and press ⌘↩ (or click Send) — test caps apply'}
				disabled={running}
				class="flex-1 px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-[13px] text-hub-text font-mono resize-none focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50 disabled:opacity-60"
			></textarea>
			{#if running}
				<button
					type="button"
					onclick={cancel}
					class="px-3 py-1.5 rounded-lg bg-hub-danger/15 border border-hub-danger/40 text-hub-danger text-sm font-medium hover:bg-hub-danger/25 transition-colors cursor-pointer self-end"
				>
					Cancel
				</button>
			{:else}
				<button
					type="button"
					onclick={send}
					disabled={!task.trim()}
					class="px-3 py-1.5 rounded-lg font-medium text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed self-end
						{mode === 'production'
							? 'bg-hub-warning text-black hover:bg-hub-warning/90'
							: 'bg-hub-cta text-black hover:bg-hub-cta/90'}"
					title={mode === 'production' ? 'Production dispatch — uses real budget' : 'Test run — capped'}
				>
					{mode === 'production' ? 'Run production' : 'Send'}
				</button>
			{/if}
		</div>
	</div>
</div>
