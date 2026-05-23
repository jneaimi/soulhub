/**
 * GET /api/sessions/[id]/claude/[claudeId]/subagents/[agentId]
 *   Return the full event timeline for a sub-agent invoked from the parent Claude session.
 *
 * Sub-agent JSONL path is deterministic:
 *   <encoded-cwd>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { loadMeta } from '$lib/pty/store.js';
import { findClaudeSessionsForPty } from '$lib/sessions/link.js';
import { resolveSubagentPath } from '$lib/sessions/paths.js';
import { parseSession } from '$lib/sessions/parser.js';
import { summarizeSession } from '$lib/sessions/summarize.js';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id;
	const claudeId = params.claudeId;
	const agentId = params.agentId;
	if (!id || !claudeId || !agentId) return json({ error: 'Missing id' }, { status: 400 });
	if (!/^[a-zA-Z0-9_-]+$/.test(claudeId)) {
		return json({ error: 'Invalid claudeId' }, { status: 400 });
	}
	if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
		return json({ error: 'Invalid agentId' }, { status: 400 });
	}

	const meta = loadMeta(id);
	if (!meta) return json({ error: 'Session not found' }, { status: 404 });

	const refs = await findClaudeSessionsForPty(meta);
	const parentRef = refs.find((r) => r.sessionId === claudeId);
	if (!parentRef) {
		return json({ error: 'Claude session not linked to this PTY' }, { status: 404 });
	}

	let subagentPath: string;
	try {
		subagentPath = resolveSubagentPath(parentRef.jsonlPath, agentId);
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 400 });
	}
	if (!existsSync(subagentPath)) {
		return json({ error: 'Sub-agent log not found', path: subagentPath }, { status: 404 });
	}

	try {
		const session = await parseSession(subagentPath);
		const summary = summarizeSession(session);
		return json({ session, summary });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 500 });
	}
};
