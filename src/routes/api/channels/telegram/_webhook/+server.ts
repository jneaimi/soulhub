import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { handleWebhook } from '$lib/channels/telegram/index.js';
import { readChannelConfig } from '$lib/channels/telegram/adapter.js';
import type { TgUpdate } from '$lib/channels/telegram/types.js';

/** POST /api/channels/telegram/_webhook — Telegram pushes Updates here.
 *
 *  Verifies the optional `X-Telegram-Bot-Api-Secret-Token` header before
 *  any work; an invalid token gets 401 with no body to deny attackers a
 *  signal. Returns `{ ok: true }` synchronously and dispatches inbound
 *  work in the background — Telegram expects a fast response and we
 *  don't want vault-chat latency to feed back into webhook reliability. */
export const POST: RequestHandler = async ({ request }) => {
	const cfg = readChannelConfig();
	if (!cfg) {
		return json({ ok: false, error: 'channel config missing' }, { status: 503 });
	}

	const headerSecret = request.headers.get('x-telegram-bot-api-secret-token');

	let update: TgUpdate;
	try {
		update = (await request.json()) as TgUpdate;
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const result = await handleWebhook(update, headerSecret, cfg);
	if (!result.ok) {
		return json({ ok: false }, { status: result.httpStatus });
	}
	return json({ ok: true }, { status: result.httpStatus });
};
