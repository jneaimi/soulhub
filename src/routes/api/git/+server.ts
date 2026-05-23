import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { config } from '$lib/config.js';
import { dirExists } from '$lib/fs-utils.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5000 });
		return stdout.trim();
	} catch {
		return '';
	}
}

interface GitInfo {
	branch: string | null;
	dirty: boolean;
	uncommittedCount: number;
	recentCommits: { hash: string; message: string; relativeTime: string }[];
}

/** GET /api/git?path=... — git status for a project */
export const GET: RequestHandler = async ({ url }) => {
	const targetPath = url.searchParams.get('path');

	if (!targetPath) {
		return json({ error: 'Missing path parameter' }, { status: 400 });
	}

	const resolved = resolve(targetPath);

	// Security: only allow paths under dev dir
	if (!resolved.startsWith(config.resolved.devDir)) {
		return json({ error: 'Access denied' }, { status: 403 });
	}

	// Check if it's a git repo
	if (!(await dirExists(resolve(resolved, '.git')))) {
		return json({ isGit: false });
	}

	// Run git commands in parallel
	const [branch, statusOutput, logOutput] = await Promise.all([
		git(['branch', '--show-current'], resolved),
		git(['status', '--porcelain'], resolved),
		git(['log', '--oneline', '--format=%h\t%s\t%cr', '-5'], resolved),
	]);

	const uncommittedLines = statusOutput ? statusOutput.split('\n').filter(Boolean) : [];

	const recentCommits = logOutput
		? logOutput.split('\n').filter(Boolean).map((line) => {
				const [hash, message, relativeTime] = line.split('\t');
				return { hash, message, relativeTime };
			})
		: [];

	const info: GitInfo & { isGit: true } = {
		isGit: true,
		branch: branch || null,
		dirty: uncommittedLines.length > 0,
		uncommittedCount: uncommittedLines.length,
		recentCommits,
	};

	return json(info);
};
