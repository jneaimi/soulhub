/**
 * GET /api/sessions/[id]/claude/[claudeId]
 *   Return the full event timeline for one Claude Code session.
 *
 * The PTY session id is required so the route stays scoped — the linker
 * confirms the requested Claude session belongs to this PTY's window.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadMeta } from '$lib/pty/store.js';
import { findClaudeSessionsForPty } from '$lib/sessions/link.js';
import { parseSession } from '$lib/sessions/parser.js';
import { summarizeSession } from '$lib/sessions/summarize.js';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id;
	const claudeId = params.claudeId;
	if (!id || !claudeId) return json({ error: 'Missing id' }, { status: 400 });
	if (!/^[a-zA-Z0-9_-]+$/.test(claudeId)) {
		return json({ error: 'Invalid claudeId' }, { status: 400 });
	}

	const meta = loadMeta(id);
	if (!meta) return json({ error: 'Session not found' }, { status: 404 });

	const refs = await findClaudeSessionsForPty(meta);
	const ref = refs.find((r) => r.sessionId === claudeId);
	if (!ref) {
		return json({ error: 'Claude session not linked to this PTY' }, { status: 404 });
	}

	try {
		const session = await parseSession(ref.jsonlPath);
		const summary = summarizeSession(session);
		return json({ session, summary });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 500 });
	}
};
