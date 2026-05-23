/** POST /api/vault-chat/test — runs the lexical vault-chat orchestrator
 *  end-to-end (selector → tools → format → routes layer). Used to verify
 *  the orchestrator from curl/Settings without needing a paired WhatsApp
 *  channel. Returns the answer plus the trace so the caller can see which
 *  tools fired and how much context was retrieved.
 *
 *  Per ADR-004 (lexical-first vault chat). */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { dispatchVaultChat, isResetCommand, resetConversation } from '$lib/vault-chat/index.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { message?: string; conversationKey?: string };
	try {
		body = (await request.json()) as { message?: string; conversationKey?: string };
	} catch {
		throw error(400, 'Invalid JSON.');
	}

	const message = body.message?.trim();
	if (!message) throw error(400, 'Missing `message`.');
	const conversationKey = body.conversationKey?.trim() || undefined;

	// Mirror the WhatsApp dispatch behaviour: reset commands wipe the
	// per-key history and short-circuit, so debugging from curl matches
	// what a real DM would do.
	if (conversationKey && isResetCommand(message)) {
		const cleared = resetConversation(conversationKey);
		return json({
			ok: true,
			latencyMs: 0,
			text: cleared > 0 ? "Conversation reset. What's on your mind?" : 'Already a fresh slate.',
			reset: { cleared },
		});
	}

	const start = Date.now();
	try {
		const result = await dispatchVaultChat(message, conversationKey);
		return json({
			ok: true,
			latencyMs: Date.now() - start,
			answeredBy: result.answeredBy,
			text: result.text,
			usage: result.usage,
			trace: result.trace,
		});
	} catch (err) {
		return json(
			{
				ok: false,
				latencyMs: Date.now() - start,
				error: err instanceof Error ? err.message : String(err),
			},
			{ status: 502 },
		);
	}
};
