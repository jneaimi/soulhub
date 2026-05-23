/** GET /api/vault/projects/:slug/falsifiers
 *
 *  Aggregated falsifier state across BOTH the project-index AND every
 *  decision note in the project. Per project-phases ADR-004 S2 / D2.
 *
 *  Each parsed `Falsifier` carries `source_path` + `source_kind:
 *  'project-index' | 'adr-body'` so callers can group them (the new
 *  two-section UI panel uses this).
 *
 *  Returns:
 *
 *    {
 *      open: Falsifier[],
 *      closed: Falsifier[],
 *      overdue: Falsifier[],         // open + deadline < today
 *      superseded: Falsifier[],
 *      counts: {
 *        project_level: {open, closed, overdue, superseded},
 *        adr_level:     {open, closed, overdue, superseded},
 *      }
 *    }
 *
 *  Each bucket sorted by deadline ASC (nulls last), then source_path ASC
 *  for stable ordering across same-day deadlines. Per-source try/catch
 *  isolation — one bad falsifier section can't break the list (mirrors
 *  parsePhases isolation in the next-actions endpoint).
 *
 *  Cluster-wide endpoint is out of scope per ADR-004 D2 (no vault cluster
 *  index exists yet). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { parseFalsifiers, type Falsifier } from '$lib/vault/falsifier-parser.js';

interface BucketCounts {
	open: number;
	closed: number;
	overdue: number;
	superseded: number;
}

interface FalsifiersResponse {
	project: string;
	generated_at: string;
	open: Falsifier[];
	closed: Falsifier[];
	overdue: Falsifier[];
	superseded: Falsifier[];
	counts: {
		project_level: BucketCounts;
		adr_level: BucketCounts;
		total: BucketCounts;
	};
}

function todayIso(): string {
	const d = new Date();
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function bucketSort(a: Falsifier, b: Falsifier): number {
	const ad = a.deadline ?? '9999-12-31';
	const bd = b.deadline ?? '9999-12-31';
	if (ad !== bd) return ad.localeCompare(bd);
	return a.source_path.localeCompare(b.source_path);
}

function emptyCounts(): BucketCounts {
	return { open: 0, closed: 0, overdue: 0, superseded: 0 };
}

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const notes = engine
		.getNotes({ project: slug, limit: 500 })
		.filter((n) => !n.path.startsWith('archive/'));

	const today = todayIso();
	const all: Falsifier[] = [];

	for (const note of notes) {
		const full = engine.getNote(note.path);
		if (!full) continue;

		const isProjectIndex = note.path === `projects/${slug}/index.md`;
		const isAdr = full.meta.type === 'decision';
		if (!isProjectIndex && !isAdr) continue;

		try {
			const { falsifiers } = parseFalsifiers({
				sourcePath: note.path,
				body: full.content,
				meta: full.meta,
				sourceKind: isProjectIndex ? 'project-index' : 'adr-body',
			});
			all.push(...falsifiers);
		} catch {
			// per-source isolation — skip on parse failure (mirrors per-ADR
			// try/catch in the rollup + next-actions endpoints)
		}
	}

	const open: Falsifier[] = [];
	const closed: Falsifier[] = [];
	const overdue: Falsifier[] = [];
	const superseded: Falsifier[] = [];

	for (const f of all) {
		if (f.status === 'open') {
			if (f.deadline && f.deadline < today) overdue.push(f);
			else open.push(f);
		} else if (f.status === 'closed') {
			closed.push(f);
		} else if (f.status === 'superseded' || f.status === 'rejected') {
			superseded.push(f);
		}
	}

	open.sort(bucketSort);
	closed.sort(bucketSort);
	overdue.sort(bucketSort);
	superseded.sort(bucketSort);

	const project_level = emptyCounts();
	const adr_level = emptyCounts();
	const total = emptyCounts();

	for (const list of [
		{ items: open, key: 'open' as const },
		{ items: closed, key: 'closed' as const },
		{ items: overdue, key: 'overdue' as const },
		{ items: superseded, key: 'superseded' as const },
	]) {
		for (const f of list.items) {
			total[list.key] += 1;
			if (f.source_kind === 'project-index') project_level[list.key] += 1;
			else adr_level[list.key] += 1;
		}
	}

	const body: FalsifiersResponse = {
		project: slug,
		generated_at: new Date().toISOString(),
		open,
		closed,
		overdue,
		superseded,
		counts: { project_level, adr_level, total },
	};

	return json(body);
};
