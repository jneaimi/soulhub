/**
 * Language adapters for the post-merge pipeline.
 *
 * Each adapter encapsulates the commands a senior developer would run after
 * merging on that project type — install deps, typecheck, lint, test, build.
 * The pipeline runner (post-merge-pipeline.ts) is language-agnostic; it asks
 * the adapter "what steps should I run in this repo?" and the adapter returns
 * a list of StepDefinitions.
 *
 * Add a new language by: (a) writing an adapter below, (b) adding it to
 * ADAPTERS in detectAdapter order, (c) ensuring the detect predicate is
 * unambiguous against existing adapters.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StepContext, StepDefinition, StepRunResult } from './post-merge-pipeline.js';

const execFileAsync = promisify(execFile);
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

export type ProjectType = 'node' | 'python' | 'rust' | 'go' | 'generic';

export interface LanguageAdapter {
	type: ProjectType;
	/** True if this adapter should handle the given project. */
	detect(projectPath: string): boolean;
	/** Return the ordered post-merge step list for this project type. */
	buildSteps(ctx: StepContext): Promise<StepDefinition[]>;
}

/** Pick the first matching adapter; falls back to generic if none match. */
export function detectAdapter(projectPath: string): LanguageAdapter {
	for (const adapter of ADAPTERS) {
		if (adapter.detect(projectPath)) return adapter;
	}
	return genericAdapter;
}

// ─── Shared helpers ────────────────────────────────────────────────────────

async function execStep(
	cwd: string,
	cmd: string,
	args: string[],
	extraEnv?: NodeJS.ProcessEnv,
): Promise<StepRunResult> {
	try {
		const r = await execFileAsync(cmd, args, {
			cwd,
			maxBuffer: 20 * 1024 * 1024,
			timeout: STEP_TIMEOUT_MS,
			env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		});
		return { ok: true, output: r.stdout || r.stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, output: (e.stderr || e.stdout || e.message || String(err)).toString() };
	}
}

async function hasCommand(cmd: string): Promise<boolean> {
	try {
		await execFileAsync('which', [cmd]);
		return true;
	} catch {
		return false;
	}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		return {};
	}
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, 'utf-8');
	} catch {
		return '';
	}
}

// ─── Node adapter ──────────────────────────────────────────────────────────

const nodeAdapter: LanguageAdapter = {
	type: 'node',
	detect: (p) => existsSync(join(p, 'package.json')),

	async buildSteps(ctx) {
		const pm = detectNodePackageManager(ctx.projectPath);
		const pkg = (await readJson(join(ctx.projectPath, 'package.json'))) as {
			scripts?: Record<string, string>;
		};
		const hasScript = (name: string) => Boolean(pkg.scripts?.[name]);

		return [
			{
				id: 'install',
				name: 'Install dependencies',
				blocking: true,
				run: () => nodeInstall(ctx.projectPath, pm),
			},
			{
				id: 'typecheck',
				name: 'Type check',
				blocking: true,
				shouldSkip: () => !existsSync(join(ctx.projectPath, 'tsconfig.json')),
				run: async () => {
					// Prefer project script — frameworks like SvelteKit/Next need a
					// prep step (svelte-kit sync, next build --dry) before tsc.
					const script = ['typecheck', 'type-check', 'check:types', 'check'].find(hasScript);
					if (script) return execStep(ctx.projectPath, pm, ['run', script]);
					return execStep(ctx.projectPath, 'npx', ['tsc', '--noEmit']);
				},
			},
			{
				id: 'lint',
				name: 'Lint',
				blocking: false,
				shouldSkip: () => !hasScript('lint'),
				run: () => execStep(ctx.projectPath, pm, ['run', 'lint']),
			},
			{
				id: 'test',
				name: 'Tests',
				blocking: false,
				shouldSkip: () =>
					!hasScript('test') || /no test specified/i.test(pkg.scripts?.test ?? ''),
				run: () => execStep(ctx.projectPath, pm, ['run', 'test']),
			},
			{
				id: 'build',
				name: 'Build',
				blocking: true,
				shouldSkip: () => !hasScript('build'),
				run: () => execStep(ctx.projectPath, pm, ['run', 'build']),
			},
		];
	},
};

