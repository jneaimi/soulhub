/**
 * Two-store agent registry.
 *
 *   Lane A → `~/.claude/agents/<id>.md` (Claude Code native, frontmatter+body)
 *   Lane B → `~/.soul-hub/data/agents/<id>.yaml` (Soul Hub native, full YAML)
 *
 * The two-store layout is described in ADR-001. This module surfaces a
 * unified, deduplicated list. When the same `id` exists in both lanes, **Lane B
 * wins** (Soul-Hub-managed records take precedence over the global Claude Code
 * mirror) — but the row carries a `health_reason: 'shadowed'` so the UI can
 * surface a chip per the design proposal.
 *
 * Writes are atomic (tmp-file + rename). Backend choice picks the lane:
 * `claude-pty` and `claude-cli-flag` → Lane A, `ai-sdk` → Lane B.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
	readdirSync,
	readFileSync,
	statSync,
	existsSync,
	writeFileSync,
	unlinkSync,
	renameSync,
	mkdirSync,
} from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import matter from 'gray-matter';

import { soulHubDataDir } from '$lib/paths.js';
import {
	type AgentSummary,
	type BackendKind,
	type Lane,
	type AgentDraft,
	laneForBackend,
} from './types.js';

// ─── locations ─────────────────────────────────────────────────────────────

/** Lane A — global Claude Code agents folder. Override via env for tests. */
export function laneADir(): string {
	const override = process.env.SOUL_HUB_LANE_A_DIR;
	if (override) return resolve(override);
	return resolve(homedir(), '.claude', 'agents');
}

/** Lane B — Soul Hub's own agents folder under ~/.soul-hub/data/. */
export function laneBDir(): string {
	return soulHubDataDir('agents');
}

// ─── parsers ───────────────────────────────────────────────────────────────

interface ClaudeMdFrontmatter {
	name?: string;
	description?: string;
	tools?: string | string[];
	model?: string;
	skills?: string[];
	backend?: string;
	provenance?: string;
	chat_dispatchable?: boolean;
	/** ADR-031 — convergence condition for `/goal`. PTY-only effect today. */
	goal_condition?: string;
	/** Orchestrator opt-in — lets this agent spawn sub-agents (drops the
	 *  `Task,Agent` disallow on the claude-pty dispatch). Soul Hub extension. */
	allow_subagents?: boolean;
	/** Soul Hub extension. Claude Code ignores unknown frontmatter keys, so
	 *  this travels safely alongside the agent's main spec. */
	budget?: { max_usd?: number; max_turns?: number; timeout_sec?: number; ceiling_usd?: number; ceiling_turns?: number };
	/** ADR-010 — repo this agent operates on (triggers per-run worktree
	 *  provisioning on dispatch). Soul Hub extension; Claude Code ignores it. */
	repo?: string;
}

/** Parse `~/.claude/agents/<id>.md`. Tools is a comma-separated string per Anthropic's
 *  agent spec; we normalise to an array. The optional `backend` and `provenance`
 *  frontmatter fields are Soul-Hub-specific extensions — Claude Code ignores them. */
