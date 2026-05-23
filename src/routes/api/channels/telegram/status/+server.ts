import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMe, getWebhookInfo } from '$lib/channels/telegram/client.js';
import { readChannelConfig } from '$lib/channels/telegram/adapter.js';
import { getBotIdentity } from '$lib/channels/telegram/connection.js';

/** GET /api/channels/telegram/status — settings UI poll target. */
export const GET: RequestHandler = async () => {
	const cfg = readChannelConfig();
	if (!cfg) {
		return json({ ok: false, error: 'channel config missing' }, { status: 503 });
	}

	// Fetch fresh bot identity + webhook info if a token is set; fall
	// back to cached identity (refreshed at boot) when the live calls
	// fail so the UI always has *something* to render.
	const tokenSet = !!process.env.TELEGRAM_BOT_TOKEN;
	const meCall = tokenSet ? await getMe() : { ok: false as const, error: 'no token' };
	const webhookCall = tokenSet ? await getWebhookInfo() : { ok: false as const, error: 'no token' };
	const cached = getBotIdentity();

	return json({
		ok: true,
		tokenSet,
		bot: meCall.ok ? meCall.result : (cached ?? null),
		webhook: webhookCall.ok ? webhookCall.result : null,
		webhookError: webhookCall.ok ? undefined : webhookCall.error,
		config: {
			enabled: cfg.enabled,
			label: cfg.label,
			webhookConfiguredUrl: cfg.webhook.url ?? null,
			secretTokenSet: !!cfg.webhook.secretToken,
			dmPolicy: cfg.access.dmPolicy,
			allowFrom: cfg.access.allowFrom,
			groupPolicy: cfg.access.groupPolicy,
			groupAllowFrom: cfg.access.groupAllowFrom,
			intentMap: cfg.intentMap,
			parseMode: cfg.delivery.parseMode,
			transcribeVoiceNotes: cfg.delivery.transcribeVoiceNotes,
		},
	});
};
