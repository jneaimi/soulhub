import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { inboxDigestTelegramFactory } from '$lib/scheduler/handlers/inbox-digest-telegram.js';

/** POST /api/inbox/digest-telegram — ADR-044 manual trigger.
 *
 *  Fires the Telegram-native inbox digest emitter once. Same handler the
 *  scheduler runs daily; this endpoint lets the operator preview or
 *  re-fire the digest from the command line. Loopback-only (no auth) —
 *  the scheduler task is the production trigger. */
export const POST: RequestHandler = async ({ request }) => {
	const params = await request
		.json()
		.catch(() => ({}));
	try {
		const task = inboxDigestTelegramFactory(params);
		// TaskFn returns `unknown`; this handler's task resolves to a result envelope.
		const result = (await task()) as { ok: boolean };
		const status = result.ok ? 200 : 500;
		return json(result, { status });
	} catch (err) {
		return json(
			{ ok: false, error: (err as Error).message ?? String(err) },
			{ status: 500 },
		);
	}
};
