import { getVaultEngine } from './index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { PhaseResult } from '$lib/playbook/types.js';

interface PlaybookRunSummaryContext {
	playbookName: string;
	runId: string;
	status: 'completed' | 'failed';
	startedAt: string;
	completedAt: string;
	phases: PhaseResult[];
	resolvedInputs: Record<string, string | number>;
	outputDir: string;
	landingResults?: Array<{ type: string; target: string; status: string; error?: string }>;
}

/**
 * Save a playbook run summary as a vault note.
 * Called when a playbook completes (success or failure).
 * Non-blocking — failures are logged but don't affect the playbook.
 */
export async function savePlaybookRunSummary(ctx: PlaybookRunSummaryContext): Promise<void> {
	try {
		const zone = `projects/${ctx.playbookName}/outputs`;
		const date = ctx.startedAt.slice(0, 10);
		const shortId = ctx.runId.slice(0, 8);
		const filename = `${date}-playbook-run-${shortId}.md`;

		const startMs = new Date(ctx.startedAt).getTime();
		const endMs = new Date(ctx.completedAt).getTime();
		const durationSec = Math.floor((endMs - startMs) / 1000);
		const durationStr = durationSec < 60 ? `${durationSec}s` :
			`${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

		// Count phase statuses
		const phaseCounts = { completed: 0, failed: 0, skipped: 0, other: 0 };
		for (const phase of ctx.phases) {
			if (phase.status === 'completed') phaseCounts.completed++;
			else if (phase.status === 'failed') phaseCounts.failed++;
			else if (phase.status === 'skipped') phaseCounts.skipped++;
			else phaseCounts.other++;
		}

		let content = `# Playbook Run: ${ctx.playbookName}\n\nPart of [[projects/${ctx.playbookName}/index|${ctx.playbookName}]]\n\n`;
		content += `## Summary\n\n`;
		content += `- **Status**: ${ctx.status === 'completed' ? 'Completed' : 'Failed'}\n`;
		content += `- **Run ID**: \`${ctx.runId}\`\n`;
		content += `- **Duration**: ${durationStr}\n`;
		content += `- **Phases**: ${phaseCounts.completed} completed, ${phaseCounts.failed} failed, ${phaseCounts.skipped} skipped\n`;
		content += `- **Date**: ${date}\n\n`;

		// Inputs
		if (Object.keys(ctx.resolvedInputs).length > 0) {
			content += `## Inputs\n\n`;
			for (const [key, value] of Object.entries(ctx.resolvedInputs)) {
				content += `- **${key}**: ${value}\n`;
			}
			content += `\n`;
		}

		// Phases table
		content += `## Phases\n\n`;
		content += `| Phase | Type | Status | Assignments | Iterations |\n`;
		content += `|-------|------|--------|-------------|------------|\n`;
		for (const phase of ctx.phases) {
			const assignCount = phase.assignments.length;
			const completedAssigns = phase.assignments.filter(a => a.status === 'completed').length;
			const iter = phase.iterations ? `${phase.iterations}` : '-';
			content += `| ${phase.id} | ${phase.type} | ${phase.status} | ${completedAssigns}/${assignCount} | ${iter} |\n`;
		}
		content += `\n`;

		// Roles used
		const rolesUsed = new Map<string, { provider: string; count: number }>();
		for (const phase of ctx.phases) {
			for (const assign of phase.assignments) {
				const existing = rolesUsed.get(assign.role);
				if (existing) {
					existing.count++;
				} else {
					rolesUsed.set(assign.role, { provider: assign.provider, count: 1 });
				}
			}
		}

		if (rolesUsed.size > 0) {
			content += `## Roles\n\n`;
			content += `| Role | Provider | Assignments |\n`;
			content += `|------|----------|-------------|\n`;
			for (const [role, info] of rolesUsed) {
				content += `| ${role} | ${info.provider} | ${info.count} |\n`;
			}
			content += `\n`;
		}

		// Output landing results
		if (ctx.landingResults && ctx.landingResults.length > 0) {
			content += `## Outputs\n\n`;
			for (const result of ctx.landingResults) {
				const icon = result.status === 'landed' ? 'Landed' : result.status === 'failed' ? 'FAILED' : 'Skipped';
				content += `- **${result.type}**: ${icon}`;
				if (result.target && result.target !== 'n/a') {
					content += ` → \`${result.target}\``;
				}
				if (result.error) {
					content += ` (${result.error})`;
				}
				content += `\n`;
			}
			content += `\n`;
		}

		// Errors
		const failedPhases = ctx.phases.filter(p => p.error);
		if (failedPhases.length > 0) {
			content += `## Errors\n\n`;
			for (const phase of failedPhases) {
				content += `### ${phase.id}\n\n`;
				content += `\`\`\`\n${phase.error}\n\`\`\`\n\n`;
			}
		}

		const tags = ['playbook', 'run-summary', ctx.playbookName];
		if (ctx.status === 'failed') tags.push('failed');

		const engine = getVaultEngine();
		if (engine) {
			const result = await engine.createNote({
				zone,
				filename,
				meta: {
					type: 'output',
					created: date,
					tags,
					project: ctx.playbookName,
					playbook: ctx.playbookName,
					run_id: ctx.runId,
					status: ctx.status,
					duration_sec: durationSec,
				},
				content,
			});

			if (result.success) {
				console.log(`[vault/playbook] Run summary saved: ${result.path}`);
			} else {
				console.log(`[vault/playbook] Run summary skipped: ${result.error}`);
			}
		} else {
			console.warn('[vault/playbook] Engine not initialized — falling back to direct write');
			const vaultDir = resolve(homedir(), 'vault');
			const targetDir = join(vaultDir, zone);
			await mkdir(targetDir, { recursive: true });
			const targetPath = join(targetDir, filename);

			const frontmatter = [
				'---',
				'type: output',
				`created: ${date}`,
				`tags: [${tags.join(', ')}]`,
				`project: ${ctx.playbookName}`,
				`run_id: ${ctx.runId}`,
				`status: ${ctx.status}`,
				`source_agent: playbook-engine`,
				'---',
				'',
			].join('\n');

			await writeFile(targetPath, frontmatter + content, 'utf-8');
			console.log(`[vault/playbook] Run summary saved (direct): ${targetPath}`);
		}
	} catch (err) {
		console.error(`[vault/playbook] Run summary failed:`, err instanceof Error ? err.message : err);
	}
}
