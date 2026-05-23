<script lang="ts">
	import AgentTerminal from './AgentTerminal.svelte';
	import LogTerminal from './LogTerminal.svelte';
	import ClaudeSessionPanel from './session/ClaudeSessionPanel.svelte';

	interface Props {
		cwd: string;
		projectName: string;
		initialPrompt?: string;
		autoStart?: boolean;
		/** When autoStart is true, spawn a shell instead of a Claude Code session */
		autoStartShell?: boolean;
		onReady?: () => void;
	}

	interface Tab {
		id: string;
		label: string;
		prompt: string;
		started: boolean;
		ref?: AgentTerminal;
		/** If set, this tab shows a read-only log instead of a live terminal */
		logData?: string;
		logRef?: LogTerminal;
		/** Session ID for reconnecting alive sessions */
		sessionId?: string;
		/** Pass --continue to resume the most recent Claude session in this cwd */
		continueSession?: boolean;
		/** Plain shell tab (zsh/bash instead of Claude Code) */
		shell?: boolean;
		/** PTY session id for dead-session tabs — used by ClaudeSessionPanel to query /api/sessions/[id]/claude */
		ptyId?: string;
		/** Sub-view inside a dead-session tab: terminal log or Claude metadata */
		logView?: 'terminal' | 'claude';
	}

	interface HistorySession {
		id: string;
		prompt: string;
		cwd: string;
		status: string;
		exitCode?: number;
		startedAt: string;
		endedAt?: string;
		alive: boolean;
	}

	let { cwd, projectName, initialPrompt = '', autoStart = false, autoStartShell = false, onReady }: Props = $props();

	let tabs = $state<Tab[]>([]);
	let activeTabId = $state('');
	let promptInput = $state('');
	let nextNum = $state(1);
	let nextShellNum = $state(1);
	let showHistory = $state(false);
	let historySessions = $state<HistorySession[]>([]);
	let historyLoading = $state(false);
	let historyBtnEl: HTMLButtonElement | undefined = $state();
	let historyDropdownTop = $state(0);
	let historyDropdownRight = $state(0);

	async function loadHistory() {
		if (showHistory) { showHistory = false; return; }
		// Position the dropdown relative to the button
		if (historyBtnEl) {
			const rect = historyBtnEl.getBoundingClientRect();
			historyDropdownTop = rect.bottom + 4;
			historyDropdownRight = window.innerWidth - rect.right;
		}
		historyLoading = true;
		showHistory = true;
		try {
			const res = await fetch('/api/sessions?limit=20');
			const data = await res.json();
			// Filter to sessions matching current cwd (or show all if no cwd)
			historySessions = (data.sessions || []).filter((s: HistorySession) =>
				!cwd || s.cwd === cwd || s.cwd.startsWith(cwd)
			);
		} catch { historySessions = []; }
		historyLoading = false;
	}

	async function openHistorySession(session: HistorySession) {
		showHistory = false;
		if (session.alive) {
			// Alive session: create a tab that reconnects
			const id = crypto.randomUUID().slice(0, 8);
			const label = sessionTitle(session);
			const tab: Tab = { id, label, prompt: '', started: true, sessionId: session.id };
			tabs = [...tabs, tab];
			activeTabId = id;
			// Reconnect after DOM renders
			setTimeout(() => {
				const t = tabs.find(t => t.id === id);
				if (t?.ref) {
					// Use internal reconnect by providing sessionId
					t.ref.spawn(); // spawn with no prompt opens interactive
				}
			}, 150);
		} else {
			// Dead session: fetch log and show in LogTerminal tab
			try {
				const res = await fetch(`/api/sessions/${session.id}?logBytes=131072`);
				const data = await res.json();
				const id = crypto.randomUUID().slice(0, 8);
				const label = `${sessionTitle(session)} (log)`;
				const tab: Tab = { id, label, prompt: session.prompt, started: false, logData: data.log || '(no output recorded)', ptyId: session.id, logView: 'terminal' };
				tabs = [...tabs, tab];
				activeTabId = id;
			} catch (e) {
				console.error('Failed to load session log:', e);
			}
		}
	}

	function restartFromLog(tab: Tab) {
		// Close the log tab first, then create a fresh terminal after DOM settles
		const hadOtherTabs = tabs.length > 1;
		closeTab(tab.id);

		// Wait for Svelte to process the tab removal, then create the new terminal
		setTimeout(() => {
			const id = crypto.randomUUID().slice(0, 8);
			const label = `Terminal ${nextNum}`;
			nextNum++;
			const newTab: Tab = { id, label, prompt: '', started: false, continueSession: true };
			tabs = [...tabs, newTab];
			activeTabId = id;

			// Retry spawn until AgentTerminal ref is bound (async xterm imports)
			let attempts = 0;
			const trySpawn = () => {
				attempts++;
				const t = tabs.find(t => t.id === id);
				if (t?.ref) {
					t.ref.spawn('', { continueSession: true });
				} else if (attempts < 15) {
					setTimeout(trySpawn, 200);
				}
			};
			setTimeout(trySpawn, 300);
		}, 50);
	}

	function sessionTitle(s: HistorySession): string {
		const project = s.cwd.split('/').pop() || 'terminal';
		if (s.prompt) return s.prompt.slice(0, 50);
		return project;
	}

	function timeAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	function createTab(prompt: string = '', autoStart: boolean = false, opts?: { shell?: boolean }) {
		const id = crypto.randomUUID().slice(0, 8);
		const isShell = opts?.shell === true;
		const label = isShell ? `Shell ${nextShellNum}` : `Terminal ${nextNum}`;
		if (isShell) nextShellNum++; else nextNum++;
		const tab: Tab = { id, label, prompt, started: autoStart, shell: isShell };
		tabs = [...tabs, tab];
		activeTabId = id;

		if (autoStart) {
			// Spawn after DOM renders the terminal — retry until ref is bound
			let attempts = 0;
			const trySpawn = () => {
				attempts++;
				const t = tabs.find((t) => t.id === id);
				if (t?.ref) {
					t.ref.spawn(isShell ? undefined : prompt, { shell: isShell });
					onReady?.();
				} else if (attempts < 10) {
					setTimeout(trySpawn, 200);
				}
			};
			setTimeout(trySpawn, 150);
		}
	}

	function closeTab(id: string) {
		const tab = tabs.find((t) => t.id === id);
		if (tab?.ref) {
			tab.ref.kill();
		}
		const idx = tabs.findIndex((t) => t.id === id);
		tabs = tabs.filter((t) => t.id !== id);

		if (activeTabId === id && tabs.length > 0) {
			// Switch to nearest tab
			const newIdx = Math.min(idx, tabs.length - 1);
			activeTabId = tabs[newIdx].id;
		}
	}

	function handleRun() {
		if (!promptInput.trim() && tabs.length === 0) {
			// Open terminal with no prompt
			createTab('', true);
			return;
		}
		if (promptInput.trim()) {
			createTab(promptInput.trim(), true);
			promptInput = '';
		}
	}

	function handleOpen() {
		createTab('', true);
	}

	function handleShell() {
		createTab('', true, { shell: true });
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleRun();
		}
	}

	const activeTab = $derived(tabs.find((t) => t.id === activeTabId));

	// Auto-create first tab when autoStart is true (handles both initial and late-set)
	let initialTabCreated = false;
	$effect(() => {
		if (autoStart && !initialTabCreated && tabs.length === 0) {
			initialTabCreated = true;
			// Use tick to ensure DOM is ready
			setTimeout(() => createTab(initialPrompt || '', true, { shell: autoStartShell }), 100);
		}
	});

	/** Send a prompt to the active terminal, or create a new one if none exists */
	export function sendToActive(prompt: string) {
		if (tabs.length === 0) {
			createTab(prompt, true);
		} else {
			// Create a new tab with the prompt
			createTab(prompt, true);
		}
	}
