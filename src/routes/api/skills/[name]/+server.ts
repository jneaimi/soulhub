import type { RequestHandler } from './$types';
import { getSkill, uninstallSkill } from '$lib/skills/index.js';
import { json, error } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.name;
	if (!id) throw error(400, 'name is required');
	const skill = getSkill(id);
	if (!skill) throw error(404, `skill "${id}" not found`);
	return json({ skill });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = params.name;
	if (!id) throw error(400, 'name is required');
	try {
		uninstallSkill(id);
	} catch (err) {
		const msg = (err as Error).message;
		const code = msg.includes('not installed') ? 404 : 400;
		return json({ error: msg }, { status: code });
	}
	return json({ ok: true, id });
};
