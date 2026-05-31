/** Realtime speech-to-text capture (ADR-020).
 *
 *  A framework-free wrapper over `@elevenlabs/client`'s `Scribe` realtime
 *  connection. It mints a single-use token from our server route, opens a
 *  WebSocket *directly* to ElevenLabs (audio never transits Soul Hub), streams
 *  microphone PCM via the SDK's built-in mic capture, and surfaces partial +
 *  committed transcripts through plain callbacks.
 *
 *  Pure capture: it knows nothing about chat drawers or terminals, so the same
 *  primitive drives both the Orchestrator input and the PTY (`sendInput`).
 *
 *  Browser-only — the SDK is dynamically imported so this never loads during
 *  SSR. Callers should invoke `startRealtimeStt` from a user gesture (click) so
 *  the browser grants microphone access.
 */

export interface RealtimeSttCallbacks {
	/** The WebSocket opened (handshake done; session not yet confirmed). */
	onOpen?: () => void;
	/** The transcription session is live — audio is now being processed. */
	onSessionStarted?: () => void;
	/** Interim transcript for the current (not-yet-committed) segment. Replaces
	 *  the live tail on each call — do not append. */
	onPartial?: (text: string) => void;
	/** A finalised segment. Append these to build the full dictation. */
	onCommitted: (text: string) => void;
	/** Fatal/stream error — the session is over; caller should clean up UI. */
	onError?: (message: string) => void;
	/** The WebSocket closed (after `stop()` or upstream close). */
	onClose?: () => void;
	/** ISO-639-1/3 language hint (e.g. "en", "ar"). Optional. */
	languageCode?: string;
}

export interface RealtimeSttHandle {
	/** Stop capture, commit any buffered audio, and close the connection. */
	stop: () => void;
}

/** Thrown when the realtime path is unavailable (flag off, no key, mint failed,
 *  network). The caller distinguishes this from a mic-permission denial to
 *  decide whether to fall back to the batch-upload path. */
export class RealtimeSttUnavailableError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name   = 'RealtimeSttUnavailableError';
		this.status = status;
	}
}

const MODEL_ID = 'scribe_v2_realtime';

/** Pre-import the browser SDK so the first `startRealtimeStt` call has no
 *  dynamic-import latency on the tap. On iOS Safari, fewer `await`s between the
 *  user gesture and `getUserMedia`/`AudioContext` preserves the user-activation
 *  that audio capture requires. Safe to call repeatedly (import is cached). */
export async function warmupRealtimeStt(): Promise<void> {
	try { await import('@elevenlabs/client'); } catch { /* best-effort */ }
}

/** Mint a token, open the realtime stream, and start microphone capture.
 *  Resolves with a handle once the connection is established (SESSION_STARTED)
 *  or rejects with `RealtimeSttUnavailableError` if the token mint fails. */
export async function startRealtimeStt(
	cb: RealtimeSttCallbacks,
): Promise<RealtimeSttHandle> {
	// ── 1. Mint a single-use token from our server (key stays server-side) ──────
	let tokenRes: Response;
	try {
		tokenRes = await fetch('/api/chat/web/scribe-token', { method: 'POST' });
	} catch (err) {
		throw new RealtimeSttUnavailableError(
			`Could not reach the token endpoint: ${(err as Error).message ?? 'network error'}`,
		);
	}
	if (!tokenRes.ok) {
		let detail = `HTTP ${tokenRes.status}`;
		try {
			const body = (await tokenRes.json()) as { error?: string };
			if (body?.error) detail = body.error;
		} catch { /* non-JSON body */ }
		throw new RealtimeSttUnavailableError(detail, tokenRes.status);
	}
	const { token } = (await tokenRes.json()) as { token?: string };
	if (!token) {
		throw new RealtimeSttUnavailableError('Token endpoint returned no token.');
	}

	// ── 2. Open the realtime connection (SDK handles mic + PCM16 + chunking) ────
	// Dynamic import keeps the browser-only SDK out of the SSR bundle.
	const { Scribe, RealtimeEvents, CommitStrategy } = await import('@elevenlabs/client');

	const connection = Scribe.connect({
		token,
		modelId: MODEL_ID,
		// VAD commits segments automatically on natural pauses — ideal for
		// free-form dictation into a text box (no manual commit per phrase).
		commitStrategy: CommitStrategy.VAD,
		...(cb.languageCode ? { languageCode: cb.languageCode } : {}),
		microphone: {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl:  true,
		},
	});

	let closed = false;
	let sessionStarted = false;
	let errored = false;
	const stop = () => {
		if (closed) return;
		closed = true;
		try { connection.close(); } catch { /* already closed */ }
	};

	// Surface the real error text (message_type + detail) so failures on devices
	// without easy devtools (mobile) are diagnosable from the UI chip itself.
	const fail = (msg: string) => {
		if (errored) return;
		errored = true;
		console.warn('[voice] realtime error:', msg);
		cb.onError?.(msg);
		stop();
	};

	connection.on(RealtimeEvents.OPEN, () => {
		console.debug('[voice] ws open');
		cb.onOpen?.();
	});
	connection.on(RealtimeEvents.SESSION_STARTED, () => {
		sessionStarted = true;
		console.debug('[voice] session started');
		cb.onSessionStarted?.();
	});
	connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
		if (data?.text) cb.onPartial?.(data.text);
	});
	connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
		if (data?.text) cb.onCommitted(data.text);
	});
	connection.on(RealtimeEvents.ERROR, (data) => {
		const type = data?.message_type ?? 'error';
		fail(`voice ${type}: ${data?.error ?? 'unknown error'}`);
	});
	connection.on(RealtimeEvents.AUTH_ERROR, (data) => {
		fail(`voice auth: ${data?.error ?? 'authentication failed'}`);
	});
	connection.on(RealtimeEvents.CLOSE, (ev) => {
		closed = true;
		// A close *before* the session starts means the stream never came up —
		// report it as an error (with code/reason) instead of a silent no-op.
		if (!sessionStarted && !errored) {
			const code   = ev?.code ?? '?';
			const reason = ev?.reason ? ` ${ev.reason}` : '';
			fail(`voice stream closed before it started (code ${code}${reason})`);
			return;
		}
		cb.onClose?.();
	});

	return { stop };
}
