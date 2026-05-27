<!--
  ADR-004 / ADR-005 — Chat drawer UI: global bottom-docked surface + scope chip +
  engine toggle.

  Mounts inside the root flex-column layout (beside AppHeader) as a `flex-shrink-0`
  bottom strip — terminal idiom: collapsed header bar or expanded transcript panel.
  Height is resizable via the top drag handle; open/height are session-persisted.

  Scope chip is derived from `$page.route.id` + `$page.params` (mirrors the
  server-side resolveScope contributor map from ADR-002). No vault reads on the
  client; the server resolves the full ScopeDescriptor on each POST /api/chat/web.

  Engine toggle (ADR-005):
    • Orchestrator — SSE-streamed web chat (ADR-003), was the only active option.
    • Claude PTY   — interactive `claude` via pty/manager.ts in scope.cwd, with
                     scope.primer injected as the opening orientation. Session
                     persists across drawer collapse via keepAlive=true; the
                     session ID is tracked in `ptySessionId` so re-open reconnects
                     rather than spawning fresh. Scope change kills the session.

  Safety: vault-scope cwd writes still hit the ADR-046 hook; the PTY engine does
  not bypass governance — it is the operator's own machine (single-user model).

  Reactivity: Svelte-5 rules throughout — `$state` / `$derived` / `$effect`,
  immutable array updates (no `array.push`).
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import AgentTerminal from '$lib/components/AgentTerminal.svelte';

	// ── Session-persistence keys ────────────────────────────────────────────────
	const OPEN_KEY   = 'chat-drawer-open';
	const HEIGHT_KEY = 'chat-drawer-height';

	// ── Height constraints ──────────────────────────────────────────────────────
	const HEADER_PX  = 36;   // px height of the collapsed header bar
	const DEFAULT_H  = 280;  // default body height when first opened
	const MIN_H      = 120;
	const MAX_H      = 560;

	// ── State ───────────────────────────────────────────────────────────────────
	let open    = $state(false);
	let height  = $state(DEFAULT_H);
	/** Engine choice — ADR-005: both engines are now active. */
	let engine  = $state<'orchestrator' | 'pty'>('orchestrator');

	// ── PTY engine state (ADR-005) ──────────────────────────────────────────────
	/** Scope cwd resolved from /api/chat/scope — set when engine='pty' first opens. */
	let ptyCwd        = $state('');
	/** Scope primer resolved from /api/chat/scope — opening orientation for the session. */
	let ptyPrimer     = $state('');
	/** True after scope was fetched — gates AgentTerminal render. */
	let ptyReady      = $state(false);
	/** In-flight scope fetch. */
	let ptyLoading    = $state(false);
	/** Scope fetch error message. */
	let ptyError      = $state('');
	/**
	 * Last known PTY session ID, set via AgentTerminal's `onSessionStart` callback.
	 * Non-empty → reconnect on next open (keepAlive=true keeps the server session
	 * alive across drawer collapse).
	 */
	let ptySessionId  = $state('');
	/** Bound reference to the mounted AgentTerminal (available only when open+pty). */
	let ptyTerminal: AgentTerminal | undefined = $state();

	// Transcript
	type MsgRole = 'user' | 'assistant' | 'tool' | 'workbench';

	/** ADR-007: live state of a workbench dispatch card rendered in chat. */
	interface WorkbenchDispatch {
		agentId:    string;
		task:       string;
		subject?:   string;
		/** Lifecycle: offered → dispatching (fire POST) → running (got runId) →
		 *  done | error (terminal poll). */
		status:     'offered' | 'dispatching' | 'running' | 'done' | 'error';
		runId?:     string;
		runStatus?: string;
		runCost?:   number;
		runTurns?:  number;
		errorMsg?:  string;
	}

	interface ChatMsg {
		id:          string;
		role:        MsgRole;
		text:        string;
		toolName?:   string;
		toolOk?:     boolean;
		streaming?:  boolean;
		/** Present when role === 'workbench' (ADR-007). */
		dispatch?:   WorkbenchDispatch;
	}

	let messages    = $state<ChatMsg[]>([]);
	let input       = $state('');
	let sending     = $state(false);
	let streamError = $state('');

	// Resize drag
	let resizing       = $state(false);
	let anchorY        = 0;
	let anchorH        = 0;

	// Auto-scroll DOM ref
	let scrollEl: HTMLDivElement | undefined = $state();

	// ── Workbench dispatch poll timers (ADR-007) ────────────────────────────────
	/** cardId → interval handle; cleared when the run reaches a terminal status. */
	const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

	// ── Scope chip (client-side mirror of resolveScope contributor map) ─────────
	// We only need the chip display + params for POST /api/chat/web.
	// The server runs the full pure resolve (vault reads + CRM lookups included).
	//
	// ADR-002 P1: project — /projects/[slug]
	// ADR-006 P3: vault-note   — /vault?note=<path>
	//             crm-contact  — /crm?id=<contactId>
	//             inbox-thread — /inbox
	const scopeKind = $derived.by(() => {
		const rid  = $page.route?.id ?? '';
		const slug = $page.params?.slug ?? '';
		if (slug && rid === '/projects/[slug]') return 'project' as const;
		if (rid === '/vault' && $page.url.searchParams.get('note')) return 'vault-note' as const;
		if (rid === '/crm'   && $page.url.searchParams.get('id'))   return 'crm-contact' as const;
		if (rid === '/inbox')                                         return 'inbox-thread' as const;
		return 'global' as const;
	});

	// Scope-specific identifiers (derived from URL params, not route params)
	const scopeSlug      = $derived(scopeKind === 'project'     ? ($page.params?.slug ?? '')                          : '');
	const scopeNotePath  = $derived(scopeKind === 'vault-note'  ? ($page.url.searchParams.get('note') ?? '')          : '');
	const scopeContactId = $derived(scopeKind === 'crm-contact' ? ($page.url.searchParams.get('id') ?? '')            : '');

	/** Serialisable params object sent to the server on every turn. */
	const scopeParams = $derived.by((): Record<string, string> => {
		if (scopeKind === 'project')     return { slug: scopeSlug };
		if (scopeKind === 'vault-note')  return { notePath: scopeNotePath };
		if (scopeKind === 'crm-contact') return { contactId: scopeContactId };
		return {};
	});

	const chipLabel = $derived.by(() => {
		switch (scopeKind) {
			case 'project':     return `project: ${scopeSlug}`;
			case 'vault-note':  return `note: ${scopeNotePath.split('/').pop()?.replace(/\.md$/, '') ?? 'vault'}`;
			case 'crm-contact': return `contact: ${scopeContactId}`;
			case 'inbox-thread': return 'inbox';
			default:            return 'Soul Hub';
		}
	});

	// ── Session init ────────────────────────────────────────────────────────────
	onMount(() => {
		try {
			const sv = sessionStorage.getItem(OPEN_KEY);
			if (sv !== null) open = sv === 'true';
			const hv = sessionStorage.getItem(HEIGHT_KEY);
			if (hv) {
				const n = parseInt(hv, 10);
				if (!Number.isNaN(n) && n >= MIN_H && n <= MAX_H) height = n;
			}
		} catch { /* sessionStorage unavailable (private mode etc.) */ }
	});

	onDestroy(() => {
		// Clear all workbench poll timers to prevent memory leaks (ADR-007).
		for (const handle of pollTimers.values()) clearInterval(handle);
		pollTimers.clear();
	});

	// ── Persist open/height ─────────────────────────────────────────────────────
	$effect(() => {
		try { sessionStorage.setItem(OPEN_KEY,   String(open));   } catch { /**/ }
	});
	$effect(() => {
		try { sessionStorage.setItem(HEIGHT_KEY, String(height)); } catch { /**/ }
	});

	// ── Auto-scroll ─────────────────────────────────────────────────────────────
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		messages; // track changes
		if (scrollEl && open) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	});

	// ── PTY engine: scope fetch + activation (ADR-005) ──────────────────────────

	/**
	 * Fetch `cwd` + `primer` from GET /api/chat/scope for the current scope.
	 * Idempotent: early-returns if already loaded.  Called when drawer opens in
	 * PTY mode or when the user switches the engine toggle to 'pty'.
	 */
	async function activatePty() {
		if (ptyReady || ptyLoading) return;
		ptyLoading = true;
		ptyError   = '';
		try {
			// Build query params from the current scope kind + identifier.
			const params = new URLSearchParams({ scopeKind });
			if (scopeKind === 'project'     && scopeSlug)      params.set('slug',      scopeSlug);
			if (scopeKind === 'vault-note'  && scopeNotePath)  params.set('notePath',  scopeNotePath);
			if (scopeKind === 'crm-contact' && scopeContactId) params.set('contactId', scopeContactId);
			const res = await fetch(`/api/chat/scope?${params.toString()}`);
			if (!res.ok) {
				const d = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(d.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json() as { cwd: string; primer: string };
			ptyCwd    = data.cwd;
			ptyPrimer = data.primer;
			ptyReady  = true;
		} catch (err) {
			ptyError = err instanceof Error ? err.message : 'Failed to load scope';
		} finally {
			ptyLoading = false;
		}
	}

	/** Kill the live PTY session and reset all PTY state. */
	function resetPty() {
		ptyTerminal?.kill();
		ptySessionId = '';
		ptyReady     = false;
		ptyCwd       = '';
		ptyPrimer    = '';
		ptyError     = '';
	}

	/**
	 * Switch the engine.  Cleans up the PTY session when leaving 'pty' mode so
	 * the server-side session is not orphaned.
	 */
	function setEngine(e: 'orchestrator' | 'pty') {
		if (engine === 'pty' && e !== 'pty') resetPty();
		engine = e;
	}

	/**
	 * Activate PTY scope whenever the engine is 'pty' AND the drawer is open AND
	 * scope is not yet loaded.  Reading `ptyReady` / `ptyLoading` inside the
	 * effect means Svelte re-evaluates after resetPty() clears them, which
	 * re-fetches scope if the scope changed while PTY was active.
	 */
	$effect(() => {
		if (engine === 'pty' && open && !ptyReady && !ptyLoading) {
			void activatePty();
		}
	});

	// ── Clear transcript + PTY when scope changes ─────────────────────────────
	let _prevScopeKey = '';
	$effect(() => {
		// Stable key across all contributor kinds — JSON stringify ensures
		// notePath/contactId changes also clear the transcript.
		const key = `${scopeKind}:${JSON.stringify(scopeParams)}`;
		if (_prevScopeKey && key !== _prevScopeKey) {
			// Orchestrator: clear chat transcript
			messages    = [];
			streamError = '';
			// PTY: kill current session and mark scope stale so it re-fetches
			if (engine === 'pty') resetPty();
		}
		_prevScopeKey = key;
	});

	// ── Send message ────────────────────────────────────────────────────────────
	async function send() {
		const text = input.trim();
		if (!text || sending) return;

		// Append user turn immediately (immutable update — ADR-004 Svelte-5 rule).
		messages = [...messages, { id: `u-${Date.now()}`, role: 'user', text }];
		input       = '';
		sending     = true;
		streamError = '';

		/** Map toolName → message id for intermediate tool events. */
		const activeTools = new Map<string, string>();
		let   bubbleId: string | null = null;

		try {
			const res = await fetch('/api/chat/web', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({
					message:     text,
					scopeKind,
					scopeParams,
				}),
			});

			if (!res.ok || !res.body) {
				const d = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(d.error ?? `HTTP ${res.status}`);
			}

			// Drain the SSE stream (text/event-stream — "data: <JSON>\n\n" per event).
			const reader = res.body.getReader();
			const dec    = new TextDecoder();
			let   buf    = '';

			outer: for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });

				const parts = buf.split('\n\n');
				buf = parts.pop() ?? '';

				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data: ')) continue;
					let ev: Record<string, unknown>;
					try { ev = JSON.parse(line.slice(6)); } catch { continue; }

					switch (ev.kind) {
						case 'bubble': {
							// Presence bubble: new assistant message or initial text.
							const mid = String(ev.messageId ?? `b-${Date.now()}`);
							bubbleId  = mid;
							const exists = messages.some(m => m.id === mid);
							messages  = exists
								? messages.map(m =>
									m.id === mid
										? { ...m, text: String(ev.text ?? ''), streaming: true }
										: m,
								)
								: [...messages, {
									id: mid, role: 'assistant' as MsgRole,
									text: String(ev.text ?? ''), streaming: true,
								}];
							break;
						}
						case 'bubble-update': {
							// In-place text update for the current bubble.
							const mid = String(ev.messageId ?? bubbleId ?? '');
							if (mid) {
								messages = messages.map(m =>
									m.id === mid
										? { ...m, text: String(ev.text ?? ''), streaming: true }
										: m,
								);
							}
							break;
						}
						case 'tool-call-start': {
							// Intermediate tool-activity indicator.
							const toolName = String(ev.toolName ?? 'tool');
							const tid      = `t-${Date.now()}-${toolName}`;
							activeTools.set(toolName, tid);
							messages = [...messages, {
								id: tid, role: 'tool' as MsgRole,
								text: `⚙ ${toolName}`, toolName, streaming: true,
							}];
							break;
						}
						case 'tool-result': {
							// Resolve the pending tool indicator.
							const toolName = String(ev.toolName ?? '');
							const tid      = activeTools.get(toolName);
							const ok       = ev.ok !== false;
							if (tid) {
								messages = messages.map(m =>
									m.id === tid
										? { ...m, text: `${ok ? '✓' : '✗'} ${toolName}`, toolOk: ok, streaming: false }
										: m,
								);
							}
							break;
						}
						case 'complete': {
							// Terminal: finalize the current bubble's streaming state.
							if (bubbleId) {
								messages = messages.map(m =>
									m.id === bubbleId ? { ...m, streaming: false } : m,
								);
							}
							// ADR-007: if the orchestrator produced a dispatch output,
							// inject a workbench card below the resolved bubble so the
							// operator can launch the heavy build with one click.
							const out = ev.output as { kind?: string; agentId?: string; task?: string; subject?: string } | undefined;
							if (out?.kind === 'dispatch' && out.agentId && out.task) {
								const cardId = `wb-${Date.now()}`;
								const dispatch: WorkbenchDispatch = {
									agentId: String(out.agentId),
									task:    String(out.task),
									subject: out.subject ? String(out.subject) : undefined,
									status:  'offered',
								};
								messages = [...messages, {
									id:       cardId,
									role:     'workbench' as MsgRole,
									text:     '',
									dispatch,
								}];
							}
							break outer; // stream is done; stop reading
						}
						case 'error': {
							streamError = String(ev.message ?? 'Error from assistant.');
							break outer;
						}
					}
				}
			}
		} catch (err) {
			streamError = err instanceof Error ? err.message : 'Failed to send message.';
		} finally {
			sending  = false;
			// Ensure all streaming flags are cleared (guards against dropped connections).
			messages = messages.map(m => m.streaming ? { ...m, streaming: false } : m);
		}
	}

	// ── Workbench dispatch (ADR-007) ────────────────────────────────────────────

	/**
	 * Fire the agent test endpoint for the workbench card identified by `cardId`.
	 * Reads NDJSON until we get `{type:'started', runId}` then cancels the stream —
	 * the actual work runs in the background (fire-and-forget after runId is
	 * captured).  Transitions: offered → dispatching → running.
	 */
	async function dispatchToWorkbench(cardId: string): Promise<void> {
		const card = messages.find(m => m.id === cardId);
		if (!card?.dispatch || card.dispatch.status !== 'offered') return;

		const d = card.dispatch;

		// Mark as dispatching immediately so the button is disabled.
		messages = messages.map(m =>
			m.id === cardId
				? { ...m, dispatch: { ...d, status: 'dispatching' as const } }
				: m,
		);

		try {
			const body: Record<string, string> = { task: d.task };
			if (d.subject) body.subject = d.subject;

			const res = await fetch(`/api/agents/${encodeURIComponent(d.agentId)}/test?mode=production`, {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify(body),
			});

			if (!res.ok || !res.body) {
				const errData = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(errData.error ?? `HTTP ${res.status}`);
			}

			// Drain NDJSON lines until we see {type:'started', runId} then bail.
			const reader = res.body.getReader();
			const dec    = new TextDecoder();
			let   ndBuf  = '';
			let   runId  = '';

			outer: for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				ndBuf += dec.decode(value, { stream: true });
				const lines = ndBuf.split('\n');
				ndBuf = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let ev: Record<string, unknown>;
					try { ev = JSON.parse(trimmed); } catch { continue; }
					if (ev.type === 'started' && ev.runId) {
						runId = String(ev.runId);
						// Cancel the rest of the stream — the worker runs in the background.
						await reader.cancel();
						break outer;
					}
					if (ev.type === 'error') {
						throw new Error(String(ev.message ?? 'Agent error'));
					}
				}
			}

			if (!runId) throw new Error('Agent did not return a runId');

			// Transition to running and start the status poller.
			messages = messages.map(m =>
				m.id === cardId
					? { ...m, dispatch: { ...d, status: 'running' as const, runId } }
					: m,
			);
			startRunPoller(cardId, d.agentId, runId);

		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : 'Dispatch failed';
			messages = messages.map(m =>
				m.id === cardId
					? { ...m, dispatch: { ...d, status: 'error' as const, errorMsg } }
					: m,
			);
		}
	}

	/**
	 * Poll `GET /api/agents/<agentId>/runs` every 5 s, looking for the row with
	 * `runId`.  When a terminal status is found, update the card and clear the
	 * interval.  Terminal = `finishedAt` present OR status in success/error set.
	 */
	function startRunPoller(cardId: string, agentId: string, runId: string): void {
		const POLL_MS = 5_000;

		interface RunRow {
			runId:      string;
			status:     string;
			costUsd?:   number;
			numTurns?:  number;
			finishedAt: string | null;
		}

		const TERMINAL_STATUSES = new Set([
			'success', 'goal_achieved', 'completed-no-artifact',
			'interrupted', 'error', 'cancelled',
		]);

		const handle = setInterval(async () => {
			try {
				const res = await fetch(
					`/api/agents/${encodeURIComponent(agentId)}/runs?limit=20`,
				);
				if (!res.ok) return;
				const data = await res.json() as { runs?: RunRow[] };
				const row  = (data.runs ?? []).find((r) => r.runId === runId);
				if (!row) return;

				const isTerminal = row.finishedAt !== null || TERMINAL_STATUSES.has(row.status);

				// Always update the card with the latest known status.
				messages = messages.map(m => {
					if (m.id !== cardId || !m.dispatch) return m;
					const next: WorkbenchDispatch = {
						...m.dispatch,
						runStatus: row.status,
						runCost:   row.costUsd,
						runTurns:  row.numTurns,
					};
					if (isTerminal) {
						const succeeded = ['success', 'goal_achieved'].includes(row.status);
						next.status = succeeded ? 'done' : 'error';
					}
					return { ...m, dispatch: next };
				});

				if (isTerminal) {
					clearInterval(handle);
					pollTimers.delete(cardId);
				}
			} catch {
				// Network hiccup — keep polling.
			}
		}, POLL_MS);

		pollTimers.set(cardId, handle);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}

	// ── Resize drag ──────────────────────────────────────────────────────────────
	function startResize(e: PointerEvent) {
		anchorY = e.clientY;
		anchorH = height;
		resizing = true;

		const onMove = (ev: PointerEvent) => {
			// Dragging the handle UP increases height (distance from bottom).
			const delta = anchorY - ev.clientY;
			height = Math.min(MAX_H, Math.max(MIN_H, anchorH + delta));
		};

		const onEnd = () => {
			resizing = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup',   onEnd);
			window.removeEventListener('pointercancel', onEnd);
		};

		window.addEventListener('pointermove',   onMove);
		window.addEventListener('pointerup',     onEnd);
		window.addEventListener('pointercancel', onEnd);
		e.preventDefault();
	}
