<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		prompt?: string;
		cwd?: string;
		autoSpawn?: boolean;
		projectName?: string;
		/** Pass --continue to resume the most recent Claude session in this cwd */
		continueSession?: boolean;
		/** Spawn a plain shell instead of Claude Code */
		shell?: boolean;
		/** Resume a specific past Claude conversation (claude --resume <uuid>) */
		resumeSessionId?: string;
		/** UI surface that owns this terminal — sent on spawn so the session is
		 *  tagged (e.g. 'chat-drawer') and resumable from the picker. */
		origin?: string;
		/** Connect to an already-running PTY session instead of spawning a new one */
		reconnectSessionId?: string;
		/** If true, do NOT kill the PTY session when this component unmounts (e.g. when collapsed) */
		keepAlive?: boolean;
		/**
		 * ADR-005 — Called once the server assigns a session ID to this spawn.
		 * Allows a parent (e.g. ChatDrawer) to store the ID for reconnect on
		 * re-mount without accessing the component's internal state.
		 */
		onSessionStart?: (sessionId: string) => void;
	}

	let { prompt = '', cwd = '', autoSpawn = false, projectName = '', continueSession = false, shell = false, resumeSessionId = '', origin = '', reconnectSessionId = '', keepAlive = false, onSessionStart }: Props = $props();

	let fileInput: HTMLInputElement;
	let uploading = $state(false);
	// Upload feedback lives in a toast overlay — never written into the xterm
	// buffer, which would corrupt a running TUI app's (Claude Code) redraw.
	let uploadToast = $state<{ text: string; detail: string; kind: 'ok' | 'err' } | null>(null);
	let uploadToastTimer: ReturnType<typeof setTimeout> | null = null;
	let dragActive = $state(false);
	let touchStartY = 0;
	let touchScrollActive = false;
	let scrolledUp = $state(false);

	// Mobile copy: the canvas/WebGL terminal has no DOM text, so the OS long-press
	// selection can't reach the output. A long-press opens this overlay holding the
	// recent buffer as plain, natively-selectable text — long-press-select + copy
	// with the OS, or "Copy all" in one tap.
	let copyOverlayText = $state<string | null>(null);
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;

	function grabTerminalText(): string {
		if (!terminal) return '';
		const buf = terminal.buffer.active;
		const end = buf.baseY + terminal.rows;
		const start = Math.max(0, end - 500); // last ~500 lines incl. scrollback
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const line = buf.getLine(i);
			lines.push(line ? line.translateToString(true) : '');
		}
		return lines.join('\n').replace(/\s+$/, '');
	}

	function openCopyOverlay() {
		copyOverlayText = grabTerminalText();
	}

	async function copyAllOverlay() {
		if (copyOverlayText) {
			try {
				await navigator.clipboard.writeText(copyOverlayText);
				showToast('Copied', `${copyOverlayText.length} chars`, 'ok');
			} catch { /* clipboard blocked */ }
		}
		copyOverlayText = null;
	}

	// Mobile paste: read the OS clipboard and feed it into the running session as
	// input. The canvas terminal has no native paste affordance on touch, so the
	// PASTE key bridges it. readText() needs a user gesture (the tap supplies it).
	async function pasteFromClipboard() {
		if (!sessionId || !running) return;
		try {
			const text = await navigator.clipboard.readText();
			if (text) {
				sendInput(text);
				showToast('Pasted', `${text.length} chars`, 'ok');
			}
		} catch {
			showToast('Paste blocked', 'Clipboard read denied', 'err');
		}
	}

	let terminalEl: HTMLDivElement | undefined = $state();
	let terminal: any = null;
	let fitAddon: any = null;
	let abortController: AbortController | null = null;
	let sessionId = $state('');
	let running = $state(false);
	let exitCode = $state<number | null>(null);
	let pid = $state<number | null>(null);
	let error = $state('');
	let isTouchDevice = $state(false);
	let ctrlActive = $state(false);
	let altActive = $state(false);

	// Send a key (or modified key) to the terminal
	function sendKey(key: string) {
		if (!sessionId || !running) return;

		let data = key;

		// Apply modifiers
		if (ctrlActive && key.length === 1) {
			// Ctrl+letter = char code 1-26
			const code = key.toUpperCase().charCodeAt(0) - 64;
			if (code >= 1 && code <= 26) data = String.fromCharCode(code);
			else data = key;
			ctrlActive = false;
		} else if (altActive) {
			data = '\x1b' + key;
			altActive = false;
		}

		sendInput(data);
	}

	function toggleCtrl() {
		ctrlActive = !ctrlActive;
		altActive = false;
	}

	function toggleAlt() {
		altActive = !altActive;
		ctrlActive = false;
	}

	// Wrapper for touch events — prevents default (no scroll/zoom) and sends key
	function xkey(key: string) {
		return (e: TouchEvent) => {
			e.preventDefault();
			sendKey(key);
		};
	}

	// Mobile button: send Shift+Enter (newline without submit)
	function xnewline(e: TouchEvent) {
		e.preventDefault();
		if (kittyModeActive) {
			sendInput('\x1b[13;2u');
		} else {
			sendInput('\x1b\r');
		}
	}

	function xctrl(e: TouchEvent) {
		e.preventDefault();
		toggleCtrl();
	}

	function xalt(e: TouchEvent) {
		e.preventDefault();
		toggleAlt();
	}

	let resizeObserver: ResizeObserver | null = null;

	function handleBeforeUnload() {
		// Only auto-kill on unload for throwaway terminals. keepAlive sessions
		// (the chat drawer) MUST survive a refresh/close so the operator can
		// reattach to the still-running session — killing here was exactly why
		// "every refresh starts a new session": the beacon killed it before the
		// reloaded page could reconnect.
		if (sessionId && running && !keepAlive) {
			// Fire-and-forget kill on tab close — use sendBeacon for reliability
			const blob = new Blob([JSON.stringify({ action: 'kill', sessionId })], { type: 'application/json' });
			navigator.sendBeacon('/api/pty', blob);
		}
	}

	onMount(() => {
		window.addEventListener('beforeunload', handleBeforeUnload);
		initTerminal();
		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload);
			resizeObserver?.disconnect();
		};
	});

	// --- Kitty keyboard protocol negotiation ---
	// Claude Code sends \x1b[>Pu to enable kitty mode and \x1b[?u to query.
	// We intercept these in the output stream and respond so Claude Code
	// knows we support CSI u encoding (e.g. \x1b[13;2u for Shift+Enter).
	let kittyModeActive = false;

	function handleKittyProtocol(data: string): string {
		// Detect \x1b[>1u or \x1b[>Nu (enable kitty keyboard, flags N)
		if (data.includes('\x1b[>')) {
			const enableMatch = data.match(/\x1b\[>(\d+)u/);
			if (enableMatch) {
				kittyModeActive = true;
				// Strip the enable sequence from terminal output (don't render it)
				data = data.replace(/\x1b\[>\d+u/g, '');
			}
		}

		// Detect \x1b[?u (query kitty mode) — respond with current flags
		if (data.includes('\x1b[?u')) {
			if (kittyModeActive) {
				// Respond: "yes, kitty mode is active with flags=1"
				sendInput('\x1b[?1u');
			}
			data = data.replace(/\x1b\[\?u/g, '');
		}

		// Detect \x1b[<Nu (pop/disable kitty mode)
		if (data.includes('\x1b[<')) {
			const disableMatch = data.match(/\x1b\[<(\d*)u/);
			if (disableMatch) {
				kittyModeActive = false;
				data = data.replace(/\x1b\[<\d*u/g, '');
			}
		}

		return data;
	}

	// --- RAF-batched writer: coalesces rapid SSE chunks into ~60 writes/sec ---
	let writeQueue = '';
	let writeRafId: number | null = null;
	// While the user is actively selecting (mouse held down), pause flushing PTY
	// output: the TUI's repaints clear xterm's on-screen selection, so without
	// this you can never drag a range — only grab what a double-click selects
	// instantly. Output buffers in writeQueue and flushes on mouse-up, so the
	// highlight holds still while you select.
	let selecting = false;
	let cleanupSelection: (() => void) | null = null;

	function batchWrite(data: string) {
		// Intercept kitty protocol negotiation before queuing for render
		data = handleKittyProtocol(data);
		if (!data) return;
		writeQueue += data;
		if (writeRafId === null && !selecting) {
			writeRafId = requestAnimationFrame(flushWrites);
		}
	}

	function flushWrites() {
		writeRafId = null;
		if (selecting || !writeQueue || !terminal) return;
		const data = writeQueue;
		writeQueue = '';
		terminal.write(data);
		// If more arrived during the write, schedule another flush
		if (writeQueue) writeRafId = requestAnimationFrame(flushWrites);
	}

	async function initTerminal() {
		const { Terminal } = await import('@xterm/xterm');
		const { FitAddon } = await import('@xterm/addon-fit');
		const { WebLinksAddon } = await import('@xterm/addon-web-links');
		const { WebglAddon } = await import('@xterm/addon-webgl');
		const { CanvasAddon } = await import('@xterm/addon-canvas');
		const { Unicode11Addon } = await import('@xterm/addon-unicode11');
		await import('@xterm/xterm/css/xterm.css');

		// Load UI prefs from localStorage
		let termFontSize = 13;
		let termCursorBlink = true;
		try {
			const prefs = localStorage.getItem('soul-hub-prefs');
			if (prefs) {
				const p = JSON.parse(prefs);
				if (p.fontSize) termFontSize = p.fontSize;
				if (p.cursorBlink !== undefined) termCursorBlink = p.cursorBlink;
			}
		} catch { /* use defaults */ }

		terminal = new Terminal({
			cursorBlink: termCursorBlink,
			fontSize: termFontSize,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
			theme: {
				background: '#0a0a0f',
				foreground: '#e0e0e8',
				cursor: '#a78bfa',
				selectionBackground: '#a78bfa40',
				black: '#1a1a2e',
				red: '#ff6b6b',
				green: '#51cf66',
				yellow: '#fcc419',
				blue: '#748ffc',
				magenta: '#c084fc',
				cyan: '#22d3ee',
				white: '#e0e0e8',
				brightBlack: '#4a4a6a',
				brightRed: '#ff8787',
				brightGreen: '#69db7c',
				brightYellow: '#ffd43b',
				brightBlue: '#91a7ff',
				brightMagenta: '#d8b4fe',
				brightCyan: '#67e8f9',
				brightWhite: '#f8f8ff',
			},
			allowProposedApi: true,
			rescaleOverlappingGlyphs: true,  // shrink glyphs that overflow cell width
			customGlyphs: true,               // pixel-perfect box/block drawing
			allowTransparency: false,          // transparency kills WebGL perf
		});

		fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(new WebLinksAddon());
		terminal.loadAddon(new Unicode11Addon());  // correct emoji/wide char widths

		if (terminalEl) {
			terminal.open(terminalEl);

			// Wait for web font to load before fitting — otherwise fit()
			// measures with a fallback font (narrower glyphs → too many cols)
			// and the PTY gets a cols value wider than the visible area.
			await document.fonts.ready;
			fitAddon.fit();

			// Load WebGL renderer AFTER open() — needs canvas to exist
			try {
				const webgl = new WebglAddon();
				webgl.onContextLoss(() => {
					webgl.dispose();
					terminal.loadAddon(new CanvasAddon());
				});
				terminal.loadAddon(webgl);
			} catch {
				// WebGL not available — fall back to Canvas
				try { terminal.loadAddon(new CanvasAddon()); } catch { /* DOM fallback */ }
			}

			// Re-fit after a short delay to catch any late layout shifts
			setTimeout(() => {
				fitAddon.fit();
				if (sessionId && running) {
					sendResize(terminal.cols, terminal.rows);
				}
			}, 200);
		}

		// Intercept Shift+Enter and Option+Enter for multi-line input.
		// If kitty protocol was negotiated, send CSI 13;2u (Shift+Enter).
		// Otherwise fall back to ESC+CR (Alt+Enter sequence).
		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			if (event.key === 'Enter' && (event.shiftKey || event.altKey)) {
				if (event.type === 'keydown') {
					if (kittyModeActive) {
						sendInput('\x1b[13;2u'); // kitty: Enter + Shift modifier
					} else {
						sendInput('\x1b\r'); // fallback: Alt+Enter
					}
				}
				return false; // block both keydown and keyup from xterm
			}

			// Copy: Cmd+C (macOS) or Ctrl+Shift+C — only consume the chord; a bare
			// Ctrl+C is left alone so it still sends SIGINT to the process. xterm's
			// selection is a canvas overlay, not DOM text, so the browser's native
			// copy can't see it — we read it via getSelection() and write it out.
			const copyPasteChord = event.metaKey || (event.ctrlKey && event.shiftKey);
			if (event.type === 'keydown' && copyPasteChord && (event.key === 'c' || event.key === 'C')) {
				const sel = terminal.getSelection();
				if (sel) navigator.clipboard?.writeText(sel).catch(() => { /* clipboard blocked */ });
				return false; // handled — don't forward to the PTY
			}

			// Paste: Cmd+V (macOS) or Ctrl+Shift+V. (Bare Ctrl+V stays verbatim-insert.)
			if (event.type === 'keydown' && copyPasteChord && (event.key === 'v' || event.key === 'V')) {
				navigator.clipboard?.readText().then((text) => { if (text) sendInput(text); }).catch(() => { /* clipboard blocked */ });
				return false;
			}

			return true;
		});

		terminal.onData((data: string) => {
			if (!sessionId || !running) return;

			// Apply sticky modifiers from the extra-keys toolbar
			if (ctrlActive && data.length === 1) {
				const code = data.toUpperCase().charCodeAt(0) - 64;
				if (code >= 1 && code <= 26) {
					sendInput(String.fromCharCode(code));
				} else {
					sendInput(data);
				}
				ctrlActive = false;
				return;
			}
			if (altActive) {
				sendInput('\x1b' + data);
				altActive = false;
				return;
			}

			sendInput(data);
		});

		let resizeTimer: ReturnType<typeof setTimeout>;
		const ro = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				if (fitAddon && terminal) {
					fitAddon.fit();
					if (sessionId && running) {
						sendResize(terminal.cols, terminal.rows);
					}
				}
			}, 100);
		});
		resizeObserver = ro;
		if (terminalEl) ro.observe(terminalEl);

		// Pause output while selecting: mouse-down in the terminal freezes the
		// screen so a drag can build a full selection without repaints wiping it;
		// mouse-up (anywhere) resumes and flushes the buffered output. Listener on
		// document so a release outside the terminal still resumes.
		const onTermMouseDown = () => { selecting = true; };
		const onDocMouseUp = () => {
			if (!selecting) return;
			selecting = false;
			if (writeQueue && writeRafId === null) writeRafId = requestAnimationFrame(flushWrites);
		};
		terminalEl?.addEventListener('mousedown', onTermMouseDown);
		document.addEventListener('mouseup', onDocMouseUp);
		cleanupSelection = () => {
			terminalEl?.removeEventListener('mousedown', onTermMouseDown);
			document.removeEventListener('mouseup', onDocMouseUp);
		};

		// Select-to-copy. Claude's TUI repaints frequently (spinner, status line)
		// and each repaint clears xterm's on-screen selection — so the highlight
		// vanishes before you can copy it. We copy whenever a non-empty selection
		// SETTLES (debounced): the text is captured into `toCopy` and copied even
		// if a repaint wipes the live selection a moment later. Cmd+C / Ctrl+Shift+C
		// still work as an explicit copy.
		let copyTimer: ReturnType<typeof setTimeout> | null = null;
		let lastCopied = '';
		terminal.onSelectionChange(() => {
			const sel = terminal?.getSelection();
			if (!sel || !sel.trim() || sel === lastCopied) return;
			if (copyTimer) clearTimeout(copyTimer);
			const toCopy = sel;
			copyTimer = setTimeout(() => {
				lastCopied = toCopy;
				navigator.clipboard?.writeText(toCopy)
					.then(() => showToast('Copied', `${toCopy.length} char${toCopy.length === 1 ? '' : 's'}`, 'ok'))
					.catch(() => { /* clipboard blocked */ });
			}, 250);
		});

		isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

		// Track scroll position to show "scroll to bottom" button
		terminal.onScroll(() => {
			const buf = terminal.buffer.active;
			scrolledUp = buf.viewportY < buf.baseY;
		});

		// Touch scroll: attach handlers to the xterm viewport so vertical
		// swipes scroll the scrollback buffer instead of being swallowed.
		if (isTouchDevice && terminalEl) {
			const viewport = terminalEl.querySelector('.xterm-screen') as HTMLElement;
			if (viewport) {
				viewport.addEventListener('touchstart', (e: TouchEvent) => {
					if (e.touches.length === 1) {
						touchStartY = e.touches[0].clientY;
						touchScrollActive = true;
						// Long-press (hold still ~500ms) opens the copy overlay.
						if (longPressTimer) clearTimeout(longPressTimer);
						longPressTimer = setTimeout(() => { longPressTimer = null; openCopyOverlay(); }, 500);
					}
				}, { passive: true });

				viewport.addEventListener('touchmove', (e: TouchEvent) => {
					if (!touchScrollActive || e.touches.length !== 1) return;
					const deltaY = touchStartY - e.touches[0].clientY;
					// Any real movement = a scroll, not a long-press — cancel the timer.
					if (Math.abs(deltaY) > 8 && longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
					const lines = Math.round(deltaY / 20); // ~20px per line
					if (lines !== 0) {
						terminal.scrollLines(lines);
						touchStartY = e.touches[0].clientY;
					}
					// Always prevent default on the terminal to avoid page bounce
					e.preventDefault();
				}, { passive: false });

				viewport.addEventListener('touchend', () => {
					touchScrollActive = false;
					if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
				}, { passive: true });
			}
		}

		terminal.writeln('\x1b[38;5;141m  Soul Hub v2\x1b[0m');
		terminal.writeln('\x1b[38;5;245m  PTY Terminal\x1b[0m');
		terminal.writeln('');

		if (reconnectSessionId) {
			// Connect to an existing session instead of spawning
			sessionId = reconnectSessionId;
			running = true;
			terminal.writeln(`\x1b[38;5;245m  Connecting to session ${reconnectSessionId}...\x1b[0m`);
			attemptReconnect(5, { freshMount: true });
		} else if (autoSpawn && (prompt || resumeSessionId || shell)) {
			spawn();
		}
	}

	onDestroy(() => {
		if (writeRafId !== null) cancelAnimationFrame(writeRafId);
		if (inputRafId !== null) cancelAnimationFrame(inputRafId);
		if (uploadToastTimer) clearTimeout(uploadToastTimer);
		if (longPressTimer) clearTimeout(longPressTimer);
		cleanupSelection?.();
		if (abortController) abortController.abort();
		// Only kill the session if keepAlive is false (default behavior for interactive terminals).
		// PM and worker terminals use keepAlive=true so collapsing doesn't kill the session.
		if (sessionId && !keepAlive) killSession();
		if (terminal) terminal.dispose();
	});

	// --- RAF-batched input: coalesces rapid keystrokes into ~60 sends/sec ---
	let inputQueue = '';
	let inputRafId: number | null = null;

	function sendInput(data: string) {
		inputQueue += data;
		if (inputRafId === null) {
			inputRafId = requestAnimationFrame(flushInput);
		}
	}

	async function flushInput() {
		inputRafId = null;
		if (!inputQueue || !sessionId) return;
		const data = inputQueue;
		inputQueue = '';
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'input', sessionId, data }),
			});
		} catch { /* best effort */ }
		// If more arrived during the fetch, schedule another flush
		if (inputQueue) inputRafId = requestAnimationFrame(flushInput);
	}

	async function sendResize(cols: number, rows: number) {
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'resize', sessionId, cols, rows }),
			});
		} catch { /* best effort */ }
	}

	async function killSession() {
		try {
			await fetch('/api/pty', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'kill', sessionId }),
			});
		} catch { /* best effort */ }
	}

	export function spawn(customPrompt?: string, opts?: { continueSession?: boolean; shell?: boolean }) {
		const p = customPrompt ?? prompt;
		const shouldContinue = opts?.continueSession ?? continueSession;
		const isShell = opts?.shell ?? shell;

		error = '';
		exitCode = null;
		running = true;
		sessionId = '';

		// Resuming an existing conversation (--resume) or continuing the latest
		// (--continue) must NOT re-inject the scope primer — that pastes it as a
		// new message. The primer is for brand-new sessions only.
		const isResume = !isShell && !shouldContinue && !!resumeSessionId;
		const label = isShell ? 'Opening shell' : (shouldContinue || isResume) ? 'Resuming session' : 'Starting agent';
		terminal?.writeln(`\x1b[38;5;245m  ${label} in ${cwd || 'HOME'}...\x1b[0m`);
		terminal?.focus();

		abortController = new AbortController();

		fetch('/api/pty', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'spawn',
				prompt: (isShell || shouldContinue || isResume) ? undefined : p,
				cwd: cwd || undefined,
				cols: terminal?.cols || 120,
				rows: terminal?.rows || 40,
				continueSession: isShell ? undefined : shouldContinue || undefined,
				resumeSessionId: isShell || shouldContinue ? undefined : (resumeSessionId || undefined),
				origin: origin || undefined,
				shell: isShell || undefined,
			}),
			signal: abortController.signal,
		}).then(async (res) => {
			if (!res.ok || !res.body) {
				// Surface the server's reason (e.g. "Claude Code CLI not found …",
				// node-pty spawn failure) instead of a bare status code.
				let detail = '';
				try {
					const body = await res.json();
					if (body?.error) detail = ` — ${body.error}`;
				} catch { /* non-JSON body */ }
				error = `Request failed: ${res.status}${detail}`;
				running = false;
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const raw = line.slice(6);
					if (raw === '[DONE]') continue;

					try {
						const msg = JSON.parse(raw);
						switch (msg.type) {
							case 'session':
								sessionId = msg.sessionId;
								// ADR-005: notify parent so it can store the ID for reconnect.
								onSessionStart?.(msg.sessionId);
								break;
							case 'output':
								batchWrite(msg.data);
								break;
							case 'spawned':
								pid = msg.pid;
								break;
							case 'exit':
								exitCode = msg.code;
								running = false;
								sessionId = '';
								terminal?.writeln('');
								terminal?.writeln(`\x1b[38;5;${msg.code === 0 ? '82' : '203'}m  Process exited (code ${msg.code})\x1b[0m`);
								break;
						}
					} catch { /* skip */ }
				}
			}

			if (running && sessionId) {
				// Stream dropped but process may still be alive — try reconnect
				terminal?.writeln('\x1b[38;5;214m  Connection lost — reconnecting...\x1b[0m');
				attemptReconnect();
			} else if (running) {
				running = false;
				terminal?.writeln('\x1b[38;5;245m  Stream ended\x1b[0m');
			}
		}).catch((e) => {
			if (e.name !== 'AbortError') {
				if (sessionId && running) {
					terminal?.writeln(`\x1b[38;5;214m  Connection lost — reconnecting...\x1b[0m`);
					attemptReconnect();
				} else {
					error = e.message;
					running = false;
				}
			}
		});
	}

	async function attemptReconnect(retries = 3, opts?: { freshMount?: boolean }) {
		// freshMount = a brand-new xterm is connecting to an already-running session
		// (e.g. the chat drawer was collapsed and re-opened). In that case the
		// terminal is empty and the persistent process's screen state must be
		// re-established. When false (a mid-session stream drop into the SAME xterm)
		// the content is already on screen and must NOT be wiped.
		const freshMount = opts?.freshMount === true;
		for (let i = 0; i < retries; i++) {
			await new Promise(r => setTimeout(r, 1000 * (i + 1)));
			try {
				abortController = new AbortController();
				const res = await fetch('/api/pty', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'reconnect',
						sessionId,
						cols: terminal?.cols || 120,
						rows: terminal?.rows || 40,
					}),
					signal: abortController.signal,
				});

				if (!res.ok || !res.body) {
					if (res.status === 404) {
						// Session is gone — process exited
						terminal?.writeln('\x1b[38;5;245m  Session ended\x1b[0m');
						running = false;
						sessionId = '';
						return;
					}
					continue; // retry
				}

				terminal?.writeln('\x1b[38;5;82m  Reconnected\x1b[0m');

				if (freshMount && terminal) {
					// Re-establish the screen on a fresh xterm WITHOUT replaying the
					// raw historical log. Replay was the cause of "text all over the
					// place": /api/sessions/{id} returns only the last 32KB tail, so a
					// 500KB-900KB Claude TUI log starts mid-escape-sequence (the
					// alt-screen enable + all prior cursor context already scrolled
					// off), and its absolute cursor moves were captured at the
					// session's earlier geometry — both render as garbage in a freshly
					// sized terminal.
					const { cols, rows } = terminal;

					// Match the live PTY + its server-side headless mirror to this
					// fresh terminal's geometry so the snapshot is reflowed to the size
					// we're about to render at.
					await sendResize(cols, rows);

					// Preferred: paint the headless mirror's serialized current screen
					// (complete + geometry-matched — no diff-repaint gaps).
					let snapshot = '';
					try {
						const snapRes = await fetch('/api/pty', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ action: 'snapshot', sessionId }),
						});
						if (snapRes.ok) snapshot = (await snapRes.json())?.snapshot ?? '';
					} catch { /* fall through to repaint fallback */ }

					terminal.reset();
					if (snapshot) {
						// The server's snapshot already includes the alternate-screen
						// enter when (and only when) the process is on the alt buffer —
						// so we paint it verbatim, no client-side mode guessing.
						terminal.write(snapshot);
					} else {
						// Fallback (no mirror, e.g. a session spawned before this shipped):
						// clear an alt-screen and force a SIGWINCH so the process repaints
						// its current frame.
						terminal.write('\x1b[?1049h\x1b[2J\x1b[H');
						await sendResize(cols, Math.max(1, rows - 1));
						await new Promise((r) => setTimeout(r, 60));
						await sendResize(cols, rows);
					}
				}
				// Mid-session stream drop (freshMount=false): the same xterm already
				// holds the rendered screen — just resume the live stream below.

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const raw = line.slice(6);
						if (raw === '[DONE]') continue;

						try {
							const msg = JSON.parse(raw);
							switch (msg.type) {
								case 'output':
									batchWrite(msg.data);
									break;
								case 'exit':
									exitCode = msg.code;
									running = false;
									sessionId = '';
									terminal?.writeln('');
									terminal?.writeln(`\x1b[38;5;${msg.code === 0 ? '82' : '203'}m  Process exited (code ${msg.code})\x1b[0m`);
									return;
							}
						} catch { /* skip */ }
					}
				}

				// Stream ended again — try reconnect again
				if (running && sessionId) {
					terminal?.writeln('\x1b[38;5;214m  Connection lost — reconnecting...\x1b[0m');
					return attemptReconnect(retries);
				}
				return;
			} catch (e: unknown) {
				if (e instanceof Error && e.name === 'AbortError') return;
				// retry
			}
		}

		// All retries failed
		terminal?.writeln('\x1b[38;5;203m  Could not reconnect after ' + retries + ' attempts\x1b[0m');
		error = 'Connection lost — session may still be running on the server';
		running = false;
	}

	export function kill() {
		if (abortController) abortController.abort();
		if (sessionId) killSession();
		running = false;
		sessionId = '';
		terminal?.writeln('\x1b[38;5;203m  Killed by user\x1b[0m');
	}

	export function clear() {
		terminal?.clear();
	}

	/** Open the file picker — lets a parent (chat drawer) surface upload in its
	 *  own toolbar without duplicating the upload logic. */
	export function triggerUpload() {
		fileInput?.click();
	}

	async function uploadFiles(files: FileList | File[]) {
		if (files.length === 0) return;
		uploading = true;

		const formData = new FormData();
		if (cwd) {
			formData.append('targetPath', cwd);
		}
		if (projectName) {
			formData.append('project', projectName);
		}
		if (!cwd && !projectName) {
			// No project/cwd context (standalone /terminal) — upload to temp dir
			formData.append('temp', '1');
		}
		for (const file of files) {
			formData.append('files', file);
		}

		try {
			const res = await fetch('/api/upload', { method: 'POST', body: formData });
			const data = await res.json();

			if (!res.ok) {
				showToast('Upload failed', data.error || '', 'err');
				return;
			}

			const paths = (data.uploaded as { name: string; path: string; size: number }[])
				.map((f) => f.path);

			// If a session is running, paste the path(s) into its input so Claude
			// can Read them — terminal.focus() so the next keypress lands in the app.
			if (running && sessionId) {
				sendInput(paths.join(' ') + ' ');
				terminal?.focus();
			}

			const summary = `Uploaded ${paths.length} file${paths.length === 1 ? '' : 's'}`
				+ (running && sessionId ? ' · path pasted into session' : '');
			showToast(summary, paths.length === 1 ? paths[0] : `${paths.length} files`, 'ok');
		} catch {
			showToast('Upload failed', 'network error', 'err');
		} finally {
			uploading = false;
		}
	}

	function showToast(text: string, detail: string, kind: 'ok' | 'err') {
		uploadToast = { text, detail, kind };
		if (uploadToastTimer) clearTimeout(uploadToastTimer);
		uploadToastTimer = setTimeout(() => { uploadToast = null; }, kind === 'err' ? 6000 : 4000);
	}

	function handleFileSelect() {
		fileInput?.click();
	}

	function onFileInputChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) uploadFiles(input.files);
		input.value = ''; // reset so same file can be picked again
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragActive = false;
		if (e.dataTransfer?.files) uploadFiles(e.dataTransfer.files);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragActive = true;
	}

	function handleDragLeave(e: DragEvent) {
		// Only clear when leaving the container itself, not its children
		if (e.target === e.currentTarget) dragActive = false;
	}