function parseLaneA(filePath: string): AgentSummary | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	} catch (err) {
		console.warn(`[agents] failed to read ${filePath}:`, (err as Error).message);
		return null;
	}

	let parsed: ReturnType<typeof matter>;
	try {
		parsed = matter(raw);
	} catch (err) {
		console.warn(`[agents] failed to parse frontmatter in ${filePath}:`, (err as Error).message);
		return null;
	}

	const fm = parsed.data as ClaudeMdFrontmatter;
	const id = filePath.split('/').pop()!.replace(/\.md$/, '');

	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		// Skip files whose stem doesn't match our id rules — a frontmatter parse
		// shouldn't blow up the whole list because of one stray filename.
		return null;
	}

	const tools = normaliseTools(fm.tools);
	const skills = Array.isArray(fm.skills) ? fm.skills.map(String) : [];
	const description = String(fm.description ?? '').trim();
	const name = String(fm.name ?? id).trim();
	const model = fm.model ? String(fm.model) : undefined;
	const backend: BackendKind =
		fm.backend === 'claude-cli-flag'
			? 'claude-cli-flag'
			: fm.backend === 'claude-stream-json'
				? 'claude-stream-json'
				: 'claude-pty';
	const provenance: AgentSummary['provenance'] =
		fm.provenance === 'builtin'
			? 'builtin'
			: fm.provenance === 'user-created'
				? 'user-created'
				: 'external';

	return {
		id,
		name,
		description,
		backend,
		model,
		tools,
		skills,
		provenance,
		lane: 'A' as Lane,
		health: 'ready',
		source_path: filePath,
		system_prompt: parsed.content.trim(),
		chat_dispatchable: fm.chat_dispatchable === true,
		goal_condition: typeof fm.goal_condition === 'string' && fm.goal_condition.trim().length > 0
			? fm.goal_condition.trim()
			: undefined,
		allow_subagents: fm.allow_subagents === true,
		budget: extractBudget(fm.budget),
		repo: typeof fm.repo === 'string' && fm.repo.trim().length > 0 ? fm.repo.trim() : undefined,
	};
}

/** Read a partial budget block from frontmatter or YAML. Type-guarded so a
 *  malformed `budget:` field can't crash the parser. Empty result → undefined
 *  so the runtime falls through to PRODUCTION_DEFAULTS. */
function extractBudget(raw: unknown): AgentSummary['budget'] {
	if (!raw || typeof raw !== 'object') return undefined;
	const o = raw as Record<string, unknown>;
	const out: { max_usd?: number; max_turns?: number; timeout_sec?: number; ceiling_usd?: number; ceiling_turns?: number } = {};
	if (typeof o.max_usd === 'number' && o.max_usd >= 0) out.max_usd = o.max_usd;
	if (typeof o.max_turns === 'number' && o.max_turns > 0 && Number.isInteger(o.max_turns))
		out.max_turns = o.max_turns;
	if (typeof o.timeout_sec === 'number' && o.timeout_sec > 0 && Number.isInteger(o.timeout_sec))
		out.timeout_sec = o.timeout_sec;
	if (typeof o.ceiling_usd === 'number' && o.ceiling_usd >= 0) out.ceiling_usd = o.ceiling_usd;
	if (typeof o.ceiling_turns === 'number' && o.ceiling_turns > 0 && Number.isInteger(o.ceiling_turns))
		out.ceiling_turns = o.ceiling_turns;
	return Object.keys(out).length > 0 ? out : undefined;
}

function normaliseTools(input: unknown): string[] {
	if (!input) return [];
	if (Array.isArray(input)) return input.map(String);
	if (typeof input === 'string') {
		return input
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return [];
}

interface LaneBFile {
	id?: string;
	name?: string;
	description?: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	provenance?: string;
	system_prompt?: string;
	chat_dispatchable?: boolean;
	/** ADR-031 — convergence condition for `/goal`. PTY-only effect today. */
	goal_condition?: string;
	spec?:
		| { backend: 'claude-pty'; [k: string]: unknown }
		| { backend: 'claude-cli-flag' }
		| { backend: 'ai-sdk'; provider: string; model: string };
	[k: string]: unknown;
}

/** Parse `~/.soul-hub/data/agents/<id>.yaml`. */
function parseLaneB(filePath: string): AgentSummary | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	} catch (err) {
		console.warn(`[agents] failed to read ${filePath}:`, (err as Error).message);
		return null;
	}

	let doc: LaneBFile;
	try {
		doc = parseYaml(raw) as LaneBFile;
	} catch (err) {
		console.warn(`[agents] failed to parse YAML in ${filePath}:`, (err as Error).message);
		return null;
	}

	if (!doc || typeof doc !== 'object') return null;

	const id = doc.id ?? filePath.split('/').pop()!.replace(/\.ya?ml$/, '');
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;

	const spec = doc.spec ?? { backend: 'claude-pty' as const };
	const backend = (spec.backend ?? 'claude-pty') as BackendKind;
	const provider =
		spec.backend === 'ai-sdk' ? (spec.provider as AgentSummary['provider']) : undefined;
	const model = spec.backend === 'ai-sdk' ? spec.model : doc.model;

	return {
		id,
		name: String(doc.name ?? id),
		description: String(doc.description ?? ''),
		backend,
		model,
		provider,
		tools: Array.isArray(doc.tools) ? doc.tools.map(String) : [],
		skills: Array.isArray(doc.skills) ? doc.skills.map(String) : [],
		provenance: (doc.provenance === 'builtin' ? 'builtin' : 'user-created') as
			| 'builtin'
			| 'user-created',
		lane: 'B' as Lane,
		health: 'ready', // Phase 2 adds key-presence + skill-existence checks
		source_path: filePath,
		system_prompt: String(doc.system_prompt ?? '').trim(),
		chat_dispatchable: doc.chat_dispatchable === true,
		goal_condition: typeof doc.goal_condition === 'string' && doc.goal_condition.trim().length > 0
			? doc.goal_condition.trim()
			: undefined,
		// Lane B (ai-sdk) agents aren't Claude Code sessions — sub-agent fan-out
		// (a Claude Code Task-tool capability) doesn't apply.
		allow_subagents: false,
		budget: extractBudget((doc as Record<string, unknown>).budget),
	};
}

