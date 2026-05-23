import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';

import { config } from '$lib/config.js';
import { soulHubUploadsDir } from '$lib/paths.js';

const DEV_DIR = config.resolved.devDir;

function sanitizeFilename(raw: string): string | null {
	// Keep original filename but strip path traversal
	const name = basename(raw).replace(/[^\w.\-]/g, '_');
	if (!name || name.startsWith('.')) return null;
	return name;
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/** POST /api/upload — upload files to a project directory */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const project = formData.get('project') as string;
	const targetPath = formData.get('targetPath') as string;
	const subfolder = (formData.get('subfolder') as string) || '';
	const temp = formData.get('temp') as string;

	let projectDir: string;

	if (targetPath) {
		// Absolute path mode (used by builder) — validate it's under an allowed root
		const resolved = resolve(targetPath);
		if (!resolved.startsWith(DEV_DIR + '/') && !resolved.startsWith(config.resolved.vaultDir + '/')) {
			return json({ error: 'Invalid target path' }, { status: 403 });
		}
		if (!(await dirExists(resolved))) {
			return json({ error: 'Target directory not found' }, { status: 404 });
		}
		projectDir = resolved;
	} else if (project) {
		if (/[/\\.]/.test(project)) {
			return json({ error: 'Invalid project name' }, { status: 400 });
		}
		projectDir = join(DEV_DIR, project);
		if (!(await dirExists(projectDir))) {
			return json({ error: 'Project not found' }, { status: 404 });
		}
	} else if (temp) {
		// Temp mode — no project/cwd context (standalone /terminal page).
		// Write to a date-stamped folder under ~/.soul-hub/uploads/ so Claude
		// can be handed an absolute path to Read.
		const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
		projectDir = soulHubUploadsDir(day);
		await mkdir(projectDir, { recursive: true });
	} else {
		return json({ error: 'Missing project or targetPath' }, { status: 400 });
	}

	// Determine target directory
	let targetDir = projectDir;
	if (subfolder) {
		// Sanitize subfolder — no path traversal
		const cleanSub = subfolder.replace(/\.\./g, '').replace(/^\//, '');
		targetDir = join(projectDir, cleanSub);
		if (!targetDir.startsWith(projectDir + '/') && targetDir !== projectDir) {
			return json({ error: 'Invalid subfolder path' }, { status: 400 });
		}
		await mkdir(targetDir, { recursive: true });
	}

	const files = formData.getAll('files') as File[];
	if (files.length === 0) {
		return json({ error: 'No files provided' }, { status: 400 });
	}

	const results: { name: string; path: string; size: number }[] = [];

	for (const file of files) {
		const safeName = sanitizeFilename(file.name);
		if (!safeName) continue;

		const filePath = join(targetDir, safeName);
		const buffer = Buffer.from(await file.arrayBuffer());
		await writeFile(filePath, buffer);

		results.push({
			name: safeName,
			path: filePath,
			size: buffer.length,
		});
	}

	return json({ uploaded: results });
};
