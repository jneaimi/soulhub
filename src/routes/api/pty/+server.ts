import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	spawnSession,
	getSession,
	writeInput,
	resizeSession,
	killSession,
	listSessions,
	isAlive,
	serializeSession,
} from '$lib/pty/manager.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const action = body.action || 'spawn';

	if (action === 'input') {
		const { sessionId, data } = body;
		if (!writeInput(sessionId, data)) {
			return json({ error: 'Session not found' }, { status: 404 });
		}
		return json({ ok: true });
	}

	if (action === 'resize') {
		const { sessionId, cols, rows } = body;
		if (!resizeSession(sessionId, cols, rows)) {
			return json({ error: 'Session not found' }, { status: 404 });
		}
		return json({ ok: true });
	}

	if (action === 'snapshot') {
		// Reconnect support: VT serialization of the session's current screen from
		// its server-side headless mirror. null ⇒ no mirror (caller falls back to
		// a SIGWINCH repaint). Resize first (separate 'resize' action) so the
		// snapshot reflects the reconnecting terminal's geometry.
		const { sessionId } = body;
		const snapshot = serializeSession(sessionId);
		if (snapshot === null) {
			return json({ error: 'Session not found or snapshot unavailable' }, { status: 404 });
		}
		return json({ snapshot });
	}

	if (action === 'kill') {
		const { sessionId } = body;
		killSession(sessionId);
		return json({ ok: true });
	}

	if (action === 'reconnect') {
		const { sessionId, cols, rows } = body;
		const foundSession = getSession(sessionId);
		if (!foundSession) {
			return json({ error: 'Session not found or already exited' }, { status: 404 });
		}
		const sessionEmitter = foundSession.emitter;

		// Resize to current terminal dimensions
		if (cols && rows) {
			resizeSession(sessionId, cols, rows);
		}

		const enc = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				let closed = false;

				function safeEnqueue(chunk: Uint8Array) {
					if (!closed) {
						try { controller.enqueue(chunk); } catch { /* already closed */ }
					}
				}

				function safeClose() {
					if (!closed) {
						closed = true;
						clearInterval(heartbeat);
						sessionEmitter.removeListener('output', onOutput);
						sessionEmitter.removeListener('exit', onExit);
						try { controller.close(); } catch { /* already closed */ }
					}
				}

				safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'session', sessionId, reconnected: true })}\n\n`));

				const heartbeat = setInterval(() => {
					safeEnqueue(enc.encode(': keepalive\n\n'));
				}, 15_000);

				function onOutput(data: string) {
					safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'output', data })}\n\n`));
				}

				function onExit(code: number) {
					safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`));
					safeEnqueue(enc.encode('data: [DONE]\n\n'));
					safeClose();
				}

				sessionEmitter.on('output', onOutput);
				sessionEmitter.on('exit', onExit);

				request.signal.addEventListener('abort', () => {
					closed = true;
					clearInterval(heartbeat);
					sessionEmitter.removeListener('output', onOutput);
					sessionEmitter.removeListener('exit', onExit);
				});
			},
			cancel() {
				// Don't kill — session stays alive for future reconnects
			},
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}

	// action === 'spawn'
	const { prompt, cwd, cols, rows, continueSession, resumeSessionId, shell, origin } = body;

	// spawnSession throws when the Claude binary is missing (or node-pty can't
	// spawn). Surface that as a legible 422 instead of a bare 500 — the message
	// tells the user to install Claude Code or fix paths.claudeBinary.
	let session: ReturnType<typeof spawnSession>;
	try {
		session = spawnSession({
			prompt: (prompt || '').trim() || undefined,
			cwd: cwd || undefined,
			cols,
			rows,
			continueSession: !!continueSession,
			resumeSessionId: resumeSessionId || undefined,
			shell: !!shell,
			origin: origin || undefined,
		});
	} catch (err) {
		console.error('[pty] spawn failed:', err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start terminal session' },
			{ status: 422 },
		);
	}

	const sessionId = session.id;
	const enc = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let closed = false;

			function safeEnqueue(chunk: Uint8Array) {
				if (!closed) {
					try { controller.enqueue(chunk); } catch { /* already closed */ }
				}
			}

			function safeClose() {
				if (!closed) {
					closed = true;
					clearInterval(heartbeat);
					session.emitter.removeListener('output', onOutput);
					session.emitter.removeListener('exit', onExit);
					session.emitter.removeListener('prompt_sent', onPromptSent);
					try { controller.close(); } catch { /* already closed */ }
				}
			}

			// Session ID message
			safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`));

			// Spawned message
			safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'spawned', pid: session.pid })}\n\n`));

			const heartbeat = setInterval(() => {
				safeEnqueue(enc.encode(': keepalive\n\n'));
			}, 15_000);

			function onOutput(data: string) {
				safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'output', data })}\n\n`));
			}

			function onExit(code: number) {
				safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`));
				safeEnqueue(enc.encode('data: [DONE]\n\n'));
				safeClose();
			}

			function onPromptSent() {
				safeEnqueue(enc.encode(`data: ${JSON.stringify({ type: 'prompt_sent' })}\n\n`));
			}

			session.emitter.on('output', onOutput);
			session.emitter.on('exit', onExit);
			session.emitter.on('prompt_sent', onPromptSent);

			request.signal.addEventListener('abort', () => {
				closed = true;
				clearInterval(heartbeat);
				session.emitter.removeListener('output', onOutput);
				session.emitter.removeListener('exit', onExit);
				session.emitter.removeListener('prompt_sent', onPromptSent);

				// Orphan cleanup. Drawer chat sessions are long-lived: the operator
				// may collapse the drawer / refresh / step away while a coding run
				// continues server-side, then reconnect via the session picker. Give
				// those a 6-hour window (manual kill is available in the picker);
				// other sessions keep the original 5-minute safety net.
				const longLived = origin === 'chat-drawer' || origin === 'chat-terminal';
				const orphanMs = longLived ? 24 * 60 * 60_000 : 300_000;
				const orphanLabel = longLived ? '24h' : '5min';
				setTimeout(() => {
					if (isAlive(sessionId)) {
						console.log(`[pty:${sessionId}] orphan cleanup — killing after ${orphanLabel} with no reconnect`);
						killSession(sessionId);
					}
				}, orphanMs);
			});
		},
		cancel() {
			// Keep process alive for reconnection
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};

/** GET /api/pty — list active sessions */
export const GET: RequestHandler = async () => {
	const active = listSessions();
	return json({ sessions: active, count: active.length });
};
