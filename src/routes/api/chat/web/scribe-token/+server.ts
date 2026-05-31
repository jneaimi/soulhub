/** POST /api/chat/web/scribe-token — mints a single-use ElevenLabs realtime
 *  speech-to-text token for client-side streaming (ADR-020).
 *
 *  The browser opens the realtime WebSocket *directly* to ElevenLabs using this
 *  short-lived token, so audio never routes through Soul Hub (critical for the
 *  phone-over-cellular path) and `ELEVENLABS_API_KEY` never reaches the client.
 *  The token auto-expires after 15 minutes and is consumed on first use.
 *
 *  Returns `{ token }` on success, `{ error }` with an appropriate status
 *  otherwise. Never throws a raw Error to the client.
 *
 *  Gating: requires `features.realtimeVoice === true` (404 when off — the mic
 *  then falls back to the ADR-019 Gemini batch-upload path). Mirrors the
 *  per-session cookie rate-limiter used by the sibling transcribe route.
 */

import type { RequestHandler } from './$types';
import { json }                from '@sveltejs/kit';
import { randomUUID }          from 'node:crypto';
import { config }              from '$lib/config.js';

const ENV_KEY      = 'ELEVENLABS_API_KEY';
const TOKEN_TYPE   = 'realtime_scribe';
const TOKEN_URL    = `https://api.elevenlabs.io/v1/single-use-token/${TOKEN_TYPE}`;

// ── Per-session rate-limiter (in-memory) — mirrors the transcribe route ────────
const MAX_MINTS_PER_WINDOW = 60;
const WINDOW_MS            = 10 * 60 * 1000; // 10 minutes
const SESSION_COOKIE       = 'soul-voice-session';

interface Bucket { count: number; windowStart: number; }
const buckets = new Map<string, Bucket>();

function rateCheck(id: string): { ok: boolean; retryAfterMs?: number } {
	const now = Date.now();
	const b   = buckets.get(id);
	if (!b || now - b.windowStart >= WINDOW_MS) {
		buckets.set(id, { count: 1, windowStart: now });
		return { ok: true };
	}
	if (b.count >= MAX_MINTS_PER_WINDOW) {
		return { ok: false, retryAfterMs: WINDOW_MS - (now - b.windowStart) };
	}
	b.count++;
	return { ok: true };
}

// Prune stale buckets to bound Map growth. `.unref()` keeps the timer from
// holding the process open on shutdown.
const _pruner = setInterval(() => {
	const cutoff = Date.now() - WINDOW_MS * 2;
	for (const [id, b] of buckets) {
		if (b.windowStart < cutoff) buckets.delete(id);
	}
}, WINDOW_MS);
if (typeof _pruner === 'object' && _pruner !== null && 'unref' in _pruner) {
	(_pruner as { unref(): void }).unref();
}

export const POST: RequestHandler = async ({ cookies }) => {
	// ── Feature gate ───────────────────────────────────────────────────────────
	if (config.features.realtimeVoice !== true) {
		return json({ error: 'Realtime voice is disabled.' }, { status: 404 });
	}

	// ── Credential check ─────────────────────────────────────────────────────────
	const apiKey = process.env[ENV_KEY];
	if (!apiKey) {
		return json(
			{ error: 'ELEVENLABS_API_KEY is not set — realtime voice is unavailable.' },
			{ status: 503 },
		);
	}

	// ── Resolve session + rate-limit ─────────────────────────────────────────────
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
	const rl = rateCheck(sid);
	if (!rl.ok) {
		const retryS = Math.ceil((rl.retryAfterMs ?? 0) / 1000);
		return json(
			{ error: `Rate limit reached — too many voice sessions. Retry in ${retryS} s.` },
			{ status: 429 },
		);
	}

	// ── Mint the single-use token ────────────────────────────────────────────────
	let res: Response;
	try {
		res = await fetch(TOKEN_URL, {
			method:  'POST',
			headers: { 'xi-api-key': apiKey },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Token request failed.';
		console.error('[api/chat/web/scribe-token] network', msg);
		return json({ error: 'Could not reach ElevenLabs to mint a voice token.' }, { status: 502 });
	}

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		console.error(`[api/chat/web/scribe-token] HTTP ${res.status}`, body.slice(0, 200));
		// Map upstream auth/quota issues to a 502 so the client falls back to batch.
		return json({ error: `ElevenLabs token mint failed (HTTP ${res.status}).` }, { status: 502 });
	}

	const data = (await res.json().catch(() => null)) as { token?: string } | null;
	if (!data?.token) {
		return json({ error: 'ElevenLabs returned no token.' }, { status: 502 });
	}

	return json({ token: data.token });
};
