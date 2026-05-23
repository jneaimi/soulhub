/** Intent resolver — turns an inbound message body into a route name
 *  that the routes layer will dispatch. First token starts with `/`?
 *  look it up in `intentMap`. Otherwise → `default` route (`vault-chat`). */

import type { ResolvedIntent, WhatsAppIntentMap } from './types.js';

const DEFAULT_ROUTE = 'vault-chat';
const UNKNOWN_ROUTE = 'unknown';

export function resolveIntent(body: string, intentMap: WhatsAppIntentMap): ResolvedIntent {
	const trimmed = body.trim();
	if (!trimmed) {
		return { route: intentMap.default?.route ?? DEFAULT_ROUTE, body: '' };
	}

	const firstToken = trimmed.split(/\s+/, 1)[0];
	if (firstToken.startsWith('/')) {
		const mapping = intentMap[firstToken];
		const rest = trimmed.slice(firstToken.length).trim();
		if (mapping) {
			return { route: mapping.route, body: rest, command: firstToken };
		}
		return { route: UNKNOWN_ROUTE, body: trimmed, command: firstToken };
	}

	return { route: intentMap.default?.route ?? DEFAULT_ROUTE, body: trimmed };
}