// ─── unified read ─────────────────────────────────────────────────────────

function listMdFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith('.md'))
		.map((f) => resolve(dir, f))
		.filter((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		});
}

function listYamlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
		.map((f) => resolve(dir, f))
		.filter((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		});
}

export interface AgentListOptions {
	/** Reload from disk (no in-memory caching in Phase 1, but the option is
	 *  reserved so callers can opt-in to caching when Phase 2 lands a watcher). */
	fresh?: boolean;
}

export interface AgentListResult {
	agents: AgentSummary[];
	laneADir: string;
	laneBDir: string;
	errors: { path: string; message: string }[];
}

/**
 * List every readable agent across both lanes.
 *
 * - Lane B wins on id collision; the Lane A row is dropped from the result and
 *   the surviving Lane B row gets `health: 'unhealthy'` + `health_reason:
 *   'shadowed'` so the UI can surface a warning chip.
 * - Sorted alphabetically by id for deterministic ordering.
 */
export function listAgents(_opts: AgentListOptions = {}): AgentListResult {
	const errors: AgentListResult['errors'] = [];
	const aDir = laneADir();
	const bDir = laneBDir();

	const laneA: AgentSummary[] = [];
	for (const path of listMdFiles(aDir)) {
		try {
			const agent = parseLaneA(path);
			if (agent) laneA.push(agent);
		} catch (err) {
			errors.push({ path, message: (err as Error).message });
		}
	}

	const laneB: AgentSummary[] = [];
	for (const path of listYamlFiles(bDir)) {
		try {
			const agent = parseLaneB(path);
			if (agent) laneB.push(agent);
		} catch (err) {
			errors.push({ path, message: (err as Error).message });
		}
	}

	const byId = new Map<string, AgentSummary>();
	for (const a of laneA) byId.set(a.id, a);

	for (const b of laneB) {
		if (byId.has(b.id)) {
			byId.set(b.id, {
				...b,
				health: 'unhealthy',
				health_reason: 'shadowed: id also exists in Lane A — Soul Hub uses Lane B',
			});
		} else {
			byId.set(b.id, b);
		}
	}

	const agents = Array.from(byId.values()).sort((x, y) => x.id.localeCompare(y.id));
	return { agents, laneADir: aDir, laneBDir: bDir, errors };
}

/** Look up a single agent by id. Returns null if not found. */
export function getAgent(id: string): AgentSummary | null {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;
	const result = listAgents();
	return result.agents.find((a) => a.id === id) ?? null;
}

// ─── serializers ───────────────────────────────────────────────────────────

/** Write an agent into the lane its backend dictates. Atomic: writes to a
 *  tmp file then renames, so a crashed write never leaves a half-parsed file
 *  on disk. Returns the absolute path that was written. */
