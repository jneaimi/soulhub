import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve } from 'node:path';
import { listPlaybooks, listPlaybookChains } from '$lib/playbook/index.js';
import { providerRegistry } from '$lib/playbook/providers/index.js';

// Playbooks live in the soul-hub project dir, not in ~/dev/
const PLAYBOOKS_DIR = resolve(process.cwd(), 'playbooks');

/** GET /api/playbooks — list all playbooks */
export const GET: RequestHandler = async () => {
	try {
		const [playbooks, chains, providers] = await Promise.all([
			listPlaybooks(PLAYBOOKS_DIR),
			listPlaybookChains(PLAYBOOKS_DIR),
			providerRegistry.detectAvailable(),
		]);
		return json({
			playbooks: playbooks.map(p => ({
				name: p.spec.name,
				description: p.spec.description || '',
				dir: p.dir,
				roles: p.spec.roles.map(r => ({
				id: r.id, provider: r.provider, model: r.model,
				skills: r.skills || [], mcp: r.mcp || [],
			})),
				phases: p.spec.phases.map(ph => ({ id: ph.id, type: ph.type })),
				inputCount: p.spec.inputs?.length || 0,
				outputType: p.spec.output.type,
				prerequisites: p.spec.prerequisites || [],
				hasHooks: !!(p.spec.hooks?.pre_run?.length || p.spec.hooks?.post_run?.length),
				timeoutStrategy: p.spec.timeout_strategy || 'static',
			})),
			chains: chains.map(c => ({
				name: c.spec.name,
				description: c.spec.description || '',
				dir: c.dir,
				nodes: c.spec.nodes.map(n => ({ id: n.id, playbook: n.playbook })),
				inputCount: c.spec.inputs?.length || 0,
			})),
			providers,
		});
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Failed to list playbooks' }, { status: 500 });
	}
};
