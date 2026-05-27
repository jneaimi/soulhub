/** Contract registry — compile / resolve / self-check (soul-hub-governance ADR-002, P2).
 *
 *  Source of truth: the vault note `projects/soul-hub-governance/contract-registry.md`,
 *  whose `contracts:` frontmatter array carries the declarations (governed at the
 *  vault chokepoint, ADR-001 #3). `compile()` projects that to a fast on-disk cache
 *  at `~/.soul-hub/data/contracts/registry.json`; `touching()` answers the
 *  design-time question from the cache (instant, offline); `check()` is the
 *  registry's own falsifier (it is itself a contract that can rot — ADR-001 watch). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { soulHubDataDir } from '../paths.js';
import { getVaultEngine } from '../vault/index.js';
import { getTaskHandler } from '../scheduler/task-types.js';
import { globMatch, toBashGlob } from './glob.js';
import type { CompiledContract, CompiledRegistry, Contract, ContractBuildCheck, RegistryCheck } from './types.js';

/** Vault path of the registry source note. */
export const REGISTRY_NOTE_PATH = 'projects/soul-hub-governance/contract-registry.md';

/** On-disk cache path. */
export function cachePath(): string {
	return resolve(soulHubDataDir('contracts'), 'registry.json');
}

/** soul-hub repo root — `repo:` globs resolve under here. PM2 runs from the
 *  repo; `SOUL_HUB_REPO` overrides for atypical layouts. */
function repoRoot(): string {
	return process.env.SOUL_HUB_REPO ?? process.cwd();
}

/** Vault root — `vault:` globs resolve under here. Prefer the live engine's
 *  resolved dir; fall back to ~/vault when the engine isn't up (CLI/offline). */
function vaultRoot(): string {
	return getVaultEngine()?.vaultDir ?? resolve(homedir(), 'vault');
}

/** Expand a root-prefixed glob to an absolute glob. */
function resolveGlob(glob: string, roots: { vault: string; repo: string }): string {
	if (glob.startsWith('vault:')) return resolve(roots.vault, glob.slice(6));
	if (glob.startsWith('repo:')) return resolve(roots.repo, glob.slice(5));
	if (glob.startsWith('abs:')) return glob.slice(4).replace(/^~/, homedir());
	if (glob.startsWith('~')) return resolve(homedir(), glob.slice(1).replace(/^\/+/, ''));
	return resolve(glob); // already absolute / relative-to-cwd
}

/** Validate + normalize one raw frontmatter entry into a Contract. Throws on
 *  a malformed entry so compile can refuse and keep the last-good cache. */
function parseContract(raw: unknown, idx: number): Contract {
	if (typeof raw !== 'object' || raw === null) throw new Error(`contracts[${idx}] is not an object`);
	const r = raw as Record<string, unknown>;
	const str = (k: string): string => {
		const v = r[k];
		if (typeof v !== 'string' || !v.trim()) throw new Error(`contracts[${idx}].${k} must be a non-empty string`);
		return v.trim();
	};
	const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : [];
	if (files.length === 0) throw new Error(`contracts[${idx}].files must be a non-empty string array`);
	const dependsOn = Array.isArray(r.dependsOn)
		? r.dependsOn.filter((d): d is string => typeof d === 'string')
		: undefined;
	const buildCheck = parseBuildCheck(r.buildCheck, idx);
	return { id: str('id'), area: str('area'), guarantees: str('guarantees'), files, falsifier: str('falsifier'), dependsOn, buildCheck };
}

/** Parse + validate an optional `buildCheck` (ADR-003 P3). Throws on a malformed
 *  one so compile refuses rather than ship a broken gate rule.
 *  Supports `diff-regex` (original) and `file-regex` (ADR-007 addition). */
