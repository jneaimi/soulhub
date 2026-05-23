/** Public entry point for the routes layer. Channels (WhatsApp, future
 *  Telegram chat) and the web vault-chat call this with an intent name +
 *  a chat request; the route registry resolves the chain and the failover
 *  engine executes it. */

import type { ChatRequest } from '../llm/types.js';
import { executeWithFailover } from './failover.js';
import { getRoute } from './registry.js';
import type { DispatchResult } from './types.js';

export async function dispatchRoute(
	routeName: string,
	request: ChatRequest,
): Promise<DispatchResult> {
	const routeConfig = getRoute(routeName);
	const { result, chain, attempts, answeredBy } = await executeWithFailover(routeConfig, request);
	return {
		...result,
		routeName,
		chain,
		attempts,
		answeredBy,
	};
}
