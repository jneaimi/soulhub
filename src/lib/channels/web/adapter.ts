/** Web channel adapter — ADR-003.
 *
 *  The web channel requires no external credentials: it is the Soul Hub web
 *  UI itself. It is always considered "configured" and registers in the
 *  channel registry so the settings page can list it as a first-class channel.
 *
 *  Actual turns do NOT flow through this adapter's `send()` — they are
 *  handled by the dedicated SSE endpoint `POST /api/chat/web`. The `send()`
 *  stub exists only to satisfy the `ChannelAdapter` interface contract;
 *  calling it returns a descriptive no-op error. */

import type { ChannelAdapter, ChannelMeta, SendResult } from '../types.js';

export const meta: ChannelMeta = {
	id: 'web',
	name: 'Web UI',
	icon: 'monitor',
	/** No external credentials — the web UI is local, same-origin. */
	fields: [],
	/** `prompt` (two-way conversation) is supported via POST /api/chat/web.
	 *  `send` / `listen` (outbound notification / persistent listener) are not
	 *  applicable to a browser session. */
	actions: ['prompt'],
};

/** Web channel is always configured — no tokens to provision. */
export function isConfigured(): boolean {
	return true;
}

/** Not supported: use POST /api/chat/web with SSE streaming instead. */
export async function send(_message: string, _attachPath?: string): Promise<SendResult> {
	return {
		ok: false,
		error:
			'Web channel does not support direct send. Use POST /api/chat/web for interactive turns.',
	};
}

export const adapter: ChannelAdapter = {
	meta,
	send,
	isConfigured,
};