</script>

<!--
  Structural role: a `flex-shrink-0` block at the BOTTOM of the root flex
  column in `+layout.svelte`. Height transitions between the collapsed header
  bar and the full open height; `overflow-hidden` clips the body when closed.
-->
<div
	class="flex-shrink-0 border-t border-hub-border bg-hub-bg flex flex-col select-none"
	style:height={`${open ? height + HEADER_PX : HEADER_PX}px`}
	aria-label="Chat drawer"
>
	<!--
	  Resize handle — only visible when open. Drag UP to grow, DOWN to shrink.
	  Full-width strip at the top of the drawer; cursor changes to indicate
	  vertical resize.
	-->
	{#if open}
		<div
			class="flex-shrink-0 h-1.5 w-full cursor-ns-resize hover:bg-hub-cta/20 transition-colors group"
			role="separator"
			aria-label="Resize chat drawer"
			onpointerdown={startResize}
		>
			<!-- Visual grab indicator -->
			<div class="mx-auto w-8 h-0.5 rounded-full bg-hub-border group-hover:bg-hub-cta/60 mt-0.5 transition-colors"></div>
		</div>
	{/if}

	<!-- ── Header row ─────────────────────────────────────────────────────── -->
	<header
		class="flex-shrink-0 flex items-center gap-2 px-3 h-[36px] border-b border-hub-border/50 bg-hub-bg"
	>
		<!-- Collapse / expand toggle -->
		<button
			class="p-1 rounded hover:bg-hub-card text-hub-dim hover:text-hub-text transition-colors cursor-pointer flex-shrink-0"
			onclick={() => { open = !open; }}
			aria-expanded={open}
			aria-label={open ? 'Collapse chat' : 'Expand chat'}
			title={open ? 'Collapse' : 'Expand chat'}
		>
			<!-- Chevron up when open, down when closed -->
			<svg
				class="w-3.5 h-3.5 transition-transform duration-150"
				class:-rotate-180={open}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<polyline points="18 15 12 9 6 15"/>
			</svg>
		</button>

		<!-- Scope chip — reflects the current area (ADR-002 / ADR-006) -->
		<div
			class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-hub-card border border-hub-border/60 text-[11px] text-hub-muted flex-shrink-0"
			title={`Chat scope: ${chipLabel}`}
		>
			{#if scopeKind === 'project'}
				<!-- Folder icon -->
				<svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
			{:else if scopeKind === 'vault-note'}
				<!-- File-text icon (ADR-006) -->
				<svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
					<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
					<polyline points="10 9 9 9 8 9"/>
				</svg>
			{:else if scopeKind === 'inbox-thread'}
				<!-- Mail icon (ADR-006) -->
				<svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
					<polyline points="22,6 12,13 2,6"/>
				</svg>
			{:else if scopeKind === 'crm-contact'}
				<!-- User icon (ADR-006) -->
				<svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
					<circle cx="12" cy="7" r="4"/>
				</svg>
			{:else}
				<!-- CPU icon (global fallback) -->
				<svg class="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="4" y="4" width="16" height="16" rx="2"/>
					<rect x="9" y="9" width="6" height="6"/>
					<line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
					<line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
					<line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
					<line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
				</svg>
			{/if}
			<span class="truncate max-w-[140px]">{chipLabel}</span>
		</div>

		<!-- Engine toggle — ADR-005: both engines are now active -->
		<div class="flex items-center rounded border border-hub-border/60 overflow-hidden text-[10px] flex-shrink-0">
			<button
				class={engine === 'orchestrator'
					? 'px-2 py-0.5 transition-colors cursor-pointer bg-hub-cta text-hub-bg'
					: 'px-2 py-0.5 transition-colors cursor-pointer text-hub-dim hover:text-hub-text'}
				onclick={() => setEngine('orchestrator')}
				aria-pressed={engine === 'orchestrator'}
				title="Orchestrator web engine (ADR-003)"
			>
				Orchestrator
			</button>
			<!-- ADR-005: PTY engine — now active, not P2-disabled -->
			<button
				class={[
					'px-2 py-0.5 transition-colors cursor-pointer flex items-center gap-1 border-l border-hub-border/60',
					engine === 'pty'
						? 'bg-hub-cta text-hub-bg'
						: 'text-hub-dim hover:text-hub-text',
				].join(' ')}
				onclick={() => setEngine('pty')}
				aria-pressed={engine === 'pty'}
				title="Claude PTY engine — interactive claude in scope.cwd (ADR-005)"
			>
				Claude PTY
				{#if ptySessionId && engine !== 'pty'}
					<!-- Session alive in background — small green dot -->
					<span class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" title="PTY session alive"></span>
				{/if}
			</button>
		</div>

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Engine label + status indicator -->
		<div class="flex items-center gap-1.5 text-[11px] text-hub-dim flex-shrink-0">
			{#if engine === 'pty'}
				{#if ptyLoading}
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning animate-pulse"></span>
					<span class="text-hub-warning">loading scope</span>
				{:else if ptySessionId}
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
					<span class="text-green-400">PTY</span>
				{:else}
					<span>PTY</span>
				{/if}
			{:else if sending}
				<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-cta animate-pulse"></span>
				<span class="text-hub-cta">working</span>
			{:else}
				<span>Chat</span>
			{/if}
		</div>
	</header>

	<!-- ── Body (only rendered when open) ───────────────────────────────────── -->
	{#if open}
		<div
			class="flex-1 min-h-0 flex flex-col overflow-hidden"
			style:height={`${height}px`}
		>
			{#if engine === 'orchestrator'}
				<!-- ── Orchestrator transcript view ─────────────────────────────── -->
				<div
					class="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2 scroll-smooth"
					bind:this={scrollEl}
				>
					{#if messages.length === 0}
						<p class="text-[11px] text-hub-dim italic py-4 text-center">
							Ask anything about {chipLabel}…
						</p>
					{/if}

					{#each messages as msg (msg.id)}
						{#if msg.role === 'user'}
							<!-- User turn: right-aligned -->
							<div class="flex justify-end">
								<div class="max-w-[75%] rounded-lg px-3 py-1.5 bg-hub-cta/15 border border-hub-cta/30 text-[12px] text-hub-text leading-relaxed text-right">
									{msg.text}
								</div>
							</div>
						{:else if msg.role === 'assistant'}
							<!-- Assistant turn: left-aligned, streaming morph -->
							<div class="flex justify-start">
								<div
									class={msg.streaming
										? 'max-w-[85%] rounded-lg px-3 py-1.5 border text-[12px] leading-relaxed whitespace-pre-wrap bg-hub-card/60 border-hub-cta/30 text-hub-muted'
										: 'max-w-[85%] rounded-lg px-3 py-1.5 border text-[12px] leading-relaxed whitespace-pre-wrap bg-hub-card border-hub-border text-hub-text'}
								>
									{msg.text}{#if msg.streaming}<span class="inline-block w-1.5 h-3 bg-hub-cta/70 ml-0.5 animate-pulse align-middle rounded-sm"></span>{/if}
								</div>
							</div>
						{:else if msg.role === 'tool'}
							<!-- Tool activity row -->
							<div class="flex items-center gap-1.5 pl-2">
								{#if msg.streaming}
									<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning animate-pulse flex-shrink-0"></span>
								{:else if msg.toolOk !== false}
									<span class="text-hub-cta text-[11px] flex-shrink-0">✓</span>
								{:else}
									<span class="text-hub-danger text-[11px] flex-shrink-0">✗</span>
								{/if}
								<span class="text-[11px] font-mono text-hub-dim truncate">{msg.text}</span>
							</div>
						{:else if msg.role === 'workbench' && msg.dispatch}
							<!--
							  ADR-007 — Workbench dispatch card.
							  Lifecycle badge: offered → dispatching → running → done | error.
							  "Dispatch" button fires dispatchToWorkbench; disabled after click.
							  When done, links to the /agents/<id>/runs page for the review card.
							-->
							{@const d = msg.dispatch}
							<div class="rounded-lg border px-3 py-2 bg-hub-card border-hub-border/80 text-[11px] space-y-1.5">
								<!-- Header row: rocket + label + status badge -->
								<div class="flex items-center gap-2">
									<span class="text-base leading-none flex-shrink-0" aria-hidden="true">🚀</span>
									<span class="font-medium text-hub-text flex-1 truncate">Workbench dispatch</span>
									<!-- Status badge -->
									{#if d.status === 'offered'}
										<span class="px-1.5 py-0.5 rounded-full bg-hub-border/60 text-hub-dim font-mono">ready</span>
									{:else if d.status === 'dispatching'}
										<span class="px-1.5 py-0.5 rounded-full bg-hub-warning/20 text-hub-warning font-mono animate-pulse">dispatching…</span>
									{:else if d.status === 'running'}
										<span class="px-1.5 py-0.5 rounded-full bg-hub-cta/15 text-hub-cta font-mono animate-pulse">running</span>
									{:else if d.status === 'done'}
										<span class="px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-mono">done ✓</span>
									{:else if d.status === 'error'}
										<span class="px-1.5 py-0.5 rounded-full bg-hub-danger/15 text-hub-danger font-mono">error</span>
									{/if}
								</div>

								<!-- Agent + task summary -->
								<div class="text-hub-dim leading-snug truncate">
									<span class="font-mono text-hub-muted">{d.agentId}</span>
								</div>
								<p class="text-hub-text/80 leading-snug line-clamp-2">{d.task}</p>

								{#if d.subject}
									<p class="text-hub-dim truncate font-mono text-[10px]">{d.subject}</p>
								{/if}

								<!-- Run stats once terminal -->
								{#if (d.status === 'done' || d.status === 'error') && (d.runCost !== undefined || d.runTurns !== undefined)}
									<div class="flex items-center gap-3 text-hub-dim pt-0.5">
										{#if d.runTurns !== undefined}
											<span>{d.runTurns} turns</span>
										{/if}
										{#if d.runCost !== undefined}
											<span>${d.runCost.toFixed(4)}</span>
										{/if}
										{#if d.runStatus}
											<span class="font-mono">{d.runStatus}</span>
										{/if}
									</div>
								{/if}

								<!-- Error message -->
								{#if d.status === 'error' && d.errorMsg}
									<p class="text-hub-danger leading-snug">{d.errorMsg}</p>
								{/if}

								<!-- Action row -->
								<div class="flex items-center gap-2 pt-0.5">
									{#if d.status === 'offered'}
										<button
											class="px-2.5 py-1 rounded-md bg-hub-cta text-hub-bg font-medium hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
											onclick={() => void dispatchToWorkbench(msg.id)}
										>
											Dispatch →
										</button>
									{:else if d.status === 'dispatching'}
										<button class="px-2.5 py-1 rounded-md bg-hub-cta/50 text-hub-bg font-medium cursor-not-allowed" disabled>
											Dispatching…
										</button>
									{:else if d.status === 'running' && d.runId}
										<a
											href="/agents/{d.agentId}/runs"
											class="px-2.5 py-1 rounded-md bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta/50 transition-colors"
											target="_blank"
											rel="noopener noreferrer"
										>
											View run →
										</a>
									{:else if d.status === 'done' && d.runId}
										<a
											href="/agents/{d.agentId}/runs"
											class="px-2.5 py-1 rounded-md bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 transition-colors"
											target="_blank"
											rel="noopener noreferrer"
										>
											Review &amp; ship →
										</a>
									{:else if d.status === 'error'}
										<button
											class="px-2.5 py-1 rounded-md bg-hub-card border border-hub-danger/40 text-hub-danger hover:bg-hub-danger/10 transition-colors cursor-pointer"
											onclick={() => {
												messages = messages.map(m =>
													m.id === msg.id && m.dispatch
														? { ...m, dispatch: { ...m.dispatch, status: 'offered', errorMsg: undefined } }
														: m,
												);
											}}
										>
											Retry
										</button>
									{/if}
								</div>
							</div>
						{/if}
					{/each}

					<!-- Error banner -->
					{#if streamError}
						<div class="rounded-lg px-3 py-1.5 bg-hub-danger/10 border border-hub-danger/30 text-[11px] text-hub-danger">
							{streamError}
						</div>
					{/if}
				</div>

				<!-- Input row (Orchestrator only) -->
				<div class="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-t border-hub-border/50">
					<textarea
						class="flex-1 min-h-[32px] max-h-[80px] resize-none rounded-md bg-hub-card border border-hub-border px-2.5 py-1.5 text-[12px] text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors leading-snug"
						placeholder="Message…"
						rows="1"
						bind:value={input}
						onkeydown={handleKeydown}
						disabled={sending}
						aria-label="Chat message input"
					></textarea>
					<button
						class="flex-shrink-0 px-3 py-1.5 rounded-md bg-hub-cta text-hub-bg text-[12px] font-medium hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={() => void send()}
						disabled={sending || !input.trim()}
						aria-label="Send message"
					>
						{sending ? '…' : '↑'}
					</button>
				</div>

			{:else if engine === 'pty'}
				<!-- ── Claude PTY engine view (ADR-005) ─────────────────────────── -->
				{#if ptyLoading}
					<!-- Scope fetch in progress -->
					<div class="flex-1 flex items-center justify-center gap-2 text-[11px] text-hub-dim">
						<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning animate-pulse"></span>
						<span>Resolving scope…</span>
					</div>

				{:else if ptyError}
					<!-- Scope fetch failed -->
					<div class="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
						<div class="text-[11px] text-hub-danger max-w-xs">
							{ptyError}
						</div>
						<button
							class="px-3 py-1 rounded-md bg-hub-card border border-hub-border text-[11px] text-hub-muted hover:text-hub-text hover:border-hub-cta/50 transition-colors cursor-pointer"
							onclick={() => { ptyError = ''; void activatePty(); }}
						>
							Retry
						</button>
					</div>

				{:else if ptyReady}
					<!--
					  AgentTerminal fills the full body height.
					  keepAlive=true: session survives drawer collapse (onDestroy won't kill it).
					  reconnectSessionId: non-empty when a prior session exists — reconnects
					    rather than spawning fresh.
					  autoSpawn={!ptySessionId}: first open auto-spawns; re-opens use reconnect.
					  onSessionStart: stores the session ID so re-opens reconnect correctly.
					  The terminal's own header bar (status dot + Kill/Clear controls) renders
					  inside AgentTerminal; no additional input row is needed.
					-->
					<div class="flex-1 min-h-0 overflow-hidden">
						<AgentTerminal
							bind:this={ptyTerminal}
							cwd={ptyCwd}
							prompt={ptyPrimer}
							autoSpawn={!ptySessionId}
							reconnectSessionId={ptySessionId}
							keepAlive={true}
							onSessionStart={(id) => { ptySessionId = id; }}
						/>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>
