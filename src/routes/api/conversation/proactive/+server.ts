/** POST /api/conversation/proactive — register a proactive outbound message
 *  in chat_history so the next user reply has a topic anchor.
 *
 *  Per ADR-021. Called from the WhatsApp heartbeat path inside the same
 *  process (which uses `saveProactiveTurn` directly). The endpoint also
 *  exists for any future external proactive sender that can't import TS
 *  — none in-tree today (the prior `scripts/vault-review-reminder.sh`
 *  shell script was retired by ADR-025, which moved user-explicit
 *  reminders onto the heartbeat commitments rail).
 *
 *  CSRF posture: same as `/api/files/*` — `Sec-Fetch-Site: cross-site` is
 *  rejected; same-origin / same-site / no-fetch-site (curl, scripts) is
 *  allowed. The endpoint only writes a single SQLite row, no escalation
 *  surface beyond chat history.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { saveProactiveTurn, type ProactiveSource } from '$lib/vault-chat/history.js';

type Channel = 'whatsapp' | 'telegram';

const VALID_CHANNELS: Channel[] = ['whatsapp', 'telegram'];
const VALID_SOURCES: ProactiveSource[] = ['heartbeat', 'scheduler', 'agent-followup'];

/** Derive the channel-blind conversationKey downstream layers consume.
 *  Mirrors `telegram/dispatch.ts:conversationKeyFor` (always `tg:` prefix
 *  for Telegram) and the WhatsApp inbound side (bare E.164 / group JID). */
function conversationKeyFor(channel: Channel, target: string): string {
	return channel === 'telegram' ? `tg:${target}` : target;
}

export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}

	let body: {
		channel?: string;
		target?: string;
		text?: string;
		source?: string;
	};
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
	}

	const channel = body.channel as Channel;
	if (!VALID_CHANNELS.includes(channel)) {
		return json(
			{ ok: false, error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` },
			{ status: 400 },
		);
	}
	if (typeof body.target !== 'string' || !body.target.trim()) {
		return json({ ok: false, error: 'target required' }, { status: 400 });
	}
	if (typeof body.text !== 'string' || !body.text.trim()) {
		return json({ ok: false, error: 'text required' }, { status: 400 });
	}
	const source = body.source as ProactiveSource;
	if (!VALID_SOURCES.includes(source)) {
		return json(
			{ ok: false, error: `source must be one of: ${VALID_SOURCES.join(', ')}` },
			{ status: 400 },
		);
	}

	const conversationKey = conversationKeyFor(channel, body.target.trim());
	const ts = Date.now();
	saveProactiveTurn(conversationKey, body.text, source, ts);
	return json({ ok: true, conversationKey, ts });
};