</script>

<!-- Hidden file input -->
<input
	bind:this={fileInput}
	type="file"
	multiple
	class="hidden"
	onchange={onFileInputChange}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex flex-col h-full"
	ondrop={handleDrop}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
>
	<div class="flex items-center justify-between px-3 py-2 bg-[#0a0a0f] border-b border-hub-border/50 text-xs">
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-1.5">
				<span class="w-2 h-2 rounded-full {running ? 'bg-green-400 animate-pulse' : exitCode !== null ? (exitCode === 0 ? 'bg-green-400' : 'bg-red-400') : 'bg-hub-dim'}"></span>
				<span class="text-hub-muted">
					{#if running}Running{:else if exitCode !== null}Done{:else}Ready{/if}
				</span>
			</div>
			{#if pid}
				<span class="text-hub-dim font-mono">PID {pid}</span>
			{/if}
			{#if exitCode !== null}
				<span class="font-mono {exitCode === 0 ? 'text-green-400' : 'text-red-400'}">exit {exitCode}</span>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<button
				onclick={handleFileSelect}
				disabled={uploading}
				class="flex items-center gap-1 px-2 py-1 rounded text-hub-muted hover:bg-hub-surface hover:text-hub-text transition-colors cursor-pointer disabled:opacity-50"
				title={cwd || projectName ? 'Upload files to project' : 'Upload files (saved to ~/.soul-hub/uploads)'}
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
				</svg>
				{#if uploading}Uploading...{:else}Upload{/if}
			</button>
			{#if running}
				<button onclick={kill} class="px-2 py-1 rounded text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer">Kill</button>
			{/if}
			<button onclick={clear} class="px-2 py-1 rounded text-hub-muted hover:bg-hub-surface transition-colors cursor-pointer">Clear</button>
		</div>
	</div>

	<div class="relative flex-1 min-h-0 overflow-hidden">
		<div bind:this={terminalEl} class="w-full h-full"></div>

		<!-- Drag-to-upload overlay — only while a file is being dragged over -->
		{#if dragActive}
			<div class="absolute inset-0 z-20 flex items-center justify-center bg-hub-bg/70 backdrop-blur-sm border-2 border-dashed border-hub-purple/70 rounded pointer-events-none">
				<div class="flex flex-col items-center gap-2 text-hub-purple">
					<svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
					</svg>
					<span class="text-sm font-medium">Drop to upload</span>
				</div>
			</div>
		{/if}

		<!-- Upload toast — overlaid, never written into the xterm buffer -->
		{#if uploadToast}
			<div class="absolute top-3 right-3 z-30 max-w-sm pointer-events-none">
				<div class="flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg text-xs border
					{uploadToast.kind === 'ok' ? 'bg-hub-surface/95 border-green-400/40' : 'bg-hub-surface/95 border-red-400/50'}">
					<span class="mt-0.5 w-2 h-2 rounded-full flex-shrink-0 {uploadToast.kind === 'ok' ? 'bg-green-400' : 'bg-red-400'}"></span>
					<div class="min-w-0">
						<div class="text-hub-text font-medium">{uploadToast.text}</div>
						{#if uploadToast.detail}
							<div class="text-hub-dim font-mono truncate mt-0.5">{uploadToast.detail}</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Scroll to bottom FAB -->
		{#if scrolledUp}
			<button
				onclick={() => { terminal?.scrollToBottom(); scrolledUp = false; }}
				class="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-hub-purple/90 text-white flex items-center justify-center shadow-lg hover:bg-hub-purple transition-colors z-10 cursor-pointer"
				title="Scroll to bottom"
				onmousedown={(e) => e.preventDefault()}
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="6 9 12 15 18 9"/>
				</svg>
			</button>
		{/if}

		<!-- Mobile copy overlay: native-selectable text of the recent buffer.
		     Long-press the terminal (or the COPY key) opens this; select with the
		     OS and copy, or tap "Copy all". -->
		{#if copyOverlayText !== null}
			<div class="absolute inset-0 z-40 flex flex-col bg-hub-bg/95 backdrop-blur-sm">
				<div class="flex items-center justify-between px-3 py-2 border-b border-hub-border/50 text-xs flex-shrink-0">
					<span class="text-hub-muted">Select text to copy</span>
					<div class="flex items-center gap-2">
						<button onclick={copyAllOverlay} class="px-3 py-1 rounded bg-hub-cta text-hub-bg font-medium cursor-pointer">Copy all</button>
						<button onclick={() => (copyOverlayText = null)} class="px-3 py-1 rounded bg-hub-card border border-hub-border text-hub-muted hover:text-hub-text transition-colors cursor-pointer">Close</button>
					</div>
				</div>
				<textarea
					readonly
					class="flex-1 min-h-0 w-full resize-none bg-hub-bg text-hub-text font-mono text-xs leading-relaxed p-3 outline-none select-text"
					style="-webkit-user-select: text; user-select: text;"
				>{copyOverlayText}</textarea>
			</div>
		{/if}
	</div>

	<!-- Mobile extra keys toolbar -->
	{#if isTouchDevice}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="xkey-bar flex-shrink-0 bg-[#0d0d14] border-t border-hub-border/50 select-none"
			onmousedown={(e) => e.preventDefault()}
		>
			<!-- Row 1: modifiers + special chars + Up arrow -->
			<div class="flex items-center px-1 pt-1 pb-0.5 gap-0.5">
				<button ontouchstart={xnewline} class="xkey text-[9px] text-hub-purple">S+&#x23CE;</button>
				<button ontouchstart={xkey('\x1b')} class="xkey">ESC</button>
				<button ontouchstart={xkey('\t')} class="xkey">TAB</button>
				<button ontouchstart={xctrl} class="xkey {ctrlActive ? 'xkey-active' : ''}">CTL</button>
				<button ontouchstart={xalt} class="xkey {altActive ? 'xkey-active' : ''}">ALT</button>
				<button ontouchstart={xkey('/')} class="xkey">/</button>
				<button ontouchstart={xkey('-')} class="xkey">-</button>
				<button ontouchstart={(e) => { e.preventDefault(); openCopyOverlay(); }} class="xkey text-[9px] text-hub-cta" title="Copy text">COPY</button>
				<button ontouchstart={(e) => { e.preventDefault(); pasteFromClipboard(); }} class="xkey text-[9px] text-hub-cta" title="Paste from clipboard">PASTE</button>
				<div class="ml-auto flex gap-0.5">
					<div class="w-9"></div>
					<button ontouchstart={xkey('\x1b[A')} class="xkey xkey-arrow">&uarr;</button>
					<div class="w-9"></div>
				</div>
			</div>
			<!-- Row 2: more chars + Left/Down/Right arrows -->
			<div class="flex items-center px-1 pb-1 pt-0.5 gap-0.5">
				<button ontouchstart={xkey('|')} class="xkey">|</button>
				<button ontouchstart={xkey('*')} class="xkey">*</button>
				<button ontouchstart={xkey('{')} class="xkey">&#123;</button>
				<button ontouchstart={xkey('}')} class="xkey">&#125;</button>
				<button ontouchstart={xkey('\x1b[H')} class="xkey text-[9px]">HOM</button>
				<button ontouchstart={xkey('\x1b[F')} class="xkey text-[9px]">END</button>
				<button ontouchstart={xkey('\x1b[5~')} class="xkey text-[9px]">PU</button>
				<button ontouchstart={xkey('\x1b[6~')} class="xkey text-[9px]">PD</button>
				<div class="ml-auto flex gap-0.5">
					<button ontouchstart={xkey('\x1b[D')} class="xkey xkey-arrow">&larr;</button>
					<button ontouchstart={xkey('\x1b[B')} class="xkey xkey-arrow">&darr;</button>
					<button ontouchstart={xkey('\x1b[C')} class="xkey xkey-arrow">&rarr;</button>
				</div>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="px-3 py-2 bg-red-500/10 border-t border-red-500/30 text-xs text-red-400">
			{error}
		</div>
	{/if}
</div>