export function writeAgent(draft: AgentDraft): string {
	const lane = laneForBackend(draft.spec.backend);
	if (lane === 'A') {
		return writeLaneA(draft);
	}
	return writeLaneB(draft);
}

function writeLaneA(draft: AgentDraft): string {
	const dir = laneADir();
	mkdirSync(dir, { recursive: true });

	// Claude Code's own format: tools is a comma-separated string in
	// frontmatter, body is the system prompt. We add Soul-Hub-specific
	// extensions (`backend`, `provenance`) that Claude Code ignores.
	const fm: Record<string, unknown> = {
		name: draft.name || draft.id,
		description: draft.description || undefined,
		tools: draft.tools.length > 0 ? draft.tools.join(', ') : undefined,
		model: draft.model || undefined,
		skills: draft.skills.length > 0 ? draft.skills : undefined,
		backend: draft.spec.backend, // Soul Hub extension
		provenance: draft.provenance,
		chat_dispatchable: draft.chat_dispatchable === true ? true : undefined,
		allow_subagents: draft.allow_subagents === true ? true : undefined,
		goal_condition: draft.goal_condition && draft.goal_condition.trim().length > 0
			? draft.goal_condition.trim()
			: undefined,
		// Soul Hub extension — Claude Code ignores unknown frontmatter keys.
		// Persist the budget block so per-agent timeout/turn overrides survive
		// a save round-trip from the wizard.
		budget: draft.budget,
	};

	// Strip undefined values so the YAML stays clean
	for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];

	const yaml = stringifyYaml(fm).trimEnd();
	const body = (draft.system_prompt ?? '').replace(/\s+$/, '');
	const out = `---\n${yaml}\n---\n\n${body}\n`;

	const target = resolve(dir, `${draft.id}.md`);
	atomicWrite(target, out);
	return target;
}

function writeLaneB(draft: AgentDraft): string {
	const dir = laneBDir();
	mkdirSync(dir, { recursive: true });

	const doc = {
		id: draft.id,
		name: draft.name || draft.id,
		description: draft.description,
		tools: draft.tools,
		skills: draft.skills,
		budget: draft.budget,
		provenance: draft.provenance,
		chat_dispatchable: draft.chat_dispatchable === true,
		allow_subagents: draft.allow_subagents === true,
		goal_condition: draft.goal_condition && draft.goal_condition.trim().length > 0
			? draft.goal_condition.trim()
			: undefined,
		spec: draft.spec,
		system_prompt: draft.system_prompt,
	};

	const target = resolve(dir, `${draft.id}.yaml`);
	atomicWrite(target, stringifyYaml(doc));
	return target;
}

/** Delete an agent by id. Removes the file from whichever lane currently owns
 *  it. Returns true if a file was removed, false if neither lane had the id. */
export function deleteAgent(id: string): boolean {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw new Error(`invalid agent id: ${id}`);
	}
	const a = resolve(laneADir(), `${id}.md`);
	const bYaml = resolve(laneBDir(), `${id}.yaml`);
	const bYml = resolve(laneBDir(), `${id}.yml`);
	let removed = false;
	for (const p of [a, bYaml, bYml]) {
		if (existsSync(p)) {
			try {
				unlinkSync(p);
				removed = true;
			} catch (err) {
				console.warn(`[agents] failed to delete ${p}:`, (err as Error).message);
			}
		}
	}
	return removed;
}

function atomicWrite(target: string, content: string): void {
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, 'utf8');
	renameSync(tmp, target);
}

// ─── change notifications ──────────────────────────────────────────────────

/** Bumped by the watcher (or by writeAgent/deleteAgent for instant feedback)
 *  so consumers can detect a change without diffing the full list. The API
 *  surfaces this as `version`; the page can poll cheaply. */
let storeVersion = 0;
export function getStoreVersion(): number {
	return storeVersion;
}
export function bumpStoreVersion(): void {
	storeVersion += 1;
}
