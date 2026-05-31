/** ADR-008 P2 — POST /api/evaluate-session/post-call  (RETIRED under ADR-012)
 *
 *  The ElevenLabs post-call transcript webhook. As of ADR-012 the primary
 *  delivery path is app-pull (`POST /api/evaluate-session/ingest`), and this
 *  webhook is retired/disabled on the ElevenLabs side after a week of 401s
 *  auto-disabled it. The route is kept working — and now shares the single
 *  ingestion pipeline (`ingestTranscript`) with /ingest — so it can be
 *  re-enabled as a redundant backup without diverging behavior.
 *
 *  Flow when enabled:
 *    1. Verify ElevenLabs HMAC signature (401 on bad sig).
 *    2. Hand the transcript + dynamic-variable `project` to ingestTranscript
 *       (fire-and-forget — ElevenLabs has a ~10s ACK timeout). */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { ingestTranscript } from '$lib/evaluate-session/ingest-pipeline.js';
import type { PersistedTurn } from '$lib/evaluate-session/index.js';

interface ElevenLabsTurn {
	role: 'agent' | 'user';
	message: string;
	time_in_call_secs?: number;
	interrupted?: boolean;
}

interface ElevenLabsWebhook {
	event_id: string;
	event_timestamp: number;
	type: string;
	data: {
		conversation_id: string;
		agent_id: string;
		status: string;
		transcript: ElevenLabsTurn[];
		analysis?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
		conversation_initiation_client_data?: {
			dynamic_variables?: Record<string, unknown>;
		};
	};
}

/** Resolve the HMAC key bytes from the env-supplied secret.
 *  ElevenLabs uses `wsec_<hex>` for workspace webhook secrets — the post-prefix
 *  payload is HEX-encoded (verified empirically against the live workspace
 *  webhook). Legacy "raw string" secrets (no `wsec_` prefix) are accepted as
 *  UTF-8 bytes for operator-generated dev secrets. */
function resolveHmacKey(secret: string): Buffer {
	if (secret.startsWith('wsec_')) {
		const hex = secret.slice('wsec_'.length);
		if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
			return Buffer.from(hex, 'hex');
		}
	}
	return Buffer.from(secret, 'utf8');
}

/** Verifies `ElevenLabs-Signature: t=<timestamp>,v0=<hmac-sha256>`; the signed
 *  payload is `"<timestamp>.<rawBody>"`, keyed by resolveHmacKey(secret). */
function verifySignature(rawBody: string, header: string, secret: string): boolean {
	const tPart = header.split(',').find((p) => p.startsWith('t='));
	const v0Part = header.split(',').find((p) => p.startsWith('v0='));
	if (!tPart || !v0Part) return false;

	const ts = tPart.slice(2);
	const received = v0Part.slice(3);
	const key = resolveHmacKey(secret);
	const expected = createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');

	try {
		return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
	} catch {
		return false;
	}
}

export const POST: RequestHandler = async ({ request }) => {
	const webhookSecret = env.ELEVENLABS_WEBHOOK_SECRET;
	if (!webhookSecret) {
		return json({ ok: false, error: 'Webhook not configured' }, { status: 500 });
	}

	const rawBody = await request.text();
	const signature = request.headers.get('ElevenLabs-Signature') ?? '';
	if (!verifySignature(rawBody, signature, webhookSecret)) {
		return json({ ok: false, error: 'Invalid signature' }, { status: 401 });
	}

	let payload: ElevenLabsWebhook;
	try {
		payload = JSON.parse(rawBody) as ElevenLabsWebhook;
	} catch {
		return json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (payload.type !== 'post_call_transcription') {
		return json({ ok: true, skipped: true });
	}

	const { conversation_id, transcript } = payload.data;
	const rawProject = payload.data.conversation_initiation_client_data?.dynamic_variables?.project;
	const project = typeof rawProject === 'string' ? rawProject : undefined;
	const turns: PersistedTurn[] = (transcript ?? [])
		.filter((t) => (t.role === 'agent' || t.role === 'user') && typeof t.message === 'string')
		.map((t) => ({
			role: t.role,
			message: t.message,
			...(typeof t.interrupted === 'boolean' ? { interrupted: t.interrupted } : {}),
		}));

	// Fire-and-forget so the webhook ACK returns within ElevenLabs' timeout.
	// Shares the single pipeline with the app-pull /ingest route (ADR-012).
	if (turns.length > 0) {
		void ingestTranscript({ conversationId: conversation_id, transcript: turns, project, source: 'webhook' });
	}

	return json({ ok: true });
};
