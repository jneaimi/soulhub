import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runEvaluateTurn } from '$lib/evaluate-session/index.js';

/** POST /api/evaluate-session — one conversational turn of the AI-led
 *  Evaluate session. Driven by the thin standalone app
 *  (`~/dev/evaluate-session-app`) server-side; never exposed to the SME's
 *  browser directly. Body: { message, sessionKey }. Returns
 *  { ok, text, done, briefPath? }. On completion the brief is written into
 *  the project (zone hardcoded server-side — see lib). */
export const POST: RequestHandler = async ({ request }) => {
	let body: { message?: string; sessionKey?: string };
	try {
		body = (await request.json()) as { message?: string; sessionKey?: string };
	} catch {
		return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const message = body.message?.trim();
	const sessionKey = body.sessionKey?.trim();
	if (!message) return json({ ok: false, error: 'Missing `message`' }, { status: 400 });
	if (!sessionKey) return json({ ok: false, error: 'Missing `sessionKey`' }, { status: 400 });

	const result = await runEvaluateTurn(sessionKey, message);
	const status = result.ok ? 200 : result.error?.includes('not found') ? 404 : 500;
	return json(result, { status });
};
