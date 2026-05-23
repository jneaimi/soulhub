import { parse as parseYaml } from 'yaml';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { PlaybookChainSpec } from './chain-types.js';

/** Parse a playbook chain YAML and validate */
export async function parsePlaybookChain(filePath: string): Promise<PlaybookChainSpec> {
	const raw = await readFile(filePath, 'utf-8');
	const spec = parseYaml(raw) as PlaybookChainSpec;
	const playbooksDir = resolve(dirname(filePath), '..');

	// Validate: name, type === 'playbook-chain', nodes non-empty
	if (!spec.name) throw new Error('Chain missing "name"');
	if (spec.type !== 'playbook-chain') throw new Error('Chain missing "type: playbook-chain"');
	if (!spec.nodes || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
		throw new Error('Chain must have at least one node');
	}

	// Validate nodes: unique IDs, playbook reference exists
	const nodeIds = new Set<string>();
	for (const node of spec.nodes) {
		if (!node.id) throw new Error('Every node must have an "id"');
		if (!node.playbook) throw new Error(`Node "${node.id}" missing "playbook"`);
		if (nodeIds.has(node.id)) throw new Error(`Duplicate node ID "${node.id}"`);
		nodeIds.add(node.id);

		// Verify playbook exists
		const playbookYaml = resolve(playbooksDir, node.playbook, 'playbook.yaml');
		try {
			await access(playbookYaml);
		} catch {
			throw new Error(`Node "${node.id}" references playbook "${node.playbook}" which does not exist`);
		}
	}

	// Validate depends_on references
	for (const node of spec.nodes) {
		for (const dep of node.depends_on || []) {
			if (!nodeIds.has(dep)) {
				throw new Error(`Node "${node.id}" depends on unknown node "${dep}"`);
			}
		}
	}

	// Circular dependency check (DFS)
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const nodeMap = new Map(spec.nodes.map(n => [n.id, n]));

	function checkCycle(id: string): void {
		if (visiting.has(id)) throw new Error(`Circular dependency detected at node "${id}"`);
		if (visited.has(id)) return;
		visiting.add(id);
		const node = nodeMap.get(id)!;
		for (const dep of node.depends_on || []) {
			checkCycle(dep);
		}
		visiting.delete(id);
		visited.add(id);
	}

	for (const node of spec.nodes) {
		checkCycle(node.id);
	}

	return spec;
}

/** Get execution levels — groups of nodes that can run in parallel */
export function getChainExecutionLevels(spec: PlaybookChainSpec): string[][] {
	const levels: string[][] = [];
	const completed = new Set<string>();
	const nodeMap = new Map(spec.nodes.map(n => [n.id, n]));
	const remaining = new Set(spec.nodes.map(n => n.id));

	while (remaining.size > 0) {
		const level: string[] = [];
		for (const id of remaining) {
			const node = nodeMap.get(id)!;
			const deps = node.depends_on || [];
			if (deps.every(d => completed.has(d))) {
				level.push(id);
			}
		}
		if (level.length === 0) throw new Error('Deadlock: remaining nodes have unsatisfied dependencies');
		for (const id of level) {
			remaining.delete(id);
			completed.add(id);
		}
		levels.push(level);
	}

	return levels;
}

/** List playbook chains in a directory */
export async function listPlaybookChains(playbooksDir: string): Promise<{ name: string; dir: string; spec: PlaybookChainSpec }[]> {
	const { readdir, stat } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const results: { name: string; dir: string; spec: PlaybookChainSpec }[] = [];

	let entries: string[];
	try {
		entries = await readdir(playbooksDir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (entry.startsWith('_')) continue;
		const entryPath = join(playbooksDir, entry);
		const entryStat = await stat(entryPath).catch(() => null);
		if (!entryStat?.isDirectory()) continue;

		const chainYaml = join(entryPath, 'playbook-chain.yaml');
		try {
			await access(chainYaml);
			const spec = await parsePlaybookChain(chainYaml);
			results.push({ name: spec.name, dir: entryPath, spec });
		} catch {
			continue;
		}
	}

	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}
