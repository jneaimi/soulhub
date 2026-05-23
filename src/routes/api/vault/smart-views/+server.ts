import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '$lib/config.js';

const SMART_VIEWS_PATH = resolve(config.resolved.vaultDir, '.vault', 'smart-views.json');

interface SmartView {
	name: string;
	icon: string;
	filters: { zone?: string; type?: string[]; tags?: string[] };
}

const DEFAULT_VIEWS: SmartView[] = [
	{ name: 'All', icon: 'list', filters: {} },
];

async function loadViews(): Promise<SmartView[]> {
	try {
		const data = await readFile(SMART_VIEWS_PATH, 'utf-8');
		return JSON.parse(data);
	} catch {
		return DEFAULT_VIEWS;
	}
}

async function saveViews(views: SmartView[]): Promise<void> {
	await writeFile(SMART_VIEWS_PATH, JSON.stringify(views, null, 2), 'utf-8');
}

/** GET /api/vault/smart-views — list configured smart views */
export const GET: RequestHandler = async () => {
	const views = await loadViews();
	return json(views);
};

/** PUT /api/vault/smart-views — save all smart views */
export const PUT: RequestHandler = async ({ request }) => {
	let views: SmartView[];
	try {
		views = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!Array.isArray(views)) {
		return json({ error: 'Expected an array of smart views' }, { status: 400 });
	}

	for (const v of views) {
		if (!v.name || typeof v.name !== 'string') {
			return json({ error: 'Each view must have a name' }, { status: 400 });
		}
	}

	await saveViews(views);
	return json({ ok: true, count: views.length });
};
