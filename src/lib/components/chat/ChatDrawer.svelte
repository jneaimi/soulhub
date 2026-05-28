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
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import AgentTerminal from '$lib/components/AgentTerminal.svelte';

	// ── Session-persistence keys ────────────────────────────────────────────────
	const OPEN_KEY       = 'chat-drawer-open';
	const HEIGHT_KEY     = 'chat-drawer-height';
	const FULLSCREEN_KEY = 'chat-drawer-fullscreen';
	const ENGINE_KEY     = 'chat-drawer-engine';
	/** localStorage prefix, keyed per scope — lets a refresh reconnect to the
	 *  still-running server-side session instead of spawning a fresh one. */
	const SESSION_KEY_PREFIX = 'chat-pty-session:';

	// ── Height constraints ──────────────────────────────────────────────────────
	// Sized for the Claude PTY engine: AgentTerminal's own header (~33px) eats into
	// the body, and Claude Code's full-screen TUI (input box + status line + bordered
	// panels) is unreadable when short. MIN_H 240 ⇒ ~13 rows; DEFAULT_H 520 ⇒ ~30
	// rows. The max adapts to the viewport (see maxH) so the drawer can be dragged
	// tall on a big screen without overflowing a small laptop.
	const HEADER_PX  = 36;   // px height of the collapsed header bar
	const DEFAULT_H  = 520;  // default body height when first opened
	const MIN_H      = 240;
	const MAX_CAP    = 900;  // absolute ceiling regardless of viewport
	/** Resizable upper bound — recomputed from viewport height on mount + resize. */
	let maxH = $state(640);

	function computeMaxH() {
		if (typeof window === 'undefined') return;
		maxH = Math.max(MIN_H, Math.min(MAX_CAP, window.innerHeight - 140));
		if (height > maxH) height = maxH;
	}

	// ── State ───────────────────────────────────────────────────────────────────
	let open       = $state(false);
	/** Immersive full-page mode — the drawer fills the viewport (fixed inset-0).
	 *  Toggled in place so the live terminal instance keeps running (no remount). */
	let fullscreen = $state(false);
	let height  = $state(DEFAULT_H);
	/** Engine choice — ADR-005: orchestrator + Claude PTY; + a plain server-side
	 *  shell ('terminal') that survives refresh / browser switch / disconnect so a
	 *  long-running command (e.g. a dev server) keeps running while detached. */
	let engine  = $state<'orchestrator' | 'pty' | 'terminal'>('orchestrator');

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
	/** Claude session UUID to resume (claude --resume) — set when the picker selects a dead session. */
	let ptyResumeId   = $state('');
	/** Bumped to force AgentTerminal to remount when switching / resuming / starting new. */
	let ptyMountToken = $state(0);

	// ── Terminal engine state (plain server-side shell) ─────────────────────────
	// A bash shell in scope.cwd, origin='chat-terminal'. Singleton per cwd (the
	// manager kills other live chat-terminal sessions for the same cwd on spawn),
	// keepAlive + 24h orphan window ⇒ survives refresh / browser switch / detach.
	// No primer, no Claude --resume (a dead shell is gone; only live shells re-attach).
	let termCwd       = $state('');
	let termReady     = $state(false);
	let termLoading   = $state(false);
	let termError     = $state('');
	let termSessionId = $state('');
	let termTerminal: AgentTerminal | undefined = $state();
	/** Bumped to force AgentTerminal remount (new shell / reconnect). */
	let termMountToken = $state(0);

	/** The session id of whichever PTY-style engine is active (for picker highlight). */
	const currentSessionId = $derived(engine === 'terminal' ? termSessionId : ptySessionId);

	// ── Session picker (ADR-005 continuity) ─────────────────────────────────────
	interface DrawerSession {
		id: string;
		claudeSessionId?: string;
		prompt: string;
		startedAt: string;
		status: string;
		alive: boolean;
	}
	let showSessions    = $state(false);
	let sessionsLoading = $state(false);
	let sessionList     = $state<DrawerSession[]>([]);
	/** Count of still-running sessions in this scope (from the loaded list). */
	const activeCount = $derived(sessionList.filter((s) => s.alive).length);
	let sessionsBtnEl: HTMLButtonElement | undefined = $state();
	let ddLeft   = $state(0);
	let ddTop    = $state(0);
	let ddBottom = $state(0);
	/** Open downward when the button is in the upper half of the viewport
	 *  (full-page puts it near the top); upward for the bottom-docked drawer. */
	let ddDown   = $state(false);

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

	/** Stable per-scope key for session persistence + restore. */
	const scopeKey = $derived(`${scopeKind}:${JSON.stringify(scopeParams)}`);

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
		computeMaxH();
		window.addEventListener('resize', computeMaxH);
		try {
			const sv = sessionStorage.getItem(OPEN_KEY);
			if (sv !== null) open = sv === 'true';
			const hv = sessionStorage.getItem(HEIGHT_KEY);
			if (hv) {
				const n = parseInt(hv, 10);
				if (!Number.isNaN(n) && n >= MIN_H && n <= maxH) height = n;
			}
			if (sessionStorage.getItem(FULLSCREEN_KEY) === 'true') { fullscreen = true; open = true; }
			const ev = sessionStorage.getItem(ENGINE_KEY);
			if (ev === 'pty' || ev === 'orchestrator' || ev === 'terminal') engine = ev;
		} catch { /* sessionStorage unavailable (private mode etc.) */ }
		return () => window.removeEventListener('resize', computeMaxH);
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
	$effect(() => {
		try { sessionStorage.setItem(FULLSCREEN_KEY, String(fullscreen)); } catch { /**/ }
	});
	$effect(() => {
		try { sessionStorage.setItem(ENGINE_KEY, engine); } catch { /**/ }
	});

	function toggleFullscreen() {
		fullscreen = !fullscreen;
		if (fullscreen) open = true;  // can't be immersive while collapsed
	}

	// ── Session persistence (survive refresh) ───────────────────────────────────
	function persistSession(id: string) {
		try { if (id) localStorage.setItem(SESSION_KEY_PREFIX + scopeKey, id); } catch { /**/ }
	}
	function clearPersistedSession() {
		try { localStorage.removeItem(SESSION_KEY_PREFIX + scopeKey); } catch { /**/ }
	}
	function readPersistedSession(): string {
		try { return localStorage.getItem(SESSION_KEY_PREFIX + scopeKey) ?? ''; } catch { return ''; }
	}

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
			// Restore a still-running session for this scope (survives a refresh /
			// reconnect): load the scope's sessions, and if the persisted id is
			// still alive, reconnect to it instead of spawning fresh.
			await loadDrawerSessions();
			if (!ptySessionId) {
				// tmux-like re-attach: snap back to the newest still-running session
				// for this scope (sessionList is newest-first). The PTY lives
				// server-side, so a refresh / engine-toggle / re-login re-attaches to
				// the live session and any in-progress work continues uninterrupted.
				// Prefer the persisted id if it's still alive, else the newest alive.
				const persisted = readPersistedSession();
				const live = sessionList.find((s) => s.id === persisted && s.alive)
					?? sessionList.find((s) => s.alive);
				if (live) ptySessionId = live.id;
				else clearPersistedSession();
			}
			ptyReady  = true;
		} catch (err) {
			ptyError = err instanceof Error ? err.message : 'Failed to load scope';
		} finally {
			ptyLoading = false;
		}
	}

	/**
	 * Detach the PTY view WITHOUT killing the server-side session. The session
	 * stays alive (keepAlive + 6h orphan window), so toggling the engine, changing
	 * scope, or refreshing re-attaches to the still-running session and any
	 * in-progress work continues uninterrupted (tmux-like). Clearing ptyReady
	 * unmounts AgentTerminal (keepAlive ⇒ onDestroy does NOT kill); the activation
	 * effect then re-attaches for the current scope. Explicit kill lives in the
	 * picker (killSessionById) + AgentTerminal's own Kill button.
	 */
	function detachPty() {
		ptySessionId = '';
		ptyResumeId  = '';
		ptyReady     = false;
		ptyCwd       = '';
		ptyPrimer    = '';
		ptyError     = '';
		showSessions = false;
	}

	/**
	 * Activate the plain shell engine: resolve scope cwd (same /api/chat/scope as
	 * PTY, primer ignored) then re-attach to the newest still-running chat-terminal
	 * session for this cwd. Singleton-per-cwd ⇒ there's at most one live shell, so
	 * a refresh / browser switch / reconnect snaps back to the running shell and
	 * any command it's running (a dev server, a build) keeps going uninterrupted.
	 */
	async function activateTerminal() {
		if (termReady || termLoading) return;
		termLoading = true;
		termError   = '';
		try {
			const params = new URLSearchParams({ scopeKind });
			if (scopeKind === 'project'     && scopeSlug)      params.set('slug',      scopeSlug);
			if (scopeKind === 'vault-note'  && scopeNotePath)  params.set('notePath',  scopeNotePath);
			if (scopeKind === 'crm-contact' && scopeContactId) params.set('contactId', scopeContactId);
			const res = await fetch(`/api/chat/scope?${params.toString()}`);
			if (!res.ok) {
				const d = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(d.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json() as { cwd: string };
			termCwd = data.cwd;
			await loadDrawerSessions();
			if (!termSessionId) {
				const live = sessionList.find((s) => s.alive);
				if (live) termSessionId = live.id;
			}
			termReady = true;
		} catch (err) {
			termError = err instanceof Error ? err.message : 'Failed to load scope';
		} finally {
			termLoading = false;
		}
	}

	/** Detach the shell view WITHOUT killing it — the server-side shell stays alive
	 *  (keepAlive + 24h orphan) so toggling engine / scope / refresh re-attaches. */
	function detachTerminal() {
		termSessionId = '';
		termReady     = false;
		termCwd       = '';
		termError     = '';
		showSessions  = false;
	}

	// ── Session picker actions ──────────────────────────────────────────────────

	/** Fetch the active engine's sessions for its cwd (newest first, deduped). The
	 *  Claude PTY uses origin='chat-drawer'; the shell uses origin='chat-terminal'. */
	async function loadDrawerSessions() {
		const origin = engine === 'terminal' ? 'chat-terminal' : 'chat-drawer';
		const cwd    = engine === 'terminal' ? termCwd : ptyCwd;
		sessionsLoading = true;
		try {
			const res = await fetch(`/api/sessions?origin=${origin}&cwd=${encodeURIComponent(cwd)}&limit=20`);
			sessionList = res.ok ? (((await res.json()).sessions ?? []) as DrawerSession[]) : [];
		} catch {
			sessionList = [];
		} finally {
			sessionsLoading = false;
		}
	}

	function toggleSessions() {
		if (showSessions) { showSessions = false; return; }
		if (sessionsBtnEl) {
			const r = sessionsBtnEl.getBoundingClientRect();
			ddLeft   = r.left;
			ddDown   = r.top < window.innerHeight / 2;
			ddTop    = r.bottom + 4;
			ddBottom = window.innerHeight - r.top + 4;
		}
		void loadDrawerSessions();
		showSessions = true;
	}

	/**
	 * Continue a chosen past session: reconnect if its PTY is still alive, else
	 * resume the Claude conversation via --resume. Remounting AgentTerminal (via
	 * ptyMountToken) is what makes the new reconnect/resume props take effect —
	 * the component reads them at mount.
	 */
	function pickSession(s: DrawerSession) {
		if (engine === 'terminal') {
			// A shell can only be re-attached while alive; a dead shell is gone, so
			// picking one just opens a fresh shell.
			termSessionId = s.alive ? s.id : '';
			showSessions  = false;
			termMountToken++;
			return;
		}
		if (s.alive) {
			ptySessionId = s.id;     // live PTY → reconnect (snapshot path)
			ptyResumeId  = '';
		} else {
			ptySessionId = '';
			ptyResumeId  = s.claudeSessionId ?? '';  // dead → resume the conversation
		}
		showSessions = false;
		ptyMountToken++;
	}

	/** Start a fresh session in the active engine. */
	function newSession() {
		if (engine === 'terminal') {
			termSessionId = '';
			showSessions  = false;
			termMountToken++;
			return;
		}
		ptySessionId = '';
		ptyResumeId  = '';
		clearPersistedSession();
		showSessions = false;
		ptyMountToken++;
	}

	/** Kill a running session. If it's the active one, drop to a fresh terminal. */
	async function killSessionById(id: string, ev?: MouseEvent) {
		ev?.stopPropagation();
		try {
			await fetch('/api/pty', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ action: 'kill', sessionId: id }),
			});
		} catch { /* best effort */ }
		if (engine === 'terminal') {
			if (id === termSessionId) {
				termSessionId = '';
				termMountToken++;   // remount → fresh shell
			}
		} else if (id === ptySessionId) {
			ptySessionId = '';
			ptyResumeId  = '';
			clearPersistedSession();
			ptyMountToken++;   // remount → fresh session
		}
		await loadDrawerSessions();
	}

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const m = Math.floor(diff / 60_000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	/**
	 * Switch the engine. Does NOT kill the PTY session — it stays alive
	 * server-side and re-attaches when you switch back (tmux-like). The view
	 * unmounts via the render (engine!=='pty') with keepAlive, so no orphan kill.
	 */
	function setEngine(e: 'orchestrator' | 'pty' | 'terminal') {
		engine = e;
	}

	/**
	 * Activate PTY scope whenever the engine is 'pty' AND the drawer is open AND
	 * scope is not yet loaded.  Reading `ptyReady` / `ptyLoading` inside the
	 * effect means Svelte re-evaluates after detachPty() clears them, which
	 * re-fetches scope + re-attaches if the scope changed while PTY was active.
	 */
	$effect(() => {
		if (engine === 'pty' && open && !ptyReady && !ptyLoading) {
			void activatePty();
		}
		if (engine === 'terminal' && open && !termReady && !termLoading) {
			void activateTerminal();
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
			// PTY: detach (don't kill) — the old scope's session stays alive so
			// returning to that workspace re-attaches; activation re-runs for the
			// new scope and re-attaches to ITS live session (if any).
			if (engine === 'pty') detachPty();
			if (engine === 'terminal') detachTerminal();
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
								// ADR-015 S1 (defence-in-depth): if the reported messageId
								// matches no existing message (e.g. a stale/legacy fallback
								// id), use the locally-tracked bubbleId so the answer never
								// silently vanishes due to an id mismatch.
								const targetId = messages.some(m => m.id === mid)
									? mid
									: (bubbleId ?? mid);
								messages = messages.map(m =>
									m.id === targetId
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
						case 'navigate': {
							// ADR-011 — navigate directive from the orchestrator.
							// The server already emitted the confirmation text via
							// bubble-update; here we call SvelteKit's goto() to
							// perform client-side navigation without a full page reload.
							const url = String(ev.url ?? '');
							if (url && url.startsWith('/')) {
								// Fire and forget — the route change may cancel the
								// stream (the browser navigates away), which is expected.
								void goto(url);
							}
							break;
						}
						case 'complete': {
							// Terminal: finalize the current bubble's streaming state.
							if (bubbleId) {
								// ADR-015 S2 — reposition the answer bubble AFTER all tool
								// rows so the transcript reads in chronological order:
								//   user → tool activity (⚙/✓) → answer
								// The bubble was opened first for fast "🟡 Thinking…"
								// feedback; tool rows were appended during streaming; on
								// completion we move the answer to its correct position
								// at the end rather than leaving it above the tools.
								const bubbleMsg = messages.find(m => m.id === bubbleId);
								if (bubbleMsg) {
									messages = [
										...messages.filter(m => m.id !== bubbleId),
										{ ...bubbleMsg, streaming: false },
									];
								} else {
									messages = messages.map(m =>
										m.id === bubbleId ? { ...m, streaming: false } : m,
									);
								}
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
			height = Math.min(maxH, Math.max(MIN_H, anchorH + delta));
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
	class="bg-hub-bg flex flex-col {fullscreen ? 'fixed inset-0 z-[60]' : 'flex-shrink-0 border-t border-hub-border'}"
	class:select-none={resizing}
	style:height={fullscreen ? undefined : `${open ? height + HEADER_PX : HEADER_PX}px`}
	aria-label="Chat drawer"
>
	<!--
	  Resize handle — only visible when open. Drag UP to grow, DOWN to shrink.
	  Full-width strip at the top of the drawer; cursor changes to indicate
	  vertical resize.
	-->
	{#if open && !fullscreen}
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
		<!-- Collapse / expand toggle (hidden in full-page mode) -->
		{#if !fullscreen}
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
		{/if}

		<!-- Maximize / restore — immersive full-page mode -->
		<button
			class="p-1 rounded hover:bg-hub-card text-hub-dim hover:text-hub-text transition-colors cursor-pointer flex-shrink-0"
			onclick={toggleFullscreen}
			aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
			title={fullscreen ? 'Exit full screen' : 'Immersive full page'}
		>
			{#if fullscreen}
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
			{:else}
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
			{/if}
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
			<!-- Plain server-side shell — survives refresh / browser switch / detach -->
			<button
				class={[
					'px-2 py-0.5 transition-colors cursor-pointer flex items-center gap-1 border-l border-hub-border/60',
					engine === 'terminal'
						? 'bg-hub-cta text-hub-bg'
						: 'text-hub-dim hover:text-hub-text',
				].join(' ')}
				onclick={() => setEngine('terminal')}
				aria-pressed={engine === 'terminal'}
				title="Server-side shell — a bash terminal in scope.cwd that keeps running while detached"
			>
				Terminal
				{#if termSessionId && engine !== 'terminal'}
					<span class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" title="Shell session alive"></span>
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
			{:else if engine === 'terminal'}
				{#if termLoading}
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning animate-pulse"></span>
					<span class="text-hub-warning">loading scope</span>
				{:else if termSessionId}
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
					<span class="text-green-400">shell</span>
				{:else}
					<span>shell</span>
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
		<!--
		  Body height comes from flex-1 filling the outer drawer (whose height is the
		  single source of truth). No inline height here — a second height declaration
		  on a flex-1 child disagrees with flex-grow by the resize-handle's px and
		  feeds fitAddon a transient measurement on mount.
		-->
		<div
			class="flex-1 min-h-0 flex flex-col overflow-hidden"
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
					  Session toolbar (ADR-005 continuity): continue a previous drawer
					  conversation or start a new one. The picker lists only chat-drawer
					  sessions for this scope's cwd (see /api/sessions?origin=chat-drawer);
					  selecting one reconnects to its live PTY or resumes the Claude
					  conversation via --resume.
					-->
					<div class="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-hub-border/40 bg-hub-bg/70 text-[11px]">
						<button
							bind:this={sessionsBtnEl}
							onclick={toggleSessions}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Continue a previous chat session in this scope"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
							Sessions
							{#if activeCount > 0}
								<span class="inline-flex items-center gap-0.5 px-1 rounded-full bg-green-500/15 text-green-400 text-[9px] font-mono" title="{activeCount} running">
									<span class="w-1 h-1 rounded-full bg-green-400 animate-pulse"></span>{activeCount}
								</span>
							{/if}
							<svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
						</button>
						<button
							onclick={newSession}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Start a new session"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							New
						</button>
						<button
							onclick={() => ptyTerminal?.triggerUpload()}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Upload files into this session (also: drag & drop onto the terminal)"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
							Upload
						</button>
						{#if ptyResumeId}
							<span class="text-hub-dim">· resuming conversation</span>
						{/if}
					</div>

					{#if showSessions}
						<!-- click-away backdrop -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="fixed inset-0 z-40" onclick={() => (showSessions = false)}></div>
						<!-- Fixed + bottom-anchored: opens UPWARD so it isn't clipped by the bottom-docked drawer. -->
						<div
							class="fixed w-72 max-h-64 overflow-y-auto bg-hub-card border border-hub-border rounded-lg shadow-2xl z-50"
							style={ddDown ? `left: ${ddLeft}px; top: ${ddTop}px;` : `left: ${ddLeft}px; bottom: ${ddBottom}px;`}
						>
							<div class="px-3 py-1.5 border-b border-hub-border/50 text-[10px] text-hub-dim uppercase tracking-wider">Your sessions here{#if activeCount > 0}<span class="text-green-400 normal-case"> · {activeCount} running</span>{/if}</div>
							{#if sessionsLoading}
								<div class="px-3 py-4 text-center text-[11px] text-hub-dim">Loading…</div>
							{:else if sessionList.length === 0}
								<div class="px-3 py-4 text-center text-[11px] text-hub-dim">No past sessions in this scope yet</div>
							{:else}
								{#each sessionList as s (s.id)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										onclick={() => pickSession(s)}
										class="group flex items-center gap-2 px-3 py-2 hover:bg-hub-surface/60 cursor-pointer border-b border-hub-border/20 last:border-0 transition-colors"
									>
										<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {s.alive ? 'bg-green-400 animate-pulse' : 'bg-hub-dim'}"></span>
										<div class="flex-1 min-w-0">
											<div class="text-[11px] text-hub-text truncate leading-tight">{relativeTime(s.startedAt)}{#if s.id === currentSessionId}<span class="text-hub-cta"> · current</span>{/if}</div>
											<div class="text-[10px] text-hub-dim leading-tight">{s.alive ? 'live — reconnect' : 'resume conversation'}</div>
										</div>
										{#if s.alive}
											<button
												onclick={(e) => killSessionById(s.id, e)}
												class="flex-shrink-0 p-1 rounded text-hub-dim hover:bg-hub-danger/15 hover:text-hub-danger transition-colors cursor-pointer"
												title="Kill this running session"
												aria-label="Kill session"
											>
												<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
											</button>
										{/if}
									</div>
								{/each}
							{/if}
						</div>
					{/if}

					<div class="flex-1 min-h-0 overflow-hidden">
						{#key ptyMountToken}
							<AgentTerminal
								bind:this={ptyTerminal}
								cwd={ptyCwd}
								prompt={ptyPrimer}
								origin="chat-drawer"
								autoSpawn={!ptySessionId}
								reconnectSessionId={ptySessionId}
								resumeSessionId={ptyResumeId}
								keepAlive={true}
								onSessionStart={(id) => { ptySessionId = id; ptyResumeId = ''; persistSession(id); }}
							/>
						{/key}
					</div>
				{/if}

			{:else if engine === 'terminal'}
				<!-- ── Server-side shell engine ─────────────────────────────
				     A plain bash terminal in scope.cwd, origin='chat-terminal'.
				     Singleton-per-cwd + keepAlive + 24h orphan ⇒ a command left
				     running (dev server, build, watcher) survives refresh / browser
				     switch / disconnect; re-opening re-attaches to the live shell. -->
				{#if termLoading}
					<div class="flex-1 flex items-center justify-center gap-2 text-[11px] text-hub-dim">
						<span class="inline-block w-1.5 h-1.5 rounded-full bg-hub-warning animate-pulse"></span>
						<span>Resolving scope…</span>
					</div>
				{:else if termError}
					<div class="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
						<div class="text-[11px] text-hub-danger max-w-xs">{termError}</div>
						<button
							class="px-3 py-1 rounded-md bg-hub-card border border-hub-border text-[11px] text-hub-muted hover:text-hub-text hover:border-hub-cta/50 transition-colors cursor-pointer"
							onclick={() => { termError = ''; void activateTerminal(); }}
						>
							Retry
						</button>
					</div>
				{:else if termReady}
					<!-- Session toolbar: re-attach to a live shell, open a new one, or upload. -->
					<div class="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-hub-border/40 bg-hub-bg/70 text-[11px]">
						<button
							bind:this={sessionsBtnEl}
							onclick={toggleSessions}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Re-attach to a running shell in this scope"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
							Shells
							{#if activeCount > 0}
								<span class="inline-flex items-center gap-0.5 px-1 rounded-full bg-green-500/15 text-green-400 text-[9px] font-mono" title="{activeCount} running">
									<span class="w-1 h-1 rounded-full bg-green-400 animate-pulse"></span>{activeCount}
								</span>
							{/if}
							<svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
						</button>
						<button
							onclick={newSession}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Open a new shell"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							New
						</button>
						<button
							onclick={() => termTerminal?.triggerUpload()}
							class="flex items-center gap-1 px-2 py-0.5 rounded text-hub-muted hover:bg-hub-card hover:text-hub-text transition-colors cursor-pointer"
							title="Upload files into this shell (also: drag & drop onto the terminal)"
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
							Upload
						</button>
					</div>

					{#if showSessions}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="fixed inset-0 z-40" onclick={() => (showSessions = false)}></div>
						<div
							class="fixed w-72 max-h-64 overflow-y-auto bg-hub-card border border-hub-border rounded-lg shadow-2xl z-50"
							style={ddDown ? `left: ${ddLeft}px; top: ${ddTop}px;` : `left: ${ddLeft}px; bottom: ${ddBottom}px;`}
						>
							<div class="px-3 py-1.5 border-b border-hub-border/50 text-[10px] text-hub-dim uppercase tracking-wider">Shells here{#if activeCount > 0}<span class="text-green-400 normal-case"> · {activeCount} running</span>{/if}</div>
							{#if sessionsLoading}
								<div class="px-3 py-4 text-center text-[11px] text-hub-dim">Loading…</div>
							{:else if sessionList.length === 0}
								<div class="px-3 py-4 text-center text-[11px] text-hub-dim">No shells in this scope yet</div>
							{:else}
								{#each sessionList as s (s.id)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										onclick={() => pickSession(s)}
										class="group flex items-center gap-2 px-3 py-2 hover:bg-hub-surface/60 cursor-pointer border-b border-hub-border/20 last:border-0 transition-colors"
									>
										<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {s.alive ? 'bg-green-400 animate-pulse' : 'bg-hub-dim'}"></span>
										<div class="flex-1 min-w-0">
											<div class="text-[11px] text-hub-text truncate leading-tight">{relativeTime(s.startedAt)}{#if s.id === currentSessionId}<span class="text-hub-cta"> · current</span>{/if}</div>
											<div class="text-[10px] text-hub-dim leading-tight">{s.alive ? 'live — re-attach' : 'ended'}</div>
										</div>
										{#if s.alive}
											<button
												onclick={(e) => killSessionById(s.id, e)}
												class="flex-shrink-0 p-1 rounded text-hub-dim hover:bg-hub-danger/15 hover:text-hub-danger transition-colors cursor-pointer"
												title="Kill this running shell"
												aria-label="Kill shell"
											>
												<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
											</button>
										{/if}
									</div>
								{/each}
							{/if}
						</div>
					{/if}

					<div class="flex-1 min-h-0 overflow-hidden">
						{#key termMountToken}
							<AgentTerminal
								bind:this={termTerminal}
								cwd={termCwd}
								shell={true}
								origin="chat-terminal"
								autoSpawn={!termSessionId}
								reconnectSessionId={termSessionId}
								keepAlive={true}
								onSessionStart={(id) => { termSessionId = id; }}
							/>
						{/key}
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>