function parseBuildCheck(raw: unknown, idx: number): ContractBuildCheck | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'object') throw new Error(`contracts[${idx}].buildCheck must be an object`);
	const b = raw as Record<string, unknown>;

	if (b.type === 'diff-regex') {
		if (typeof b.pattern !== 'string' || !b.pattern) throw new Error(`contracts[${idx}].buildCheck.pattern required`);
		if (typeof b.message !== 'string' || !b.message) throw new Error(`contracts[${idx}].buildCheck.message required`);
		const files = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === 'string') : undefined;
		const mustNotMatch = b.mustNotMatch === undefined ? true : Boolean(b.mustNotMatch);
		return { type: 'diff-regex', pattern: b.pattern, message: b.message, files, mustNotMatch };
	}

	if (b.type === 'file-regex') {
		if (typeof b.file !== 'string' || !b.file) throw new Error(`contracts[${idx}].buildCheck.file required for file-regex`);
		if (typeof b.pattern !== 'string' || !b.pattern) throw new Error(`contracts[${idx}].buildCheck.pattern required`);
		if (typeof b.message !== 'string' || !b.message) throw new Error(`contracts[${idx}].buildCheck.message required`);
		const mustNotMatch = b.mustNotMatch === undefined ? true : Boolean(b.mustNotMatch);
		return { type: 'file-regex', file: b.file, pattern: b.pattern, message: b.message, mustNotMatch };
	}

	throw new Error(`contracts[${idx}].buildCheck.type must be 'diff-regex' or 'file-regex'`);
}

/** Read + validate the raw contracts from the vault registry note. Returns the
 *  parsed contracts plus source mtime/hash (for freshness). Returns null when
 *  the engine isn't available (offline CLI path reads the cache instead). */
function readSource(): { contracts: Contract[]; mtime: number; hash: string } | null {
	const engine = getVaultEngine();
	if (!engine) return null;
	const note = engine.getNote(REGISTRY_NOTE_PATH);
	if (!note) throw new Error(`registry note not found: ${REGISTRY_NOTE_PATH}`);
	const rawList = note.meta.contracts;
	if (!Array.isArray(rawList)) throw new Error(`registry note frontmatter has no \`contracts:\` array`);
	const contracts = rawList.map((c, i) => parseContract(c, i));
	const ids = new Set<string>();
	for (const c of contracts) {
		if (ids.has(c.id)) throw new Error(`duplicate contract id: ${c.id}`);
		ids.add(c.id);
	}
	const hash = createHash('sha1').update(JSON.stringify(rawList)).digest('hex');
	return { contracts, mtime: note.mtime, hash };
}

/** Compile the vault registry note to the on-disk cache. Atomic (tmp+rename).
 *  Throws if the source is malformed (last-good cache is left untouched). */
