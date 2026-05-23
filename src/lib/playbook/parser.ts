import { parse as parseYaml } from 'yaml';
import { readFile, access, readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { PlaybookSpec, PlaybookPhase, PlaybookRole } from './types.js';

const VALID_PHASE_TYPES = new Set(['sequential', 'parallel', 'handoff', 'human', 'gate', 'consensus']);

/** Parse a playbook YAML file and validate its structure */
export async function parsePlaybook(filePath: string): Promise<PlaybookSpec> {
	const raw = await readFile(filePath, 'utf-8');
	const spec = parseYaml(raw) as PlaybookSpec;
	const playbookDir = dirname(filePath);

	// Validate required fields
	if (!spec || !spec.name) throw new Error('Playbook missing "name"');
	if (spec.type !== 'playbook') throw new Error('Playbook missing "type: playbook"');
	if (!spec.roles || !Array.isArray(spec.roles) || spec.roles.length === 0) {
		throw new Error('Playbook must have at least one role');
	}
	if (!spec.phases || !Array.isArray(spec.phases) || spec.phases.length === 0) {
		throw new Error('Playbook must have at least one phase');
	}
	if (!spec.output) throw new Error('Playbook missing "output"');
	if (!spec.output.type) throw new Error('Playbook output missing "type"');

	// Validate roles
	const roleIds = new Set<string>();
	for (const role of spec.roles) {
		if (!role.id) throw new Error('Every role must have an "id"');
		if (!role.provider) throw new Error(`Role "${role.id}" missing "provider"`);
		if (!role.agent) throw new Error(`Role "${role.id}" missing "agent"`);
		if (roleIds.has(role.id)) throw new Error(`Duplicate role id "${role.id}"`);
		roleIds.add(role.id);

		// Verify agent file exists
		const agentPath = join(playbookDir, role.agent);
		try {
			await access(agentPath);
		} catch {
			throw new Error(`Role "${role.id}": agent file not found at "${agentPath}"`);
		}
	}

	// Validate phases
	const phaseIds = new Set<string>();
	for (const phase of spec.phases) {
		if (!phase.id) throw new Error('Every phase must have an "id"');
		if (!phase.type) throw new Error(`Phase "${phase.id}" missing "type"`);
		if (!VALID_PHASE_TYPES.has(phase.type)) {
			throw new Error(`Phase "${phase.id}": invalid type "${phase.type}"`);
		}
		if (!phase.assignments || !Array.isArray(phase.assignments) || phase.assignments.length === 0) {
			throw new Error(`Phase "${phase.id}" must have at least one assignment`);
		}
		if (phaseIds.has(phase.id)) throw new Error(`Duplicate phase id "${phase.id}"`);
		phaseIds.add(phase.id);

		// Validate assignment role references
		for (const assignment of phase.assignments) {
			if (!assignment.role) throw new Error(`Phase "${phase.id}": assignment missing "role"`);
			if (!roleIds.has(assignment.role)) {
				throw new Error(`Phase "${phase.id}": assignment references unknown role "${assignment.role}"`);
			}
			if (!assignment.task) throw new Error(`Phase "${phase.id}": assignment missing "task"`);
			if (!assignment.output) throw new Error(`Phase "${phase.id}": assignment missing "output"`);
		}

		// Validate depends_on references
		if (phase.depends_on) {
			for (const dep of phase.depends_on) {
				if (!phaseIds.has(dep)) {
					// Check if it exists at all in phases (might be forward reference)
					const allPhaseIds = new Set(spec.phases.map(p => p.id));
					if (!allPhaseIds.has(dep)) {
						throw new Error(`Phase "${phase.id}" depends on unknown phase "${dep}"`);
					}
				}
			}
		}

		// Validate handoff phases
		if (phase.type === 'handoff') {
			if (!phase.loop_until) {
				throw new Error(`Phase "${phase.id}": handoff phase requires "loop_until"`);
			}
			if (phase.max_iterations === undefined) {
				phase.max_iterations = 3;
			}
			if (phase.max_iterations > 10) {
				throw new Error(`Phase "${phase.id}": max_iterations must be <= 10`);
			}
			if (!phase.between || phase.between.length !== 2) {
				throw new Error(`Phase "${phase.id}": handoff phase requires "between" with exactly 2 role IDs`);
			}
			for (const roleId of phase.between) {
				if (!roleIds.has(roleId)) {
					throw new Error(`Phase "${phase.id}": handoff "between" references unknown role "${roleId}"`);
				}
			}
		}

		// Validate human phases
		if (phase.type === 'human') {
			if (!phase.prompt) {
				throw new Error(`Phase "${phase.id}": human phase requires "prompt"`);
			}
		}
	}

	// Check for circular dependencies
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const phaseMap = new Map(spec.phases.map(p => [p.id, p]));

	function checkCycle(id: string): void {
		if (visiting.has(id)) throw new Error(`Circular dependency detected at phase "${id}"`);
		if (visited.has(id)) return;

		visiting.add(id);
		const phase = phaseMap.get(id)!;
		for (const dep of phase.depends_on || []) {
			checkCycle(dep);
		}
		visiting.delete(id);
		visited.add(id);
	}

	for (const phase of spec.phases) {
		checkCycle(phase.id);
	}

	return spec;
}

/** Validate playbook is ready to run — check inputs have values */
export function validatePlaybookRun(
	spec: PlaybookSpec,
	inputs: Record<string, string | number>,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const input of spec.inputs || []) {
		if (input.required === false) continue;
		const val = inputs[input.id] ?? input.default;
		if (val === undefined || val === '' || val === null) {
			errors.push(`Missing required input: ${input.id}${input.description ? ` (${input.description})` : ''}`);
		}
	}

	return { ok: errors.length === 0, errors };
}

