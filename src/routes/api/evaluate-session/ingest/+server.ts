/** ADR-012 P1 — POST /api/evaluate-session/ingest
 *
 *  The app-pull replacement for the retired post-call webhook. The standalone
 *  app pulls the finished transcript from ElevenLabs (it holds the API key +
 *  conversation_id) and POSTs it here; we run the shared ingestion pipeline
 *  (transcript note → analyst → ADR-004 gates → project routing → preview
 *  state + vault brief). The app then polls /preview for the result, exactly
 *  as it did under the webhook design.
 *
 *  AUTH: soul-hub is publicly reachable and this endpoint triggers an LLM call
 *  + a vault write, so it is gated by a shared bearer secret. When
 *  EVALUATE_INGEST_SECRET is set, callers MUST send
 *  `Authorization: Bearer <secret>`; a missing/wrong token → 401. If the env is
 *  unset the endpoint logs a warning and allows (dev convenience) — set the
 *  secret in production (~/.soul-hub/.env + the app's .env).
 *
 *  Body: { conversation_id: string, transcript: [{role,message}], project?: string }
 *  Returns: { ok, brief?, briefPath?, project } */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ingestTranscript } from '$lib/evaluate-session/ingest-pipeline.js';
import type { PersistedTurn } from '$lib/evaluate-session/index.js';

interface IngestBody {
	conversation_id?: string;
	transcript?: Array<{ role?: string; message?: string; interrupted?: boolean }>;
	project?: string;
}

/** Constant-ish bearer check. Returns true when allowed to proceed. */
function authorized(request: Request): boolean {
	// Read process.env directly (not $env/dynamic/private): platform secrets are
	// merged into process.env at boot by $lib/secrets.js from ~/.soul-hub/.env,
	// which $env/dynamic/private's startup snapshot does not pick up. hooks.server.ts
	// reads SOUL_HUB_SECRET the same way.
	const secret = process.env.EVALUATE_INGEST_SECRET;
	if (!secret) {
		console.warn('[evaluate-session/ingest] EVALUATE_INGEST_SECRET unset — endpoint is UNAUTHENTICATED.');
		return true;
	}
	const auth = request.headers.get('authorization') ?? '';
	return auth === `Bearer ${secret}`;
}

export const POST: RequestHandler = async ({ request }) => {
	if (!authorized(request)) {
		return json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: IngestBody;
	try {
		body = (await request.json()) as IngestBody;
	} catch {
		return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const conversationId = body.conversation_id?.trim();
	if (!conversationId) {
		return json({ ok: false, error: 'Missing `conversation_id`' }, { status: 400 });
	}

	// Normalize the transcript to the role/message pairs the pipeline expects;
	// drop anything that isn't a real agent/user turn with text.
	const transcript: PersistedTurn[] = Array.isArray(body.transcript)
		? body.transcript
				.filter((t): t is { role: string; message: string; interrupted?: boolean } =>
					!!t && (t.role === 'agent' || t.role === 'user') && typeof t.message === 'string' && t.message.trim().length > 0,
				)
				.map((t) => ({
					role: t.role as 'agent' | 'user',
					message: t.message,
					...(typeof t.interrupted === 'boolean' ? { interrupted: t.interrupted } : {}),
				}))
		: [];

	if (transcript.length === 0) {
		return json({ ok: false, error: 'Empty or invalid transcript' }, { status: 400 });
	}

	const result = await ingestTranscript({
		conversationId,
		transcript,
		project: body.project,
		source: 'pull',
	});

	if (!result.ok) {
		return json(result, { status: 502 });
	}
	return json(result);
};
