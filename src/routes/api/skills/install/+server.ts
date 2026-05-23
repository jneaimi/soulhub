import type { RequestHandler } from './$types';
import { installSkill } from '$lib/skills/index.js';
import { json } from '@sveltejs/kit';
import type { InstallRequest } from '$lib/skills/index.js';

const SOURCES = new Set(['github', 'anthropic-registry', 'curated']);

export const POST: RequestHandler = async ({ request }) => {
	let body: Partial<InstallRequest>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const source = (body.source ?? 'github') as InstallRequest['source'];
	if (!SOURCES.has(source)) {
		return json({ error: `Unknown source "${source}"` }, { status: 400 });
	}
	if (typeof body.repo !== 'string' || !body.repo.trim()) {
		return json({ error: 'repo is required' }, { status: 400 });
	}

	const req: InstallRequest = {
		source,
		repo: body.repo.trim(),
		subpath: typeof body.subpath === 'string' && body.subpath.trim() ? body.subpath.trim() : undefined,
		name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
		ref: typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined,
	};

	try {
		const result = installSkill(req);
		return json({ ok: true, ...result }, { status: 201 });
	} catch (err) {
		const msg = (err as Error).message;
		const code = msg.includes('already exists') ? 409 : 400;
		return json({ error: msg }, { status: code });
	}
};
