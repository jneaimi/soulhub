import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getAgent,
	writeAgent,
	deleteAgent,
	bumpStoreVersion,
} from '$lib/agents/store.js';
import { AgentDraftSchema } from '$lib/agents/types.js';
import { getAgentStats } from '$lib/agents/runs.js';

/** GET /api/agents/[id] — single-agent fetch for the edit form. Includes
 *  lifetime `stats` (production-mode only) for the runs table on the row. */
export const GET: RequestHandler = async ({ params }) => {
	const agent = getAgent(params.id ?? '');
	if (!agent) return json({ error: 'not found' }, { status: 404 });
	const stats = getAgentStats(agent.id);
	return json({ agent: { ...agent, stats } });
};

/** PUT /api/agents/[id] — update. Body must be a valid AgentDraft whose `id`
 *  matches the URL. Backend changes between save calls re-write to the new
 *  lane and clean up the old file. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const id = params.id ?? '';
	const existing = getAgent(id);
	if (!existing) return json({ error: 'not found' }, { status: 404 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const parsed = AgentDraftSchema.safeParse(body);
	if (!parsed.success) {
		return json(
			{ error: 'validation failed', issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	if (parsed.data.id !== id) {
		return json(
			{ error: `id mismatch: URL=${id} body=${parsed.data.id}` },
			{ status: 400 },
		);
	}

	try {
		const path = writeAgent(parsed.data);

		// If the backend swap moved the agent across lanes (PTY→AI-SDK or vice
		// versa), delete the orphan file in the old lane so the registry doesn't
		// surface a duplicate. We compute "did the lane change" by comparing the
		// pre-write source_path's directory to the new path's directory.
		const newDir = path.slice(0, path.lastIndexOf('/'));
		const oldDir = existing.source_path.slice(0, existing.source_path.lastIndexOf('/'));
		if (oldDir !== newDir) {
			// Drop the file in the old lane only — `deleteAgent` removes from both
			// lanes which would also wipe the freshly-written record. Use direct
			// fs.unlink instead.
			try {
				const { unlinkSync, existsSync } = await import('node:fs');
				if (existsSync(existing.source_path)) unlinkSync(existing.source_path);
			} catch (err) {
				console.warn('[agents] failed to clean up old lane file:', (err as Error).message);
			}
		}

		bumpStoreVersion();
		const saved = getAgent(id);
		return json({ agent: saved, path });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** DELETE /api/agents/[id] — remove from whichever lane(s) hold it. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = params.id ?? '';
	const existing = getAgent(id);
	if (!existing) return json({ error: 'not found' }, { status: 404 });

	try {
		const removed = deleteAgent(id);
		bumpStoreVersion();
		return json({ removed, id });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
