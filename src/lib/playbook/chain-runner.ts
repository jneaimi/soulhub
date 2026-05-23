import { resolve } from 'node:path';
import { parsePlaybookChain, getChainExecutionLevels } from './chain-parser.js';
import { runPlaybook } from './engine.js';
import type { PlaybookChainSpec, PlaybookChainRun, PlaybookChainNodeRun, ChainNodeStatus } from './chain-types.js';
import type { PlaybookEventCallback, PlaybookOutputCallback } from './engine.js';
import { getVaultEngine } from '../vault/index.js';

const activeChainRuns = new Map<string, PlaybookChainRun>();
const chainAbortFlags = new Map<string, boolean>();

export function getPlaybookChainRun(runId: string): PlaybookChainRun | undefined {
	return activeChainRuns.get(runId);
}

export function killPlaybookChain(runId: string): boolean {
	if (!activeChainRuns.has(runId)) return false;
	chainAbortFlags.set(runId, true);
	return true;
}

/**
 * Run a playbook chain — executes playbooks as a DAG.
 * Nodes at the same level (no inter-dependencies) run sequentially for Phase 7.
 * (Parallel node execution can be added later.)
 */
export async function runPlaybookChain(
	chainDir: string,
	inputOverrides: Record<string, string | number> = {},
	onEvent?: PlaybookEventCallback,
	onOutput?: PlaybookOutputCallback,
): Promise<PlaybookChainRun> {
	const yamlPath = resolve(chainDir, 'playbook-chain.yaml');
	const spec = await parsePlaybookChain(yamlPath);
	const playbooksDir = resolve(chainDir, '..');

	const runId = crypto.randomUUID().slice(0, 8);

	// Resolve inputs
	const resolvedInputs: Record<string, string | number> = {};
	for (const input of spec.inputs || []) {
		resolvedInputs[input.id] = inputOverrides[input.id] ?? input.default ?? '';
	}

	// Initialize run state
	const run: PlaybookChainRun = {
		runId,
		chainName: spec.name,
		type: 'playbook-chain',
		status: 'running',
		startedAt: new Date().toISOString(),
		nodes: spec.nodes.map(n => ({
			id: n.id,
			playbookName: n.playbook,
			status: 'pending' as ChainNodeStatus,
		})),
		resolvedInputs,
	};

	activeChainRuns.set(runId, run);
	chainAbortFlags.set(runId, false);

	// Track node outputs for input mapping
	const nodeOutputs: Record<string, string> = {};

	try {
		const levels = getChainExecutionLevels(spec);
		const nodeMap = new Map(spec.nodes.map(n => [n.id, n]));

		for (const level of levels) {
			for (const nodeId of level) {
				if (chainAbortFlags.get(runId)) {
					run.status = 'failed';
					break;
				}

				const node = nodeMap.get(nodeId)!;
				const nodeRun = run.nodes.find(n => n.id === nodeId)!;

				nodeRun.status = 'running';
				nodeRun.startedAt = new Date().toISOString();

				// Resolve node inputs: map chain inputs and prior node outputs to playbook inputs
				const playbookInputs: Record<string, string | number> = {};
				if (node.inputs) {
					for (const [key, value] of Object.entries(node.inputs)) {
						if (typeof value === 'string' && value.startsWith('$inputs.')) {
							const inputName = value.slice(8);
							playbookInputs[key] = resolvedInputs[inputName] ?? '';
						} else if (typeof value === 'string' && value.startsWith('$nodes.')) {
							const match = value.match(/^\$nodes\.([\w-]+)\.output$/);
							if (match && nodeOutputs[match[1]]) {
								playbookInputs[key] = nodeOutputs[match[1]];
							}
						} else {
							playbookInputs[key] = value;
						}
					}
				}

				const playbookDir = resolve(playbooksDir, node.playbook);

				try {
					const startMs = Date.now();
					const playbookRun = await runPlaybook(playbookDir, playbookInputs, onEvent, onOutput);

					nodeRun.completedAt = new Date().toISOString();
					nodeRun.durationMs = Date.now() - startMs;
					nodeRun.playbookRun = playbookRun;

					if (playbookRun.status === 'completed') {
						nodeRun.status = 'completed';
						// Store output dir for downstream nodes
						nodeOutputs[nodeId] = playbookRun.outputDir;
					} else {
						nodeRun.status = 'failed';
						nodeRun.error = `Playbook "${node.playbook}" finished with status: ${playbookRun.status}`;
						throw new Error(nodeRun.error);
					}
				} catch (error) {
					if (nodeRun.status !== 'failed') {
						nodeRun.status = 'failed';
						nodeRun.completedAt = new Date().toISOString();
						nodeRun.error = error instanceof Error ? error.message : String(error);
					}

					// Apply failure strategy
					const strategy = spec.on_failure?.strategy || 'halt';
					if (strategy === 'halt') {
						run.status = 'failed';
						break;
					} else if (strategy === 'skip-dependents') {
						// Mark all dependents as skipped
						const dependents = findDependents(nodeId, spec);
						for (const depId of dependents) {
							const depRun = run.nodes.find(n => n.id === depId);
							if (depRun) depRun.status = 'skipped';
						}
					}
					// halt-branch: only halt the branch (skip direct dependents)
				}
			}

			if (run.status === 'failed') break;
		}

		if (run.status !== 'failed') {
			const allDone = run.nodes.every(n => n.status === 'completed' || n.status === 'skipped');
			run.status = allDone ? 'completed' : 'failed';
		}
	} catch (error) {
		run.status = 'failed';
	}

	run.completedAt = new Date().toISOString();
	chainAbortFlags.delete(runId);
	setTimeout(() => activeChainRuns.delete(runId), 10 * 60 * 1000);

	// Save chain run summary to vault (non-blocking)
	try {
		const engine = getVaultEngine();
		if (engine) {
			const date = run.startedAt.slice(0, 10);
			const shortId = runId.slice(0, 8);
			const zone = `projects/${run.chainName}/outputs`;
			const filename = `${date}-chain-run-${shortId}.md`;

			const durationSec = Math.floor(
				(new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
			);
			const durationStr = durationSec < 60 ? `${durationSec}s` :
				`${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

			const nodeCounts = { completed: 0, failed: 0, skipped: 0 };
			for (const node of run.nodes) {
				if (node.status === 'completed') nodeCounts.completed++;
				else if (node.status === 'failed') nodeCounts.failed++;
				else nodeCounts.skipped++;
			}

			let content = `# Chain Run: ${run.chainName}\n\nPart of [[projects/${run.chainName}/index|${run.chainName}]]\n\n`;
			content += `## Summary\n\n`;
			content += `- **Status**: ${run.status === 'completed' ? 'Success' : 'Failed'}\n`;
			content += `- **Run ID**: \`${runId}\`\n`;
			content += `- **Duration**: ${durationStr}\n`;
			content += `- **Nodes**: ${nodeCounts.completed} completed, ${nodeCounts.failed} failed, ${nodeCounts.skipped} skipped\n`;
			content += `- **Date**: ${date}\n\n`;

			content += `## Nodes\n\n`;
			content += `| Node | Playbook | Status | Duration |\n`;
			content += `|------|----------|--------|----------|\n`;
			for (const node of run.nodes) {
				const dur = node.durationMs ? `${(node.durationMs / 1000).toFixed(1)}s` : '-';
				content += `| ${node.id} | ${node.playbookName} | ${node.status} | ${dur} |\n`;
			}

			const tags = ['chain', 'run-summary', run.chainName];
			if (run.status === 'failed') tags.push('failed');

			engine.createNote({
				zone,
				filename,
				meta: {
					type: 'output',
					created: date,
					tags,
					project: run.chainName,
					chain: run.chainName,
					run_id: runId,
					status: run.status,
					duration_sec: durationSec,
				},
				content,
			}).catch(err => console.error('[vault/chain] Playbook chain summary save failed:', err));
		}
	} catch (err) {
		console.error('[vault/chain] Playbook chain summary error:', err);
	}

	return run;
}

/** Find all transitive dependents of a node */
function findDependents(nodeId: string, spec: PlaybookChainSpec): string[] {
	const dependents: string[] = [];
	const queue = [nodeId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const node of spec.nodes) {
			if (node.depends_on?.includes(current) && !dependents.includes(node.id)) {
				dependents.push(node.id);
				queue.push(node.id);
			}
		}
	}

	return dependents;
}
