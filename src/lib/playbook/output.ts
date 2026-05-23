import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { PlaybookOutput, PlaybookOutputItem, PlaybookRun } from './types.js';
import { getVaultEngine } from '../vault/index.js';
import { deriveNoteType } from '../vault/type-mapper.js';

export interface LandingResult {
	type: string;
	target: string;
	status: 'landed' | 'failed' | 'skipped';
	error?: string;
}

/**
 * Route playbook outputs to their declared destinations.
 * Non-blocking — failures are logged but don't break the run.
 */
export async function landOutputs(
	output: PlaybookOutput,
	run: PlaybookRun,
): Promise<LandingResult[]> {
	const results: LandingResult[] = [];

	if (output.type === 'composite' && output.items) {
		for (const item of output.items) {
			const result = await landSingleOutput(item, run);
			results.push(result);
		}
	} else {
		const result = await landSingleOutput(output, run);
		results.push(result);
	}

	return results;
}

async function landSingleOutput(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	try {
		switch (output.type) {
			case 'artifact':
				return await landArtifact(output, run);
			case 'knowledge':
				return await landKnowledge(output, run);
			case 'project':
				return await landProject(output, run);
			case 'media':
				return await landMedia(output, run);
			case 'patch':
				return await landPatch(output, run);
			case 'action':
				return { type: 'action', target: 'n/a', status: 'skipped', error: 'Action outputs not yet implemented' };
			case 'playbook':
				return { type: 'playbook', target: 'n/a', status: 'skipped', error: 'Playbook outputs not yet implemented' };
			default:
				return { type: output.type, target: 'n/a', status: 'skipped', error: `Unknown output type: ${output.type}` };
		}
	} catch (error) {
		return {
			type: output.type,
			target: 'n/a',
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Land artifact: copy output file to playbook's output/ directory
 */
async function landArtifact(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	if (!output.file) {
		return { type: 'artifact', target: 'n/a', status: 'skipped', error: 'No file specified' };
	}

	const sourcePath = findOutputFile(output.file, run.outputDir);
	if (!sourcePath) {
		return { type: 'artifact', target: run.outputDir, status: 'skipped', error: `Output file not found: ${output.file}` };
	}

	const targetDir = join(run.playbookDir, 'output');
	await mkdir(targetDir, { recursive: true });
	const targetPath = join(targetDir, basename(output.file));
	await copyFile(sourcePath, targetPath);

	return { type: 'artifact', target: targetPath, status: 'landed' };
}

/**
 * Land knowledge: copy output to vault zone
 */
async function landKnowledge(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	if (!output.file) {
		return { type: 'knowledge', target: 'n/a', status: 'skipped', error: 'No file specified' };
	}

	const sourcePath = findOutputFile(output.file, run.outputDir);
	if (!sourcePath) {
		return { type: 'knowledge', target: 'n/a', status: 'skipped', error: `Output file not found: ${output.file}` };
	}

	const content = await readFile(sourcePath, 'utf-8');
	const date = new Date().toISOString().slice(0, 10);
	const shortRunId = run.runId.slice(0, 8);
	const zone = output.vault_zone || 'inbox';
	const filename = `${date}-${basename(output.file).replace(/\.[^.]+$/, '')}-${shortRunId}.md`;

	const noteType = deriveNoteType(zone);

	const engine = getVaultEngine();
	console.log(`[vault/knowledge] Engine available: ${!!engine}, file: ${output.file}, zone: ${zone}`);
	if (engine) {
		const result = await engine.createNote({
			zone,
			filename,
			meta: {
				type: noteType,
				created: date,
				tags: ['playbook', run.playbookName],
				project: run.playbookName,
				run_id: run.runId,
			},
			content,
		});

		if ('success' in result && result.success) {
			console.log(`[vault/knowledge] Saved: ${result.path}`);
			return { type: 'knowledge', target: result.path, status: 'landed' };
		} else if ('error' in result) {
			console.log(`[vault/knowledge] Skipped: ${result.error}`);
			return { type: 'knowledge', target: zone, status: 'failed', error: result.error };
		}
	}

	// Fallback: direct filesystem write if vault engine unavailable
	console.warn('[vault/knowledge] Engine not initialized — falling back to direct write');
	const vaultDir = resolve(homedir(), 'vault');
	const targetDir = join(vaultDir, zone);
	await mkdir(targetDir, { recursive: true });
	const targetPath = join(targetDir, filename);

	let finalContent = content;
	if (!content.startsWith('---')) {
		const frontmatter = [
			'---',
			`type: ${noteType}`,
			`created: ${date}`,
			`tags: [playbook, ${run.playbookName}]`,
			`project: ${run.playbookName}`,
			`run_id: ${run.runId}`,
			`source_agent: playbook-engine`,
			'---',
			'',
		].join('\n');
		finalContent = frontmatter + content;
	}

	await writeFile(targetPath, finalContent, 'utf-8');
	return { type: 'knowledge', target: targetPath, status: 'landed' };
}

/**
 * Land project: copy outputs to ~/dev/{target}/ on a branch
 */
async function landProject(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	const target = 'target' in output ? output.target : undefined;
	if (!target) {
		return { type: 'project', target: 'n/a', status: 'skipped', error: 'No target specified' };
	}

	const resolvedTarget = target.startsWith('~/')
		? resolve(homedir(), target.slice(2))
		: target.startsWith('/')
			? target
			: resolve(homedir(), 'dev', target);

	await mkdir(resolvedTarget, { recursive: true });

	const source = 'source' in output && output.source
		? join(run.outputDir, output.source)
		: run.outputDir;

	if (existsSync(source)) {
		await copyDirContents(source, resolvedTarget);
	}

	return { type: 'project', target: resolvedTarget, status: 'landed' };
}

/**
 * Land media: copy to vault media library
 */
async function landMedia(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	if (!output.file) {
		return { type: 'media', target: 'n/a', status: 'skipped', error: 'No file specified' };
	}

	const sourcePath = findOutputFile(output.file, run.outputDir);
	if (!sourcePath) {
		return { type: 'media', target: 'n/a', status: 'skipped', error: `Output file not found: ${output.file}` };
	}

	const vaultDir = resolve(homedir(), 'vault');
	const mediaDir = join(vaultDir, 'media-library');
	await mkdir(mediaDir, { recursive: true });
	const targetPath = join(mediaDir, basename(output.file));
	await copyFile(sourcePath, targetPath);

	return { type: 'media', target: targetPath, status: 'landed' };
}

/**
 * Land patch: placeholder for git branch workflow
 */
async function landPatch(
	output: PlaybookOutput | PlaybookOutputItem,
	run: PlaybookRun,
): Promise<LandingResult> {
	const target = 'target' in output ? output.target : undefined;
	if (!target) {
		return { type: 'patch', target: 'n/a', status: 'skipped', error: 'No target project specified' };
	}

	return { type: 'patch', target, status: 'skipped', error: 'Git branch workflow not yet implemented — files remain in run output directory' };
}

/**
 * Find an output file by name in the run output directory (recursive search)
 */
function findOutputFile(filename: string, outputDir: string): string | null {
	const direct = join(outputDir, filename);
	if (existsSync(direct)) return direct;

	try {
		const entries = readdirSync(outputDir, { withFileTypes: true, recursive: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name === basename(filename)) {
				const parent = entry.parentPath || '';
				return join(parent, entry.name);
			}
		}
	} catch { /* ok */ }

	return null;
}

/**
 * Copy directory contents recursively
 */
async function copyDirContents(src: string, dest: string): Promise<void> {
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await mkdir(destPath, { recursive: true });
			await copyDirContents(srcPath, destPath);
		} else {
			await copyFile(srcPath, destPath);
		}
	}
}