type NodePkgManager = 'pnpm' | 'npm' | 'yarn';

function detectNodePackageManager(projectPath: string): NodePkgManager {
	if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
	if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
	return 'npm';
}

async function nodeInstall(projectPath: string, pm: NodePkgManager): Promise<StepRunResult> {
	// Post-merge: always clean-install from merged package.json. Multi-worker
	// merges produce unreliable lockfile state; npm install on a stale lockfile
	// can silently *remove* packages the merged package.json needs.
	await rm(join(projectPath, 'node_modules'), { recursive: true, force: true }).catch(() => {});
	const lockfile = pm === 'pnpm' ? 'pnpm-lock.yaml' : pm === 'yarn' ? 'yarn.lock' : 'package-lock.json';
	await rm(join(projectPath, lockfile), { force: true }).catch(() => {});

	// Resolve the target project's intended Node — native modules (better-sqlite3,
	// sharp) get compiled against whichever Node runs `npm install`. If soul-hub's
	// runtime Node differs from the project's, the user hits ABI mismatch errors
	// at `npm run dev`. Respect .nvmrc / engines.node / volta.node when present.
	const targetNode = await resolveProjectNodeBin(projectPath);
	const envOverride: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
	let resolveNote = '';
	if (targetNode && targetNode.path !== process.execPath) {
		envOverride.PATH = `${targetNode.binDir}:${process.env.PATH ?? ''}`;
		resolveNote = `[using project-pinned Node ${targetNode.version} from ${targetNode.binDir}]\n`;
	}

	// Force NODE_ENV=development so devDependencies install — when soul-hub runs
	// under pm2 (NODE_ENV=production), that leaks into child `npm install` and
	// silently drops devDeps like @sveltejs/adapter-node, breaking typecheck/build.
	const r = await execStep(projectPath, pm, ['install'], envOverride);
	return r.ok
		? { ok: true, output: `[clean install from merged package.json]\n${resolveNote}${r.output}` }
		: r;
}

interface ProjectNodeBin {
	path: string;
	binDir: string;
	version: string;
}

/**
 * Find the Node binary matching the project's pinned version. Checks, in order:
 *   1. .nvmrc
 *   2. package.json#volta.node
 *   3. package.json#engines.node (exact or major-only — fuzzy matches any installed
 *      nvm version satisfying the major)
 *
 * Returns null if no pin is specified or no matching installed Node is found —
 * caller falls back to the current process's Node.
 */
async function resolveProjectNodeBin(projectPath: string): Promise<ProjectNodeBin | null> {
	const pinned = await readProjectNodePin(projectPath);
	if (!pinned) return null;

	const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
	if (!existsSync(nvmRoot)) return null;

	let installed: string[];
	try {
		installed = readdirSync(nvmRoot).filter((v) => v.startsWith('v'));
	} catch {
		return null;
	}

	const match = pickBestVersion(pinned, installed);
	if (!match) return null;

	const binDir = join(nvmRoot, match, 'bin');
	const nodePath = join(binDir, 'node');
	if (!existsSync(nodePath)) return null;

	return { path: nodePath, binDir, version: match };
}

async function readProjectNodePin(projectPath: string): Promise<string | null> {
	const nvmrc = (await readText(join(projectPath, '.nvmrc'))).trim();
	if (nvmrc) return nvmrc;

	const pkg = (await readJson(join(projectPath, 'package.json'))) as {
		volta?: { node?: string };
		engines?: { node?: string };
	};
	if (pkg.volta?.node) return pkg.volta.node;
	if (pkg.engines?.node) return pkg.engines.node;
	return null;
}

