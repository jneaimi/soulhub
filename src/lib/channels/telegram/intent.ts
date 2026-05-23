/** Intent resolver — turns an inbound message body into a route name.
 *  First token starts with `/` → look it up in `intentMap`. Otherwise →
 *  default route (`vault-chat`). Telegram's slash-commands carry an
 *  optional `@botusername` suffix in groups (e.g. `/save@SoulHubBot`) —
 *  we strip it before lookup so the user gets the same intent regardless
 *  of where they typed the command. */

import type { ResolvedIntent, TelegramIntentMap } from './types.js';

const DEFAULT_ROUTE = 'vault-chat';
const UNKNOWN_ROUTE = 'unknown';

export function resolveIntent(
	body: string,
	intentMap: TelegramIntentMap,
): ResolvedIntent {
	const trimmed = body.trim();
	if (!trimmed) {
		return { route: intentMap.default?.route ?? DEFAULT_ROUTE, body: '' };
	}

	const firstToken = trimmed.split(/\s+/, 1)[0];
	if (firstToken.startsWith('/')) {
		// Strip optional `@botname` suffix Telegram appends in groups so
		// `/save@SoulHubBot` resolves the same as `/save`.
		const atIndex = firstToken.indexOf('@');
		const command = atIndex === -1 ? firstToken : firstToken.slice(0, atIndex);

		const mapping = intentMap[command];
		const rest = trimmed.slice(firstToken.length).trim();
		if (mapping) {
			return { route: mapping.route, body: rest, command };
		}
		return { route: UNKNOWN_ROUTE, body: trimmed, command };
	}

	return { route: intentMap.default?.route ?? DEFAULT_ROUTE, body: trimmed };
}
