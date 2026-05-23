/**
 * GET /api/sessions/[id]/claude
 *   Given a Soul Hub PTY session id, find candidate Claude Code JSONLs
 *   (matched by cwd + time window) and return refs + summaries.
 *
 * Read-only. Reads from ~/.claude/projects/<encoded-cwd>/ — never writes.
 * Inherits the same exposure model as the rest of /api/sessions/*.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadMeta } from '$lib/pty/store.js';
import { findClaudeSessionsForPty } from '$lib/sessions/link.js';
import { summarizeFromPath } from '$lib/sessions/summarize.js';
import type { SessionSummary } from '$lib/sessions/types.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const id = params.id;
	if (!id) return json({ error: 'Missing session id' }, { status: 400 });

	const meta = loadMeta(id);
	if (!meta) return json({ error: 'Session not found' }, { status: 404 });

	const refs = await findClaudeSessionsForPty(meta);

	const wantSummaries = url.searchParams.get('summaries') !== 'false';
	const summaries: SessionSummary[] = [];
	if (wantSummaries) {
		for (const ref of refs) {
			try {
				summaries.push(await summarizeFromPath(ref.jsonlPath));
			} catch (e) {
				// Skip a single bad jsonl — don't fail the whole list
				console.error('summarize failed for', ref.jsonlPath, e);
			}
		}
	}

	return json({ ptySessionId: id, ptyCwd: meta.cwd, refs, summaries });
};
