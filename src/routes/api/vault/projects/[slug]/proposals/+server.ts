/** GET /api/vault/projects/:slug/proposals
 *
 *  project-phases ADR-005 S3 — list all AI-drafted proposals under
 *  `projects/<slug>/proposals/`. Feeds the operator review surface on
 *  `/projects/<slug>`.
 *
 *  Returns:
 *
 *    {
 *      open:     Proposal[],
 *      applied:  Proposal[],
 *      rejected: Proposal[],
 *      counts:   { open, applied, rejected, total }
 *    }
 *
 *  Each bucket sorted by `created` DESC (newest first). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

interface Proposal {
	path: string;
	filename: string;
	target_adr: string;
	target_adr_slug: string;
	proposed_section: string;
	title: string;
	rationale_summary: string;
	status: string;
	created: string;
	source_agent: string;
}

function summariseRationale(body: string): string {
	const m = /^##\s*Rationale\s*\n+([\s\S]+?)(?:\n##\s|\n*$)/m.exec(body);
	if (!m) return '';
	return m[1].trim().slice(0, 280);
}

function unwrapWikilink(value: unknown): string {
	if (typeof value !== 'string') return '';
	const m = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(value.trim());
	return m ? m[1] : value;
}

function titleFromBody(body: string): string {
	const m = /^#\s+(.+?)\s*$/m.exec(body);
	if (!m) return '';
	return m[1].replace(/^Proposal\s*—\s*/, '').trim();
}

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const prefix = `projects/${slug}/proposals/`;
	const all = engine
		.getAllNotes()
		.filter((n) => n.path.startsWith(prefix) && n.path.endsWith('.md'));

	const proposals: Proposal[] = [];
	for (const note of all) {
		// Skip the proposals/index.md if one exists (operator-curated).
		if (note.path === `${prefix}index.md`) continue;
		const meta = note.meta ?? {};
		if (meta.type !== 'proposal') continue;
		const filename = note.path.slice(prefix.length);
		const proposal: Proposal = {
			path: note.path,
			filename,
			target_adr: typeof meta.target_adr === 'string' ? meta.target_adr : '',
			target_adr_slug: unwrapWikilink(meta.target_adr),
			proposed_section:
				typeof meta.proposed_section === 'string' ? meta.proposed_section : '',
			title: titleFromBody(note.content ?? '') || filename,
			rationale_summary: summariseRationale(note.content ?? ''),
			status: typeof meta.status === 'string' ? meta.status : 'open',
			created: typeof meta.created === 'string' ? meta.created : '',
			source_agent: typeof meta.source_agent === 'string' ? meta.source_agent : '',
		};
		proposals.push(proposal);
	}

	proposals.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

	const open = proposals.filter((p) => p.status === 'open');
	const applied = proposals.filter((p) => p.status === 'applied');
	const rejected = proposals.filter((p) => p.status === 'rejected');

	return json({
		open,
		applied,
		rejected,
		counts: {
			open: open.length,
			applied: applied.length,
			rejected: rejected.length,
			total: proposals.length,
		},
	});
};
