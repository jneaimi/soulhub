import type { PageServerLoad } from './$types';
import { resolve } from 'node:path';
import { parsePlaybook } from '$lib/playbook/index.js';

const PLAYBOOKS_DIR = resolve(process.cwd(), 'playbooks');

export const load: PageServerLoad = async ({ params }) => {
	const name = decodeURIComponent(params.name);
	const playbookDir = resolve(PLAYBOOKS_DIR, name);
	const yamlPath = resolve(playbookDir, 'playbook.yaml');

	try {
		const spec = await parsePlaybook(yamlPath);
		return {
			inputs: spec.inputs || [],
			phases: spec.phases.map((ph) => ({
				id: ph.id,
				type: ph.type,
				depends_on: ph.depends_on,
				prompt: ph.prompt,
				assignments: ph.assignments?.map((a) => ({
					role: a.role,
					output: a.output,
				})),
			})),
		};
	} catch {
		return { inputs: [], phases: [] };
	}
};
