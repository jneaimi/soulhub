/** GET /api/vault/decisions/queue — every `status: proposed` ADR across all
 *  vault projects, sorted by created date ascending (oldest first).
 *
 *  Per ADR-037 Phase 2. Read-only. The Decision Queue tab on `/projects` uses
 *  this as its primary data source. Status mutation goes through
 *  `/api/vault/decisions/transition`. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

interface QueueRow {
	path: string;
	title: string;
	project: string;
	status: string;
	created: string | null;
	falsifierDate: string | null;
	falsifierDaysAway: number | null;
	tags: string[];
	blockedBy: string[];
}

function daysBetween(iso: string): number | null {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.round((t - Date.now()) / 86_400_000);
}

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

/** Coerce a YAML date|string value to ISO YYYY-MM-DD. YAML parses
 *  `created: 2026-05-14` as a Date object; we want the string. */
function asIsoDate(raw: unknown): string | null {
	if (typeof raw === 'string') return raw.trim() || null;
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
		return raw.toISOString().slice(0, 10);
	}
	return null;
}

export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	// Pull every decision note. Status filtering happens post-fetch because
	// the SearchQuery interface does not (yet) expose a status filter.
	const decisions = engine.getNotes({ type: 'decision', limit: 500 });

	const rows: QueueRow[] = [];
	for (const r of decisions) {
		// Archive zone is excluded — mirrors the filter on /api/vault/projects.
		// Notes there are reference-only; their `proposed` status is frozen
		// historical state, not an active decision queue item.
		if (r.path.startsWith('archive/')) continue;
		const note = engine.getNote(r.path);
		if (!note) continue;
		const status = String(note.meta.status ?? '').toLowerCase();
		if (status !== 'proposed') continue;

		const falsifier = asIsoDate(note.meta.falsifier_date) ?? asIsoDate(note.meta.falsifierDate);
		const created = asIsoDate(note.meta.created);
		const project = typeof note.meta.project === 'string' ? note.meta.project : '';
		const title = typeof note.meta.title === 'string' && note.meta.title
			? note.meta.title
			: r.title || note.path.split('/').pop()?.replace(/\.md$/, '') || note.path;

		rows.push({
			path: r.path,
			title,
			project,
			status,
			created,
			falsifierDate: falsifier,
			falsifierDaysAway: falsifier ? daysBetween(falsifier) : null,
			tags: asStringArray(note.meta.tags),
			blockedBy: asStringArray(note.meta.blocked_by ?? note.meta.blockedBy),
		});
	}

	// Oldest proposed first — encourages the operator to clear the backlog
	rows.sort((a, b) => {
		if (a.created && b.created) return a.created.localeCompare(b.created);
		if (a.created) return -1;
		if (b.created) return 1;
		return a.path.localeCompare(b.path);
	});

	return json({ decisions: rows, total: rows.length });
};