/**
 * Pick the best installed version for a pin. Pins can be:
 *   - exact: "24.14.0", "v24.14.0"
 *   - major: "24", "v24"
 *   - range: ">=22", "^22.0.0" (only the leading major is honored — we don't
 *     bundle a semver parser)
 *
 * Prefers exact match, then highest minor/patch within major.
 */
function pickBestVersion(pin: string, installed: string[]): string | null {
	const cleaned = pin.replace(/^[v^~>=<\s]+/, '').trim();
	if (!cleaned) return null;

	const exact = installed.find((v) => v === `v${cleaned}` || v === cleaned);
	if (exact) return exact;

	const major = cleaned.split('.')[0];
	if (!/^\d+$/.test(major)) return null;
	const withinMajor = installed
		.filter((v) => v.startsWith(`v${major}.`) || v === `v${major}`)
		.sort(compareNvmVersions);
	return withinMajor.pop() ?? null;
}

function compareNvmVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, '').split('.').map(Number);
	const pb = b.replace(/^v/, '').split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

// ─── Python adapter ────────────────────────────────────────────────────────

const pythonAdapter: LanguageAdapter = {
	type: 'python',
	detect: (p) =>
		existsSync(join(p, 'pyproject.toml')) ||
		existsSync(join(p, 'requirements.txt')) ||
		existsSync(join(p, 'Pipfile')) ||
		existsSync(join(p, 'setup.py')),

	async buildSteps(ctx) {
		const pyproject = await readText(join(ctx.projectPath, 'pyproject.toml'));
		const hasMypy = /\[tool\.mypy\]|\[tool\.pyright\]/.test(pyproject) ||
			existsSync(join(ctx.projectPath, 'mypy.ini')) ||
			existsSync(join(ctx.projectPath, 'pyrightconfig.json'));
		const hasRuff = /\[tool\.ruff\]/.test(pyproject);
		const hasFlake8 = existsSync(join(ctx.projectPath, '.flake8')) || /\[flake8\]/.test(pyproject);
		const hasPytest =
			/\[tool\.pytest/.test(pyproject) ||
			existsSync(join(ctx.projectPath, 'pytest.ini')) ||
			existsSync(join(ctx.projectPath, 'tests'));

		return [
			{
				id: 'install',
				name: 'Install dependencies',
				blocking: true,
				run: () => pythonInstall(ctx.projectPath),
			},
			{
				id: 'typecheck',
				name: 'Type check',
				blocking: true,
				shouldSkip: () => !hasMypy,
				run: async () => {
					if (await hasCommand('mypy')) return execStep(ctx.projectPath, 'mypy', ['.']);
					if (await hasCommand('pyright')) return execStep(ctx.projectPath, 'pyright', []);
					return { ok: false, output: 'no typechecker found (install mypy or pyright)' };
				},
			},
			{
				id: 'lint',
				name: 'Lint',
				blocking: false,
				shouldSkip: () => !hasRuff && !hasFlake8,
				run: async () => {
					if (hasRuff && (await hasCommand('ruff'))) return execStep(ctx.projectPath, 'ruff', ['check', '.']);
					if (hasFlake8 && (await hasCommand('flake8'))) return execStep(ctx.projectPath, 'flake8', []);
					return { ok: true, output: 'linter configured but not installed — skipping' };
				},
			},
			{
				id: 'test',
				name: 'Tests',
				blocking: false,
				shouldSkip: () => !hasPytest,
				run: async () => {
					if (await hasCommand('pytest')) return execStep(ctx.projectPath, 'pytest', ['-q']);
					return execStep(ctx.projectPath, 'python', ['-m', 'pytest', '-q']);
				},
			},
			// No build step — Python apps are source-shipped. Library builds
			// (`python -m build`) are opt-in; we don't auto-run them.
		];
	},
};

async function pythonInstall(projectPath: string): Promise<StepRunResult> {
	// Prefer modern managers with lockfiles → fall back to pip/requirements.
	if (existsSync(join(projectPath, 'uv.lock')) && (await hasCommand('uv'))) {
		return execStep(projectPath, 'uv', ['sync']);
	}
	if (existsSync(join(projectPath, 'poetry.lock')) && (await hasCommand('poetry'))) {
		return execStep(projectPath, 'poetry', ['install', '--no-interaction']);
	}
	if (existsSync(join(projectPath, 'Pipfile.lock')) && (await hasCommand('pipenv'))) {
		return execStep(projectPath, 'pipenv', ['install', '--deploy']);
	}
	if (existsSync(join(projectPath, 'requirements.txt'))) {
		return execStep(projectPath, 'pip', ['install', '-r', 'requirements.txt']);
	}
	if (existsSync(join(projectPath, 'pyproject.toml'))) {
		return execStep(projectPath, 'pip', ['install', '-e', '.']);
	}
	return { ok: true, output: 'no Python install target found — skipping' };
}

// ─── Rust adapter ──────────────────────────────────────────────────────────

const rustAdapter: LanguageAdapter = {
	type: 'rust',
	detect: (p) => existsSync(join(p, 'Cargo.toml')),

	async buildSteps(ctx) {
		return [
			{
				id: 'install',
				name: 'Fetch dependencies',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'cargo', ['fetch']),
			},
			{
				id: 'typecheck',
				name: 'Type check (cargo check)',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'cargo', ['check', '--all-targets']),
			},
			{
				id: 'lint',
				name: 'Clippy',
				blocking: false,
				shouldSkip: async () => !(await hasCommand('cargo-clippy')),
				run: () => execStep(ctx.projectPath, 'cargo', ['clippy', '--all-targets', '--', '-D', 'warnings']),
			},
			{
				id: 'test',
				name: 'Tests',
				blocking: false,
				run: () => execStep(ctx.projectPath, 'cargo', ['test']),
			},
			{
				id: 'build',
				name: 'Release build',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'cargo', ['build', '--release']),
			},
		];
	},
};

