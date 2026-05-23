/** GET /api/orchestration/models — ADR-036 Phase 1 read-only consolidated
 *  view of every LLM-selection surface in the system.
 *
 *  Returns four sections:
 *    - branches   — orchestrator-v2 BRANCHES with cost + assignment state
 *    - routes     — settings.json routes.* (primary + failover per intent)
 *    - agents     — ~/.claude/agents/*.md frontmatter `model:` discovery
 *    - codeManaged — hardcoded model defaults from config.schema.ts,
 *                    flagged as edit-via-code-only.
 *
 *  Surfaces only — no write paths. Phase 2 adds edit. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import {
	BRANCHES,
	getBranchAssignmentCounts,
} from '$lib/orchestrator-v2/branches.js';
import {
	getBranchCostStats,
	isBranchOverBudget,
	BRANCH_COST_CAP_USD,
	BRANCH_WINDOW_DAYS,
} from '$lib/orchestrator-v2/branch-costs.js';
import { config } from '$lib/config.js';

interface BranchRow {
	name: string;
	model: string;
	assignments: number;
	costUsd14d: number;
	turns14d: number;
	overBudget: boolean;
}

interface RouteRow {
	name: string;
	default: string;
	failover: string[];
	timeoutMs: number;
	retries: number;
	onError: string[];
	description: string | null;
}

interface AgentRow {
	name: string;
	model: string;
	path: string;
}

interface CodeManagedRow {
	label: string;
	value: string;
	path: string;
	note: string;
}

interface ModelsPayload {
	branches: {
		rows: BranchRow[];
		override: string | null;
		costCapUsd: number;
		windowDays: number;
		sourcePath: string;
	};
	routes: {
		rows: RouteRow[];
		sourcePath: string;
	};
	agents: {
		rows: AgentRow[];
		sourceDir: string;
		totalScanned: number;
	};
	codeManaged: {
		rows: CodeManagedRow[];
	};
	generatedAt: string;
}

function collectBranches(): ModelsPayload['branches'] {
	const counts = getBranchAssignmentCounts();
	const stats = new Map(getBranchCostStats().map((s) => [s.branchName, s]));
	const rows: BranchRow[] = BRANCHES.map((b) => {
		const s = stats.get(b.name);
		return {
			name: b.name,
			model: b.model,
			assignments: counts[b.name] ?? 0,
			costUsd14d: s?.costUsd ?? 0,
			turns14d: s?.turns ?? 0,
			overBudget: isBranchOverBudget(b.name),
		};
	});
	const override = process.env.ORCHESTRATOR_V2_BRANCH_OVERRIDE ?? null;
	return {
		rows,
		override,
		costCapUsd: BRANCH_COST_CAP_USD,
		windowDays: BRANCH_WINDOW_DAYS,
		sourcePath: 'src/lib/orchestrator-v2/branches.ts',
	};
}

function collectRoutes(): ModelsPayload['routes'] {
	const routes = (config.routes ?? {}) as Record<string, unknown>;
	const rows: RouteRow[] = Object.entries(routes).map(([name, raw]) => {
		const cfg = (raw ?? {}) as Record<string, unknown>;
		return {
			name,
			default: typeof cfg.default === 'string' ? cfg.default : '',
			failover: Array.isArray(cfg.failover)
				? (cfg.failover.filter((x) => typeof x === 'string') as string[])
				: [],
			timeoutMs: typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 0,
			retries: typeof cfg.retries === 'number' ? cfg.retries : 0,
			onError: Array.isArray(cfg.onError)
				? (cfg.onError.filter((x) => typeof x === 'string') as string[])
				: [],
			description:
				typeof cfg.description === 'string' && cfg.description ? cfg.description : null,
		};
	});
	rows.sort((a, b) => a.name.localeCompare(b.name));
	return {
		rows,
		sourcePath: '~/.soul-hub/settings.json',
	};
}

async function collectAgents(): Promise<ModelsPayload['agents']> {
	const dir = path.join(os.homedir(), '.claude/agents');
	const rows: AgentRow[] = [];
	let totalScanned = 0;
	try {
		const entries = await fs.readdir(dir);
		const mdFiles = entries.filter((f) => f.endsWith('.md'));
		totalScanned = mdFiles.length;
		await Promise.all(
			mdFiles.map(async (file) => {
				const full = path.join(dir, file);
				try {
					const raw = await fs.readFile(full, 'utf-8');
					const parsed = matter(raw);
					const fm = parsed.data as Record<string, unknown>;
					const model = fm.model;
					if (typeof model !== 'string' || !model) return;
					const name = (typeof fm.name === 'string' && fm.name) || file.replace(/\.md$/, '');
					rows.push({ name, model, path: `~/.claude/agents/${file}` });
				} catch {
					// Skip unreadable files silently — they're not the page's concern.
				}
			}),
		);
	} catch {
		// Dir absent → empty list. Surface only what exists.
	}
	rows.sort((a, b) => a.name.localeCompare(b.name));
	return { rows, sourceDir: '~/.claude/agents/', totalScanned };
}

/** ADR-036 § "What does NOT change": hardcoded model defaults in
 *  config.schema.ts (transcribe, image, video-fetch providers). The page
 *  surfaces them as code-managed rows so the operator can see them and
 *  follow the source link to edit. */
function collectCodeManaged(): ModelsPayload['codeManaged'] {
	return {
		rows: [
			{
				label: 'Transcribe — Gemini default',
				value: 'gemini-2.5-flash',
				path: 'src/lib/config.schema.ts',
				note: 'Default transcription provider model — voice-note pipeline',
			},
			{
				label: 'Image gen — default model',
				value: 'gemini-2.5-flash-image',
				path: 'src/lib/config.schema.ts',
				note: '/img route generation backend',
			},
			{
				label: 'YouTube fetch — Gemini analysis',
				value: 'gemini-2.5-flash',
				path: 'src/lib/config.schema.ts',
				note: 'oEmbed + Gemini two-tier per ADR-012',
			},
			{
				label: 'TikTok fetch — Gemini analysis',
				value: 'gemini-2.5-flash',
				path: 'src/lib/config.schema.ts',
				note: 'Per ADR-024',
			},
		],
	};
}

export const GET: RequestHandler = async () => {
	try {
		const branches = collectBranches();
		const routes = collectRoutes();
		const agents = await collectAgents();
		const codeManaged = collectCodeManaged();
		const payload: ModelsPayload = {
			branches,
			routes,
			agents,
			codeManaged,
			generatedAt: new Date().toISOString(),
		};
		return json(payload);
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Failed to collect model surfaces' },
			{ status: 500 },
		);
	}
};