export function compile(): CompiledRegistry {
	const src = readSource();
	if (!src) throw new Error('vault engine unavailable — cannot compile registry');
	const roots = { vault: vaultRoot(), repo: repoRoot() };
	const contracts: CompiledContract[] = src.contracts.map((c) => {
		const globsAbs = c.files.map((g) => resolveGlob(g, roots));
		return { ...c, globsAbs, bashGlobs: globsAbs.map(toBashGlob) };
	});
	const out: CompiledRegistry = {
		compiledAt: new Date().toISOString(),
		sourcePath: REGISTRY_NOTE_PATH,
		sourceMtime: src.mtime,
		sourceHash: src.hash,
		roots,
		contracts,
	};
	const dest = cachePath();
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp`;
	writeFileSync(tmp, JSON.stringify(out, null, 2));
	renameSync(tmp, dest);
	return out;
}

/** Load the compiled cache from disk. Returns null if it doesn't exist yet
 *  (callers fail-open). Never throws on a missing cache. */
export function loadCache(): CompiledRegistry | null {
	const p = cachePath();
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as CompiledRegistry;
	} catch {
		return null;
	}
}

/** Ensure a cache exists, compiling on demand when the engine is up. Returns
 *  the cache, or null if neither cache nor engine is available. */
export function ensureCache(): CompiledRegistry | null {
	const cached = loadCache();
	if (cached) return cached;
	if (getVaultEngine()) {
		try {
			return compile();
		} catch {
			return null;
		}
	}
	return null;
}

/** Cheap staleness check: is the cache older than the vault source note?
 *  Returns false when offline (can't tell — trust the cache). */
export function isStale(reg: CompiledRegistry | null): boolean {
	const engine = getVaultEngine();
	if (!engine) return false;
	const note = engine.getNote(REGISTRY_NOTE_PATH);
	if (!note) return false;
	return !reg || reg.sourceMtime !== note.mtime;
}

/** Cache, recompiled if stale and the engine is up — the server-side read path
 *  (API), which can afford a freshness check. The hook reads the raw cache via
 *  `loadCache()` and tolerates brief staleness (advisory). */
export function freshCache(): CompiledRegistry | null {
	const cached = loadCache();
	if (cached && !isStale(cached)) return cached;
	if (getVaultEngine()) {
		try {
			return compile();
		} catch {
			return cached;
		}
	}
	return cached;
}

/** Which contracts does an absolute path participate in? The design-time
 *  answer, served identically to CLI / hook / orchestrator / agent tools. */
export function touching(absPath: string, reg?: CompiledRegistry | null): CompiledContract[] {
	const r = reg ?? loadCache();
	if (!r) return [];
	return r.contracts.filter((c) => c.globsAbs.some((g) => globMatch(g, absPath)));
}

/** The registry's own falsifier (ADR-001 watch): every contract must resolve
 *  to real files + a real falsifier, deps must point at real contracts, and the
 *  cache must be fresh vs the vault source. */
export function check(): RegistryCheck {
	const cache = loadCache();
	const result: RegistryCheck = {
		ok: false,
		unresolvedFiles: [],
		danglingFalsifiers: [],
		danglingDeps: [],
		cacheStale: false,
		count: cache?.contracts.length ?? 0,
	};

	// Freshness: recompute the source hash and compare to the cache.
	const src = readSource();
	if (src) {
		if (!cache || cache.sourceHash !== src.hash) result.cacheStale = true;
	}
	const reg = cache ?? (src && getVaultEngine() ? compile() : null);
	if (!reg) {
		result.cacheStale = true;
		return result;
	}
	result.count = reg.contracts.length;

	const ids = new Set(reg.contracts.map((c) => c.id));
	for (const c of reg.contracts) {
		// Resolution: each glob must match at least one existing path.
		for (let i = 0; i < c.files.length; i++) {
			const abs = c.globsAbs[i];
			let hit = false;
			try {
				// globSync understands `**`/`*`/`?`; a literal path returns itself if it exists.
				hit = globSync(abs).length > 0 || existsSync(abs);
			} catch {
				hit = existsSync(abs);
			}
			if (!hit) result.unresolvedFiles.push({ id: c.id, glob: c.files[i] });
		}
		// Falsifier: a registered scheduler task id, or a command (contains a space / slash).
		const f = c.falsifier;
		const looksLikeCommand = /[ /]/.test(f);
		if (!looksLikeCommand && !getTaskHandler(f) && !KNOWN_TASK_IDS.has(f)) {
			result.danglingFalsifiers.push({ id: c.id, falsifier: f });
		}
		// Deps: each must name a declared contract.
		for (const d of c.dependsOn ?? []) {
			if (!ids.has(d)) result.danglingDeps.push({ id: c.id, dep: d });
		}
	}

	result.ok =
		!result.cacheStale &&
		result.unresolvedFiles.length === 0 &&
		result.danglingFalsifiers.length === 0 &&
		result.danglingDeps.length === 0;
	return result;
}

/** Scheduler task ids referenced as falsifiers may be settings-defined task
 *  INSTANCES (not code-registered handler TYPES), so `getTaskHandler` alone
 *  under-recognizes them. This allowlist covers the curated health automations
 *  a contract is likely to point at; extend as contracts reference more. */
const KNOWN_TASK_IDS = new Set<string>([
	'vault-hygiene',
	'project-hygiene',
	'adr-status-drift-weekly',
	'adr-implementation-drift-weekly',
	'contract-registry-falsifier',
	'notification-budget-falsifier',
	'operator-notification-budget-falsifier',
	// ADR-007 P1 — propose-only guard for the hygiene-fixer agent.
	'hygiene-agent-propose-only-check',
]);