// ─── Go adapter ────────────────────────────────────────────────────────────

const goAdapter: LanguageAdapter = {
	type: 'go',
	detect: (p) => existsSync(join(p, 'go.mod')),

	async buildSteps(ctx) {
		return [
			{
				id: 'install',
				name: 'Download modules',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'go', ['mod', 'download']),
			},
			{
				id: 'typecheck',
				name: 'go vet',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'go', ['vet', './...']),
			},
			{
				id: 'lint',
				name: 'golangci-lint',
				blocking: false,
				shouldSkip: async () => !(await hasCommand('golangci-lint')),
				run: () => execStep(ctx.projectPath, 'golangci-lint', ['run', './...']),
			},
			{
				id: 'test',
				name: 'Tests',
				blocking: false,
				run: () => execStep(ctx.projectPath, 'go', ['test', './...']),
			},
			{
				id: 'build',
				name: 'Build',
				blocking: true,
				run: () => execStep(ctx.projectPath, 'go', ['build', './...']),
			},
		];
	},
};

// ─── Generic fallback ──────────────────────────────────────────────────────

const genericAdapter: LanguageAdapter = {
	type: 'generic',
	detect: () => true,

	async buildSteps() {
		// No recognized manifest — we can't validate anything without guessing.
		// Emit a single advisory step so the UI shows WHY the checklist is empty.
		return [
			{
				id: 'detect',
				name: 'Project type detection',
				blocking: false,
				run: async () => ({
					ok: true,
					output: 'No recognized project manifest (package.json, pyproject.toml, Cargo.toml, go.mod). Skipping validation.',
				}),
			},
		];
	},
};

// Order matters: more-specific adapters first. Node has highest reach because
// package.json is common; generic is always last as the catch-all.
const ADAPTERS: LanguageAdapter[] = [nodeAdapter, pythonAdapter, rustAdapter, goAdapter];