/** Resolve variable references: $inputs.X, $phases.X.Y */
export function resolvePlaybookRef(
	value: string,
	inputs: Record<string, string | number>,
	phaseOutputs: Record<string, Record<string, string>>,
): string {
	return value
		.replace(/\$inputs\.([\w-]+)/g, (_, name) => {
			const val = inputs[name];
			if (val === undefined) throw new Error(`Unknown input reference: $inputs.${name}`);
			return String(val);
		})
		.replace(/\$phases\.([\w-]+)\.([\w-]+)/g, (_, phaseId, outputName) => {
			const phase = phaseOutputs[phaseId];
			if (!phase) throw new Error(`Unknown phase reference: $phases.${phaseId}`);
			const val = phase[outputName];
			if (val === undefined) throw new Error(`Unknown output reference: $phases.${phaseId}.${outputName}`);
			return val;
		});
}

/** Get phase execution order respecting depends_on (topological sort) */
export function getPhaseOrder(spec: PlaybookSpec): string[] {
	const order: string[] = [];
	const visited = new Set<string>();
	const phaseMap = new Map(spec.phases.map(p => [p.id, p]));

	function visit(id: string) {
		if (visited.has(id)) return;
		const phase = phaseMap.get(id)!;
		for (const dep of phase.depends_on || []) {
			visit(dep);
		}
		visited.add(id);
		order.push(id);
	}

	for (const phase of spec.phases) {
		visit(phase.id);
	}

	return order;
}

/** List all playbooks in a directory */
export async function listPlaybooks(playbooksDir: string): Promise<{ name: string; dir: string; spec: PlaybookSpec }[]> {
	const results: { name: string; dir: string; spec: PlaybookSpec }[] = [];

	let entries: string[];
	try {
		entries = await readdir(playbooksDir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		// Skip dirs starting with _
		if (entry.startsWith('_')) continue;

		const entryPath = join(playbooksDir, entry);
		const entryStat = await stat(entryPath).catch(() => null);
		if (!entryStat?.isDirectory()) continue;

		const yamlPath = join(entryPath, 'playbook.yaml');
		try {
			await access(yamlPath);
			const spec = await parsePlaybook(yamlPath);
			results.push({ name: spec.name, dir: entryPath, spec });
		} catch {
			// Skip playbooks that fail to parse
			continue;
		}
	}

	results.sort((a, b) => a.name.localeCompare(b.name));
	return results;
}
