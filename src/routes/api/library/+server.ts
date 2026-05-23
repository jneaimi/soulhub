import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { config } from '$lib/config.js';
import { isEnvSet } from '$lib/secrets.js';

const HOME = process.env.HOME || '';
const SKILLS_DIR = resolve(HOME, '.claude', 'skills');
const AGENTS_DIR = resolve(HOME, '.claude', 'agents');
// ADR-002: pipeline + catalog block scanners removed 2026-05-16 (pipeline module
// retired). Naseej component scanner will land with the orchestrator-v2 fold.

export interface LibraryItem {
	name: string;
	type: 'skill' | 'agent' | 'pipeline' | 'mcp' | 'script';
	source: 'yours' | 'catalog';
	description: string;
	category?: string;
	env_vars?: { name: string; description: string; required: boolean; set: boolean }[];
	runtime?: string | null;
	model?: string;
	effort?: string;
	dependsOn?: string[];
	tags?: string[];
	path: string;
	/** MCP-specific fields */
	mcpCommand?: string;
	mcpArgs?: string[];
	mcpUrl?: string;
	mcpType?: 'stdio' | 'http';
	mcpProject?: string;
}

/** Parse SKILL.md frontmatter for description */
async function parseSkillMd(dir: string): Promise<{ description: string }> {
	try {
		const content = await readFile(join(dir, 'SKILL.md'), 'utf-8');
		const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (match) {
			const descMatch = match[1].match(/description:\s*(.+)/);
			return { description: descMatch?.[1]?.trim() || '' };
		}
		// Fallback: first non-empty, non-heading line
		const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
		return { description: lines[0]?.trim().slice(0, 120) || '' };
	} catch {
		return { description: '' };
	}
}

/** Parse agent .md frontmatter */
async function parseAgentMd(filePath: string): Promise<{ description: string; model?: string; effort?: string; skills?: string[] }> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (!match) return { description: '' };
		const fm = match[1];
		const desc = fm.match(/description:\s*(.+)/)?.[1]?.trim() || '';
		const model = fm.match(/model:\s*(.+)/)?.[1]?.trim();
		const effort = fm.match(/effort:\s*(.+)/)?.[1]?.trim();
		const skillsMatch = fm.match(/skills:\s*\[([^\]]*)\]/);
		const skills = skillsMatch ? skillsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : undefined;
		return { description: desc, model, effort, skills };
	} catch {
		return { description: '' };
	}
}

/** Scan user's global skills */
async function scanSkills(): Promise<LibraryItem[]> {
	const items: LibraryItem[] = [];
	try {
		const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const name = entry.name;
			if (name.startsWith('_') || name.startsWith('.')) continue;
			const dir = resolve(SKILLS_DIR, name);
			const { description } = await parseSkillMd(dir);
			items.push({
				name,
				type: 'skill',
				source: 'yours',
				description,
				path: dir,
			});
		}
	} catch { /* dir doesn't exist */ }
	return items;
}

/** Scan user's global agents */
async function scanAgents(): Promise<LibraryItem[]> {
	const items: LibraryItem[] = [];
	try {
		const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.name.endsWith('.md')) continue;
			const name = entry.name.replace('.md', '');
			const filePath = resolve(AGENTS_DIR, entry.name);
			const { description, model, effort } = await parseAgentMd(filePath);
			items.push({
				name,
				type: 'agent',
				source: 'yours',
				description,
				model,
				effort,
				path: filePath,
			});
		}
	} catch { /* dir doesn't exist */ }
	return items;
}

/** MCP server config as found in .mcp.json files */
interface McpServerConfig {
	command?: string;
	args?: string[];
	url?: string;
	type?: 'stdio' | 'http';
	env?: Record<string, string>;
}

/** Scan .mcp.json files from all projects in ~/dev/ */
async function scanMcpServers(): Promise<LibraryItem[]> {
	const items: LibraryItem[] = [];
	const seen = new Set<string>(); // dedup by server name

	try {
		const devDir = config.resolved.devDir;
		const projects = await readdir(devDir, { withFileTypes: true });

		for (const project of projects) {
			if (!project.isDirectory() && !project.isSymbolicLink()) continue;
			if (project.name.startsWith('.') || project.name === 'node_modules') continue;

			const mcpPath = join(devDir, project.name, '.mcp.json');
			try {
				const raw = await readFile(mcpPath, 'utf-8');
				const parsed = JSON.parse(raw);
				const servers: Record<string, McpServerConfig> = parsed.mcpServers || {};

				for (const [serverName, cfg] of Object.entries(servers)) {
					if (seen.has(serverName)) continue;
					seen.add(serverName);

					const envVars = cfg.env
						? Object.keys(cfg.env).map((key) => ({
								name: key,
								description: `Used by ${serverName} MCP server`,
								required: true,
								set: isEnvSet(key),
						  }))
						: undefined;

					const isHttp = !!cfg.url;
					const description = isHttp
						? `Remote MCP server at ${cfg.url}`
						: cfg.command
						? `${cfg.command} ${(cfg.args || []).join(' ')}`
						: 'MCP server';

					items.push({
						name: serverName,
						type: 'mcp',
						source: 'yours',
						description: description.slice(0, 120),
						env_vars: envVars && envVars.length > 0 ? envVars : undefined,
						path: mcpPath,
						mcpCommand: cfg.command,
						mcpArgs: cfg.args,
						mcpUrl: cfg.url,
						mcpType: isHttp ? 'http' : 'stdio',
						mcpProject: project.name,
					});
				}
			} catch {
				// No .mcp.json or invalid — skip
			}
		}
	} catch {
		// devDir doesn't exist
	}

	return items;
}

/** GET /api/library — list all items from My Library + Catalog */
export const GET: RequestHandler = async ({ url }) => {
	const typeFilter = url.searchParams.get('type'); // skill, agent, mcp
	const sourceFilter = url.searchParams.get('source'); // yours, catalog

	const [skills, agents, mcpServers] = await Promise.all([
		scanSkills(),
		scanAgents(),
		scanMcpServers(),
	]);

	let items = [...skills, ...agents, ...mcpServers];

	if (typeFilter) {
		items = items.filter((i) => i.type === typeFilter);
	}
	if (sourceFilter) {
		items = items.filter((i) => i.source === sourceFilter);
	}

	// Sort: yours first, then catalog. Within each: alphabetical
	items.sort((a, b) => {
		if (a.source !== b.source) return a.source === 'yours' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return json(items);
};
