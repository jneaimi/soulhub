import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { config } from '$lib/config.js';

interface ActivityItem {
	type: 'project_change';
	name: string;
	status: 'done' | 'failed' | 'running';
	timestamp: string;
	detail?: string;
}

interface ProjectInfo {
	name: string;
	type?: string;
	mtime: number;
}

async function getProjects(): Promise<ProjectInfo[]> {
	const devDir = config.resolved.devDir;
	const projects: ProjectInfo[] = [];

	try {
		const entries = await readdir(devDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const metaPath = join(devDir, entry.name, '.soul-hub.json');
			try {
				const metaStat = await stat(metaPath);
				const raw = await readFile(metaPath, 'utf-8');
				const meta = JSON.parse(raw);
				projects.push({
					name: meta.name || entry.name,
					type: meta.type,
					mtime: metaStat.mtimeMs
				});
			} catch {
				// No .soul-hub.json — skip
			}
		}
	} catch {
		// devDir unreadable
	}

	projects.sort((a, b) => b.mtime - a.mtime);
	return projects;
}

export const GET: RequestHandler = async () => {
	const projects = await getProjects();

	const projectSummary = {
		total: projects.length,
		recentNames: projects.slice(0, 3).map((p) => p.name)
	};

	const projectActivity: ActivityItem[] = projects.slice(0, 5).map((p) => ({
		type: 'project_change' as const,
		name: p.name,
		status: 'done' as const,
		timestamp: new Date(p.mtime).toISOString(),
		detail: p.type
	}));

	const recentActivity = [...projectActivity]
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
		.slice(0, 10);

	return json({ recentActivity, projectSummary }, { status: 200 });
};
