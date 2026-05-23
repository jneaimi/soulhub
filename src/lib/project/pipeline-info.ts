import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config } from '$lib/config.js';

export interface PipelineInfo {
	name: string;
	description: string;
	inputs: { name: string; type: string; description: string }[];
	outputs: string[];
}

interface RawPipelineYaml {
	name?: string;
	description?: string;
	inputs?: { name: string; type: string; description: string }[];
	steps?: { id: string; output?: string }[];
}

export async function getPipelineInfo(pipelineName: string): Promise<PipelineInfo | null> {
	const pipelinesDir = join(config.resolved.devDir, 'soul-hub', 'pipelines');
	const yamlPath = join(pipelinesDir, pipelineName, 'pipeline.yaml');

	let raw: string;
	try {
		raw = await readFile(yamlPath, 'utf-8');
	} catch {
		return null;
	}

	const spec = parseYaml(raw) as RawPipelineYaml;
	if (!spec || !spec.name) return null;

	const inputs = (spec.inputs ?? []).map((i) => ({
		name: i.name,
		type: i.type,
		description: i.description
	}));

	const outputs = (spec.steps ?? [])
		.map((s) => s.output)
		.filter((o): o is string => !!o && o !== '/dev/null');

	return {
		name: spec.name,
		description: spec.description ?? '',
		inputs,
		outputs
	};
}
