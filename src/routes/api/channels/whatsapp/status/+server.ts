import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getChannelConfig, getResolvedStatus } from '$lib/channels/whatsapp/index.js';
import { getRouterDecisions } from '$lib/channels/whatsapp/router.js';

/** GET /api/channels/whatsapp/status — poll target for the settings UI.
 *  Returns the live state machine snapshot + a small config preview so
 *  the UI can render allowlist editors without a second request. In
 *  worker mode the status is fetched from the worker process over HTTP;
 *  if the worker is unreachable, `workerError` carries the reason and
 *  status falls back to a synthetic `disconnected`. */
export const GET: RequestHandler = async () => {
	const cfg = getChannelConfig();
	const { status, mode, error } = await getResolvedStatus();
	return json({
		ok: true,
		mode,
		workerError: error,
		status,
		config: cfg
			? {
					enabled: cfg.enabled,
					account: cfg.account,
					dmPolicy: cfg.access.dmPolicy,
					allowFrom: cfg.access.allowFrom,
					intentMap: cfg.intentMap,
					workerEnabled: cfg.worker.enabled,
				}
			: null,
		recentRouterDecisions: getRouterDecisions(),
	});
};
