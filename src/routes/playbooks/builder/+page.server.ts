import type { PageServerLoad } from './$types';
import { resolve, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

const PLAYBOOKS_DIR = resolve(process.cwd(), 'playbooks');

export const load: PageServerLoad = async ({ url }) => {
	const builderDir = resolve(PLAYBOOKS_DIR, '_builder');

	// Scan existing playbooks
	const existingPlaybooks: { name: string; description: string; dir: string; roleCount: number; phaseCount: number }[] = [];
	try {
		const entries = await readdir(PLAYBOOKS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
			try {
				const yaml = await readFile(resolve(PLAYBOOKS_DIR, entry.name, 'playbook.yaml'), 'utf-8');
				const spec = parseYaml(yaml);
				if (spec.type === 'playbook') {
					existingPlaybooks.push({
						name: spec.name || entry.name,
						description: spec.description || '',
						dir: entry.name,
						roleCount: Array.isArray(spec.roles) ? spec.roles.length : 0,
						phaseCount: Array.isArray(spec.phases) ? spec.phases.length : 0,
					});
				}
			} catch { /* skip invalid */ }
		}
	} catch { /* playbooks dir missing */ }

	// Scan builder templates
	const templates: { id: string; name: string; description: string }[] = [];
	const templatesDir = resolve(builderDir, 'templates');
	try {
		const entries = await readdir(templatesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				const yaml = await readFile(resolve(templatesDir, entry.name, 'playbook.yaml'), 'utf-8');
				const spec = parseYaml(yaml);
				templates.push({
					id: entry.name,
					name: spec.name || entry.name,
					description: spec.description || '',
				});
			} catch { /* skip */ }
		}
	} catch { /* templates dir missing */ }

	// URL param context modes
	const playbookParam = url.searchParams.get('playbook');
	const forkParam = url.searchParams.get('fork');
	const chainParam = url.searchParams.get('chain');
	const troubleshootParam = url.searchParams.get('troubleshoot');
	const errorParam = url.searchParams.get('error');

	let playbookYaml: string | null = null;
	let playbookName: string | null = playbookParam;
	let playbookRoles: string[] | null = null;

	// Edit mode
	if (playbookParam) {
		const pbDir = join(PLAYBOOKS_DIR, playbookParam);
		try {
			playbookYaml = await readFile(join(pbDir, 'playbook.yaml'), 'utf-8');
			const rolesDir = join(pbDir, 'roles');
			try {
				const roleFiles = await readdir(rolesDir);
				playbookRoles = roleFiles.filter((f) => f.endsWith('.md'));
			} catch { /* no roles dir */ }
		} catch {
			playbookName = null;
		}
	}

	// Fork mode
	let forkName: string | null = forkParam;
	let forkYaml: string | null = null;
	if (forkParam) {
		try {
			forkYaml = await readFile(join(PLAYBOOKS_DIR, forkParam, 'playbook.yaml'), 'utf-8');
		} catch {
			forkName = null;
		}
	}

	// Chain edit mode
	let chainYaml: string | null = null;
	let chainName: string | null = chainParam;
	if (chainParam) {
		try {
			chainYaml = await readFile(join(PLAYBOOKS_DIR, chainParam, 'playbook-chain.yaml'), 'utf-8');
		} catch {
			chainName = null;
		}
	}

	// Troubleshoot mode
	let troubleshootContext: {
		runId: string;
		error: string;
		playbookName: string;
		playbookYaml: string;
		roleFiles: string[];
	} | null = null;

	if (troubleshootParam && playbookParam) {
		const pbDir = join(PLAYBOOKS_DIR, playbookParam);
		try {
			const yaml = playbookYaml || await readFile(join(pbDir, 'playbook.yaml'), 'utf-8');
			const roles: string[] = [];
			try {
				const rolesDir = join(pbDir, 'roles');
				const roleEntries = await readdir(rolesDir);
				for (const rf of roleEntries.filter((f) => f.endsWith('.md'))) {
					const content = await readFile(join(rolesDir, rf), 'utf-8');
					roles.push(`--- ${rf} ---\n${content}`);
				}
			} catch { /* no roles */ }

			troubleshootContext = {
				runId: troubleshootParam,
				error: errorParam || 'Unknown error',
				playbookName: playbookParam,
				playbookYaml: yaml,
				roleFiles: roles,
			};
		} catch { /* playbook not found */ }
	}

	return {
		cwd: builderDir,
		existingPlaybooks,
		templates,
		playbookYaml,
		playbookName,
		playbookRoles,
		forkName,
		forkYaml,
		chainYaml,
		chainName,
		troubleshootContext,
	};
};