</script>

<div class="flex flex-col h-full">
	<!-- Tab bar + prompt (when no tabs or adding new) -->
	{#if tabs.length > 0}
		<div class="flex-shrink-0 flex items-center bg-[#0a0a0f] border-b border-hub-border/50 overflow-x-auto relative z-20">
			{#each tabs as tab (tab.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					onclick={() => activeTabId = tab.id}
					class="group flex items-center gap-1.5 px-3 py-2 text-xs border-r border-hub-border/30 whitespace-nowrap transition-colors cursor-pointer select-none
						{tab.id === activeTabId ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50'}"
				>
					<span class="w-1.5 h-1.5 rounded-full {tab.id === activeTabId ? 'bg-hub-cta' : 'bg-hub-dim/50'}"></span>
					{tab.label}
					<button
						onclick={(e: MouseEvent) => { e.stopPropagation(); closeTab(tab.id); }}
						class="ml-1 p-0.5 rounded hover:bg-hub-danger/20 hover:text-hub-danger transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
						title="Close terminal"
					>
						<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
						</svg>
					</button>
				</div>
			{/each}
			<button
				onclick={() => handleOpen()}
				class="px-3 py-2 text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50 transition-colors cursor-pointer"
				title="New Claude terminal"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
			</button>
			<button
				onclick={() => handleShell()}
				class="px-3 py-2 text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50 transition-colors cursor-pointer"
				title="New shell (zsh)"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
			</button>

			<!-- History dropdown -->
			<div class="ml-auto">
				<button
					bind:this={historyBtnEl}
					onclick={loadHistory}
					class="px-3 py-2 text-xs text-hub-dim hover:text-hub-muted hover:bg-hub-surface/50 transition-colors cursor-pointer flex items-center gap-1"
					title="Session history"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
					</svg>
					<span>History</span>
				</button>
			</div>
		</div>

	{/if}

		{#if showHistory}
			<!-- Fixed-position dropdown, not clipped by overflow -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="fixed inset-0 z-40" onclick={() => showHistory = false}></div>
			<div
				class="fixed w-72 max-h-64 overflow-y-auto bg-[#111118] border border-hub-border rounded-lg shadow-2xl z-50"
				style="top: {historyDropdownTop}px; right: {historyDropdownRight}px;"
			>
						<div class="px-3 py-1.5 border-b border-hub-border/50 text-[10px] text-hub-dim uppercase tracking-wider">Recent sessions</div>
						{#if historyLoading}
							<div class="px-3 py-4 text-center text-xs text-hub-dim">Loading...</div>
						{:else if historySessions.length === 0}
							<div class="px-3 py-4 text-center text-xs text-hub-dim">No past sessions</div>
						{:else}
							{#each historySessions as session (session.id)}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									onclick={() => openHistorySession(session)}
									class="flex items-center gap-2 px-3 py-2 hover:bg-hub-surface/60 cursor-pointer border-b border-hub-border/20 last:border-0 transition-colors"
								>
									<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {session.alive ? 'bg-green-400 animate-pulse' : session.exitCode === 0 ? 'bg-hub-dim' : 'bg-red-400'}"></span>
									<div class="flex-1 min-w-0">
										<div class="text-[11px] text-hub-text truncate leading-tight">
											{sessionTitle(session)}
										</div>
										<div class="text-[10px] text-hub-dim leading-tight">
											{session.id} · {timeAgo(session.startedAt)}
											{#if session.alive}<span class="text-green-400">alive</span>{/if}
										</div>
									</div>
									<span class="text-[10px] px-1.5 py-0.5 rounded {session.alive ? 'bg-green-400/10 text-green-400' : 'bg-hub-surface text-hub-dim'}">
										{session.alive ? 'Resume' : 'View'}
									</span>
								</div>
							{/each}
						{/if}
			</div>
		{/if}

	<!-- Terminal area -->
	{#if tabs.length === 0}
		<!-- No terminals yet — show prompt -->
		<div class="flex-1 flex flex-col">
			<div class="px-4 sm:px-6 py-4 border-b border-hub-border bg-hub-surface/50">
				<div class="space-y-3">
					<div>
						<div class="flex items-center justify-between mb-1">
							<label for="prompt-input" class="text-[10px] text-hub-dim uppercase tracking-wider">Prompt</label>
							<span class="text-[10px] text-hub-dim">Shift+Enter for new line</span>
						</div>
						<textarea
							id="prompt-input"
							bind:value={promptInput}
							onkeydown={handleKeydown}
							placeholder="What should the agent do?"
							rows="3"
							class="w-full bg-hub-card border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-dim resize-none focus:outline-none focus:border-hub-cta/50"
						></textarea>
					</div>
					<div class="flex items-center gap-2">
						<button
							onclick={handleRun}
							disabled={!promptInput.trim()}
							class="px-6 py-2.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
						>
							Run Agent
						</button>
						<button
							onclick={handleOpen}
							class="px-6 py-2.5 rounded-lg bg-hub-card border border-hub-border text-hub-text font-medium text-sm hover:bg-hub-surface hover:border-hub-dim transition-colors cursor-pointer"
						>
							Open Terminal
						</button>
						<button
							onclick={handleShell}
							class="px-5 py-2.5 rounded-lg bg-hub-card border border-hub-border text-hub-muted font-medium text-sm hover:bg-hub-surface hover:border-hub-dim hover:text-hub-text transition-colors cursor-pointer"
						>
							Shell
						</button>
					</div>
				</div>
			</div>
			<div class="flex-1 flex items-center justify-center">
				<div class="text-center">
					<svg class="w-12 h-12 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
					</svg>
					<p class="text-sm text-hub-dim">Enter a prompt or open a terminal to start</p>
				</div>
			</div>
		</div>
	{:else}
		<!-- Active terminal -->
		{#each tabs as tab (tab.id)}
			<div class="flex-1 min-h-0 {tab.id === activeTabId ? '' : 'hidden'}">
				{#if tab.logData !== undefined}
					<!-- Read-only log viewer for dead sessions -->
					<div class="flex flex-col h-full">
						<div class="flex items-center justify-between px-3 py-2 bg-[#0a0a0f] border-b border-hub-border/50 text-xs">
							<div class="flex items-center gap-2 min-w-0">
								<div class="flex items-center gap-0.5 bg-hub-bg/60 rounded p-0.5 flex-shrink-0">
									<button
										onclick={() => { tabs = tabs.map((t) => t.id === tab.id ? { ...t, logView: 'terminal' } : t); }}
										class="px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer {(tab.logView ?? 'terminal') === 'terminal' ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
									>Terminal</button>
									{#if tab.ptyId}
										<button
											onclick={() => { tabs = tabs.map((t) => t.id === tab.id ? { ...t, logView: 'claude' } : t); }}
											class="px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer {tab.logView === 'claude' ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
										>Claude</button>
									{/if}
								</div>
								{#if tab.prompt}
									<span class="text-hub-muted truncate max-w-md">{tab.prompt.slice(0, 80)}</span>
								{/if}
							</div>
							<button
								onclick={() => restartFromLog(tab)}
								class="px-3 py-1 rounded text-xs bg-hub-purple/15 text-hub-purple hover:bg-hub-purple/25 transition-colors cursor-pointer flex-shrink-0"
							>
								Resume Session
							</button>
						</div>
						<div class="flex-1 min-h-0">
							{#if tab.logView === 'claude' && tab.ptyId}
								<ClaudeSessionPanel ptySessionId={tab.ptyId} />
							{:else}
								<LogTerminal bind:this={tab.logRef} data={tab.logData} maxHeight="100%" />
							{/if}
						</div>
					</div>
				{:else}
					<!-- Live interactive terminal -->
					<AgentTerminal
						bind:this={tab.ref}
						cwd={cwd}
						prompt={tab.prompt}
						{projectName}
						continueSession={tab.continueSession || false}
						shell={tab.shell || false}
					/>
				{/if}
			</div>
		{/each}
	{/if}
</div>
