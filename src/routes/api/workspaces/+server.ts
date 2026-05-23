import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { config } from '$lib/config.js';
import { dirExists, fileExists, getLastModified } from '$lib/fs-utils.js';

const DEV_DIR = config.resolved.devDir;

const MARKER = '.soul-hub.json';
const VALID_TYPES = ['web-app', 'api', 'cli', 'library', 'mobile', 'script', 'automation'] as const;
type ProjectType = (typeof VALID_TYPES)[number];

const EXCLUDED = new Set(['soul-hub', 'pipelines', 'node_modules']);

interface SoulHubMeta {
	name: string;
	type: string;
	description: string;
}

interface Project {
	name: string;
	devPath: string | null;
	lastModified: string;
	type: ProjectType | 'unknown';
	hasGit: boolean;
	description: string;
}

interface Suggestion {
	name: string;
	path: string;
	hasGit: boolean;
	hasClaude: boolean;
}

function isExcluded(name: string): boolean {
	return EXCLUDED.has(name) || name.startsWith('.');
}

async function readMarker(dirPath: string): Promise<SoulHubMeta | null> {
	try {
		const raw = await readFile(join(dirPath, MARKER), 'utf-8');
		return JSON.parse(raw) as SoulHubMeta;
	} catch {
		return null;
	}
}

function resolveType(metaType: string | undefined): ProjectType | 'unknown' {
	if (metaType && (VALID_TYPES as readonly string[]).includes(metaType)) {
		return metaType as ProjectType;
	}
	return 'unknown';
}

/** GET /api/workspaces — managed workspaces + suggestions.
 *  Renamed from /api/projects per ADR-037 (workspaces/projects split).
 *  Response key `projects` retained for backward compatibility; the lib
 *  wrapper aliases to `workspaces` on read. */
export const GET: RequestHandler = async () => {
	const projects: Project[] = [];
	const managedNames = new Set<string>();
	const allDevFolders: { name: string; path: string }[] = [];

	// Scan ~/dev/ for managed projects (those with .soul-hub.json)
	if (await dirExists(DEV_DIR)) {
		const entries = await readdir(DEV_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || isExcluded(entry.name)) continue;
			const devPath = join(DEV_DIR, entry.name);
			allDevFolders.push({ name: entry.name, path: devPath });

			const meta = await readMarker(devPath);
			if (!meta) continue;

			managedNames.add(entry.name);
			const hasGit = await dirExists(join(devPath, '.git'));
			const mtime = await getLastModified(devPath);

			const project: Project = {
				name: meta.name || entry.name,
				devPath,
				lastModified: mtime.toISOString(),
				type: resolveType(meta.type),
				hasGit,
				description: meta.description || '',
			};
			projects.push(project);
		}
	}

	projects.sort(
		(a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
	);

	// Build suggestions: unmanaged folders with .git or CLAUDE.md
	const suggestions: Suggestion[] = [];
	for (const folder of allDevFolders) {
		if (managedNames.has(folder.name)) continue;
		const hasGit = await dirExists(join(folder.path, '.git'));
		const hasClaude = await fileExists(join(folder.path, 'CLAUDE.md'));
		if (hasGit || hasClaude) {
			suggestions.push({ name: folder.name, path: folder.path, hasGit, hasClaude });
		}
	}

	return json({ projects, suggestions });
};

/** POST /api/projects — register a folder as managed */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { path: rawPath, type, description } = body as {
		path: string;
		type?: string;
		description?: string;
	};

	if (!rawPath || typeof rawPath !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	const resolved = resolve(rawPath);
	if (!resolved.startsWith(DEV_DIR)) {
		return json({ error: 'path must be under ' + DEV_DIR }, { status: 400 });
	}

	const folderName = basename(resolved);
	if (isExcluded(folderName)) {
		return json({ error: 'this folder cannot be managed' }, { status: 400 });
	}

	if (!(await dirExists(resolved))) {
		return json({ error: 'path is not a directory' }, { status: 400 });
	}

	const metaType =
		type && (VALID_TYPES as readonly string[]).includes(type) ? type : 'web-app';

	const meta: SoulHubMeta = {
		name: folderName,
		type: metaType,
		description: description || '',
	};

	await writeFile(join(resolved, MARKER), JSON.stringify(meta, null, 2) + '\n', 'utf-8');

	const hasGit = await dirExists(join(resolved, '.git'));
	const mtime = await getLastModified(resolved);

	const project: Project = {
		name: meta.name,
		devPath: resolved,
		lastModified: mtime.toISOString(),
		type: resolveType(meta.type),
		hasGit,
		description: meta.description,
	};

	return json(project, { status: 201 });
};

/** DELETE /api/projects — unregister a managed folder */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { path: rawPath } = body as { path: string };

	if (!rawPath || typeof rawPath !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	const resolved = resolve(rawPath);
	if (!resolved.startsWith(DEV_DIR)) {
		return json({ error: 'path must be under ' + DEV_DIR }, { status: 400 });
	}

	const markerPath = join(resolved, MARKER);
	if (!(await fileExists(markerPath))) {
		return json({ error: '.soul-hub.json not found' }, { status: 404 });
	}

	await unlink(markerPath);

	return json({ ok: true });
};
