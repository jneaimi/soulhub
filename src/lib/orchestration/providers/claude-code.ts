import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSession, writeInput, killSession, isAlive } from '$lib/pty/manager.js';
import type { TaskNode } from '../types.js';
import type { OrchestrationProvider, ProviderSession } from './types.js';

export class ClaudeCodeOrchProvider implements OrchestrationProvider {
	readonly id = 'claude-code' as const;
	readonly name = 'Claude Code';

	async available(): Promise<boolean> {
		// Claude Code binary is checked at spawnSession time
		return true;
	}

	async setup(
		worktreePath: string,
		task: TaskNode,
		ownershipMap: Record<string, string>,
		projectPath: string,
	): Promise<void> {
		let projectClaudeMd = '';
		try {
			projectClaudeMd = await readFile(join(projectPath, 'CLAUDE.md'), 'utf-8');
		} catch {
			/* none */
		}

		const ownedFiles = task.fileOwnership.join('\n- ');
		const otherOwned = Object.entries(ownershipMap)
			.filter(([, tid]) => tid !== task.id)
			.map(([file, tid]) => `- ${file} (owned by ${tid})`)
			.join('\n');

		const claudeMd = `# Worker Task: ${task.name}

## Your Assignment
${task.description}

## Files You Own (ONLY edit these)
- ${ownedFiles}

## Files You Must NOT Touch
${otherOwned || '(none)'}

## Rules
- ONLY edit files listed in "Files You Own"
- NEVER modify files listed under "Files You Must NOT Touch"
- You may IMPORT/READ from any file, but only WRITE to files listed under "Files You Own"
- If you need a type or function that doesn't exist, add it to YOUR owned files, not shared files
- NEVER run npm install, pnpm install, or modify package.json — dependencies are pre-installed
- Do NOT run git push, git merge, or git checkout
- Do NOT modify package.json or any lock files
- Do NOT create files outside your ownership scope
- Focus on your task only — do not fix unrelated issues

## Acceptance Criteria
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '(none specified)'}

## Known Risks
${task.risks.map((r) => `- ${r}`).join('\n') || '(none)'}

${projectClaudeMd ? `## Project Rules (from project CLAUDE.md)\n${projectClaudeMd}` : ''}
`;

		await writeFile(join(worktreePath, 'CLAUDE.md'), claudeMd, 'utf-8');
	}

	async spawn(
		worktreePath: string,
		task: TaskNode,
		projectPath?: string,
	): Promise<ProviderSession> {
		// Spawn from project root so Claude Code inherits Keychain auth from prior
		// CLI use in that directory. The worker is told to cd into the worktree
		// as its first action via the prompt prefix below.
		const cwd = projectPath || worktreePath;

		const worktreePrompt = `IMPORTANT: First, change to your working directory by running: cd ${worktreePath}
All your work MUST be done in that directory. Do NOT work in any other directory.

${task.prompt}`;

		// Assign model based on task complexity
		const modelByComplexity: Record<string, string> = {
			small: 'sonnet',
			medium: 'sonnet',
			large: 'opus',
		};
		const model = modelByComplexity[task.estimatedComplexity] || 'sonnet';

		const session = spawnSession({
			prompt: worktreePrompt,
			cwd,
			shell: false,
			model,
			// Isolate from user MCP servers — prevents auth prompts (e.g. Stitch)
			// from blocking the worker on first run.
			extraArgs: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
		});

		return {
			id: session.id,
			emitter: session.emitter,
			interactive: true,
		};
	}

	canReceiveInput(): boolean {
		return true;
	}

	sendInput(sessionId: string, input: string): boolean {
		return writeInput(sessionId, input);
	}

	kill(sessionId: string): void {
		killSession(sessionId);
	}

	isAlive(sessionId: string): boolean {
		return isAlive(sessionId);
	}
}
