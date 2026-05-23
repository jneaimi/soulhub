import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { setupTelegram } from '$lib/channels/telegram/index.js';
import { readChannelConfig } from '$lib/channels/telegram/adapter.js';

/** POST /api/channels/telegram/setup — registers the webhook with
 *  Telegram and pushes the slash-command menu via setMyCommands.
 *
 *  Idempotent — Telegram returns the same status for repeat calls. The
 *  user invokes this from the Settings UI (or `curl -X POST`) after
 *  setting `channels.telegram.webhook.url` + `secretToken` and
 *  `TELEGRAM_BOT_TOKEN`. Returns the resolved bot identity, webhook
 *  info, and the live command list so the UI can render confirmation. */
export const POST: RequestHandler = async () => {
	const cfg = readChannelConfig();
	if (!cfg) {
		return json({ ok: false, error: 'channel config missing' }, { status: 503 });
	}
	if (!cfg.enabled) {
		return json(
			{ ok: false, error: 'channels.telegram.enabled is false' },
			{ status: 400 },
		);
	}

	const result = await setupTelegram(cfg);
	if (!result.ok) {
		return json({ ok: false, error: result.error }, { status: 502 });
	}
	return json({
		ok: true,
		bot: result.bot,
		webhook: result.webhook,
		commands: result.commands,
		menuButton: result.menuButton,
	});
};
