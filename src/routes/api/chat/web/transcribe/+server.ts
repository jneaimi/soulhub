/** POST /api/chat/web/transcribe — browser-mic transcription endpoint (ADR-019).
 *
 *  Accepts multipart/form-data:
 *    audio    File   — required; the recorded audio blob
 *    mimetype string — optional; overrides the file's MIME type
 *    language string — optional; BCP-47 language hint (e.g. "ar-SA", "en-US")
 *
 *  Returns `{ text, providerId, modelId, ms }` on success.
 *  Returns `{ error }` with the appropriate HTTP status on failure.
 *  Never throws raw Error objects to the client.
 *
 *  Reuses `transcribeVoiceNote` — the same Gemini multimodal primitive that
 *  WhatsApp and Telegram inbound voice notes use (whatsapp ADR-021).
 *  The endpoint adds only the capture seam: form parsing, size cap, and a
 *  lightweight per-session rate-limiter.
 *
 *  Rate-limit: 60 transcription calls per 10-minute window per browser session
 *  (identified by a httpOnly `soul-voice-session` cookie). Prevents runaway
 *  captures without requiring auth — this endpoint is only reachable from the
 *  local operator UI.
 */

import type { RequestHandler } from './$types';
import { json }                from '@sveltejs/kit';
import { randomUUID }          from 'node:crypto';
import { transcribeVoiceNote } from '$lib/channels/whatsapp/transcribe.js';
import { config }              from '$lib/config.js';

// ── Size cap ──────────────────────────────────────────────────────────────────
/** 16 MB — matches WhatsApp's audio cap (`maxMediaSizeMB` default in config.schema.ts). */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

// ── Per-session rate-limiter (in-memory) ──────────────────────────────────────
const MAX_CALLS_PER_WINDOW = 60;
const WINDOW_MS            = 10 * 60 * 1000; // 10 minutes

interface Bucket { count: number; windowStart: number; }
const buckets = new Map<string, Bucket>();

function rateCheck(id: string): { ok: boolean; retryAfterMs?: number } {
	const now = Date.now();
	const b   = buckets.get(id);

	if (!b || now - b.windowStart >= WINDOW_MS) {
		buckets.set(id, { count: 1, windowStart: now });
		return { ok: true };
	}
	if (b.count >= MAX_CALLS_PER_WINDOW) {
		return { ok: false, retryAfterMs: WINDOW_MS - (now - b.windowStart) };
	}
	b.count++;
	return { ok: true };
}

// Prune stale buckets to bound Map growth — runs every full window.
// `.unref()` prevents the timer from keeping the process alive on shutdown.
const _pruner = setInterval(() => {
	const cutoff = Date.now() - WINDOW_MS * 2;
	for (const [id, b] of buckets) {
		if (b.windowStart < cutoff) buckets.delete(id);
	}
}, WINDOW_MS);
// Node's `Timeout` from `setInterval` has `.unref()`; be defensive.
if (typeof _pruner === 'object' && _pruner !== null && 'unref' in _pruner) {
	(_pruner as { unref(): void }).unref();
}

// ── Session cookie ────────────────────────────────────────────────────────────
const SESSION_COOKIE = 'soul-voice-session';

// ── Route handler ─────────────────────────────────────────────────────────────
export const POST: RequestHandler = async ({ request, cookies }) => {
	// ── Resolve session for rate-limiting ─────────────────────────────────────
	let sid = cookies.get(SESSION_COOKIE);
	if (!sid) {
		sid = randomUUID();
		cookies.set(SESSION_COOKIE, sid, {
			path:     '/',
			httpOnly: true,
			sameSite: 'strict',
			maxAge:   60 * 60 * 24 * 30, // 30 days
		});
	}

	// ── Rate-limit check ──────────────────────────────────────────────────────
	const rl = rateCheck(sid);
	if (!rl.ok) {
		const retryS = Math.ceil((rl.retryAfterMs ?? 0) / 1000);
		return json(
			{ error: `Rate limit reached — too many transcriptions. Retry in ${retryS} s.` },
			{ status: 429 },
		);
	}

	// ── Parse multipart form data ─────────────────────────────────────────────
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json(
			{ error: 'Expected multipart/form-data with an `audio` file field.' },
			{ status: 400 },
		);
	}

	const audioFile = form.get('audio');
	if (!(audioFile instanceof File)) {
		return json(
			{ error: 'Missing or invalid `audio` field — must be a File.' },
			{ status: 400 },
		);
	}

	// ── Size cap ──────────────────────────────────────────────────────────────
	if (audioFile.size > MAX_AUDIO_BYTES) {
		return json(
			{
				error: `Audio clip exceeds the 16 MB cap (was ${(audioFile.size / 1024 / 1024).toFixed(1)} MB). Record a shorter clip.`,
			},
			{ status: 413 },
		);
	}

	// ── Buffer + MIME ─────────────────────────────────────────────────────────
	const buf          = Buffer.from(await audioFile.arrayBuffer());
	const mimeOverride = form.get('mimetype');
	const mimetype     =
		(typeof mimeOverride === 'string' && mimeOverride.trim())
			? mimeOverride.trim()
			: audioFile.type || 'audio/webm';

	// ── Transcribe — reuse the WhatsApp/Telegram primitive (ADR-019) ──────────
	// Provider reference: prefer the WhatsApp delivery config if set, else fall
	// back to the default model so the endpoint works even when WhatsApp is
	// not configured.
	const providerRef =
		config.channels.whatsapp?.delivery?.transcribeProvider ??
		'gemini:gemini-2.5-flash';

	const t0 = Date.now();
	let result: { text: string; providerId: string; modelId: string };
	try {
		result = await transcribeVoiceNote({ audio: buf, mimetype, providerRef });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Transcription failed.';
		console.error('[api/chat/web/transcribe]', msg);
		return json({ error: msg }, { status: 502 });
	}

	return json({
		text:       result.text,
		providerId: result.providerId,
		modelId:    result.modelId,
		ms:         Date.now() - t0,
	});
};
