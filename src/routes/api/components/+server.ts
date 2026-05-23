/**
 * /api/components — Naseej component catalog (listing + publish gate).
 *
 * GET   ?category=&runtime=&q=    — list all valid components with filters.
 * POST  { name: string }          — validate a component against the publish gate.
 *
 * The POST publish gate branches on the component `kind`:
 *
 *   subprocess (default) — manifest_schema + entry_exists + tests + naming
 *     1. manifest_schema — BLOCK.md frontmatter parses against the Zod schema
 *     2. entry_exists    — run.py / run.mjs is present at the expected path
 *     3. tests           — every tests/test_*.{py,mjs} subprocess exits 0
 *
 *   presentation (ADR-030) — a pure template with no run entry:
 *     1. manifest_schema    — parses + declares template/styles/tokens/sample_inputs
 *     2. templates_exist    — en (+ ar if declared) templates + styles on disk
 *     3. renders_standalone — doc-render renders it alone (EN + AR) → non-empty PDF
 *     4. tokens_declared    — every var(--x) the template references is in tokens[]
 *
 * naming_convention is a shared soft warning across both kinds.
 *
 * Response is structured (`checks: [{ name, status, ... }]`) so callers can
 * surface the exact failure to the operator without parsing prose.
 *
 * Status codes:
 *   200 — all checks passed (safe to `git add` and ship)
 *   422 — component exists but a check failed
 *   404 — `catalog/components/<name>/` doesn't exist
 *   400 — bad request body
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
	DEFAULT_CATALOG_DIR,
	fileExists,
	loadAllComponentManifests,
	loadComponentManifestSafe,
	type ComponentRecord,
} from '$lib/naseej/manifest.js';
import { recordPublish } from '$lib/naseej/audit.js';
import { regenCatalogIndexBestEffort } from '$lib/naseej/catalog-index.js';

/** Per-test-file timeout. Tests today run in <2s (stop-slop) to <10s (vault-write). */
const TEST_TIMEOUT_MS = 60_000;

/** doc-render render timeout for the renders_standalone gate. Generous to cover
 *  a cold WeasyPrint dependency install on first run; warm renders take ~3s. */
const RENDER_TIMEOUT_MS = 60_000;

/** The doc-render engine that renders a presentation component standalone. */
const DOC_RENDER_DIR = resolvePath(DEFAULT_CATALOG_DIR, 'doc-render');
const DOC_RENDER_ENTRY = join(DOC_RENDER_DIR, 'run.py');

/** CSS variables the page shell always injects (so a presentation component may
 *  reference them without declaring them in `tokens`). Everything else a
 *  template references must be declared (ADR-030 tokens_declared check). */
const ENGINE_PROVIDED_VARS = new Set(['--font-primary', '--font-display', '--font-mono']);

/** Valid component name pattern (mirrors the Zod schema). Enforced before any
 *  disk access to block path traversal. */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface TestFileResult {
	file: string;
	exit_code: number;
	duration_ms: number;
	timed_out: boolean;
	stderr_excerpt?: string;
}

type CheckResult =
	| { name: 'manifest_schema'; status: 'passed' | 'failed'; errors?: unknown[] }
	| { name: 'entry_exists'; status: 'passed' | 'failed'; detail?: string }
	| {
			name: 'tests';
			status: 'passed' | 'failed' | 'skipped';
			detail?: string;
			test_files?: TestFileResult[];
	  }
	| {
			name: 'naming_convention';
			status: 'passed' | 'warning';
			detail?: string;
			conflicts?: string[];
	  }
	| {
			name: 'templates_exist';
			status: 'passed' | 'failed';
			detail?: string;
			missing?: string[];
	  }
	| {
			name: 'tokens_declared';
			status: 'passed' | 'failed';
			detail?: string;
			undeclared?: string[];
	  }
	| {
			name: 'renders_standalone';
			status: 'passed' | 'failed';
			detail?: string;
			langs?: RenderLangResult[];
	  };

interface RenderLangResult {
	lang: string;
	exit_code: number;
	bytes: number;
	ok: boolean;
	stderr_excerpt?: string;
}

interface PublishResult {
	component: string;
	version?: string;
	status: 'passed' | 'failed';
	duration_ms: number;
	checks: CheckResult[];
}

/** Spawn one test file. Returns the exit code + duration + (stderr excerpt on failure). */
function runTestFile(
	file: string,
	cwd: string,
	timeoutMs: number,
): Promise<TestFileResult> {
	const isPython = file.endsWith('.py');
	const command = isPython ? 'uv' : 'node';
	const args = isPython ? ['run', file] : [file];
	return new Promise((resolveP) => {
		const startedAt = Date.now();
		const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
		let stderr = '';
		proc.stderr.on('data', (d) => {
			stderr += d;
			// Cap accumulation at ~16KB to bound memory if a test screams
			if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
		});
		const timeoutHandle = setTimeout(() => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.kill('SIGKILL'), 2000);
		}, timeoutMs);
		proc.on('close', (code, signal) => {
			clearTimeout(timeoutHandle);
			const timed_out = signal === 'SIGTERM' || signal === 'SIGKILL';
			const result: TestFileResult = {
				file: file.split('/').slice(-3).join('/'),
				exit_code: code ?? -1,
				duration_ms: Date.now() - startedAt,
				timed_out,
			};
			if ((code ?? -1) !== 0 || timed_out) {
				result.stderr_excerpt = stderr.trim().slice(-1024) || undefined;
			}
			resolveP(result);
		});
	});
}

/** Discover tests/test_*.{py,mjs} under a component dir. */
async function discoverTests(componentDir: string): Promise<string[]> {
	const testsDir = join(componentDir, 'tests');
	let entries: string[];
	try {
		entries = await readdir(testsDir);
	} catch {
		return [];
	}
	return entries
		.filter((e) => /^test_.+\.(py|mjs)$/.test(e))
		.map((e) => join(testsDir, e))
		.sort();
}

// ── Presentation-kind gate (ADR-030 CP3) ───────────────────────────────────

/** Check 2 (presentation): templates_exist — the declared en (and ar, if
 *  declared) templates plus styles are present on disk. */
async function checkTemplatesExist(record: ComponentRecord): Promise<CheckResult> {
	const m = record.manifest;
	const missing: string[] = [];
	const enRel = m.template?.en;
	if (!enRel) missing.push('template.en (not declared)');
	else if (!(await fileExists(join(record.dir, enRel)))) missing.push(`template.en (${enRel})`);
	if (m.template?.ar && !(await fileExists(join(record.dir, m.template.ar)))) {
		missing.push(`template.ar (${m.template.ar})`);
	}
	if (!m.styles) missing.push('styles (not declared)');
	else if (!(await fileExists(join(record.dir, m.styles)))) missing.push(`styles (${m.styles})`);
	return missing.length
		? { name: 'templates_exist', status: 'failed', detail: `missing: ${missing.join(', ')}`, missing }
		: { name: 'templates_exist', status: 'passed' };
}

/** Check 4 (presentation): tokens_declared — every `var(--x)` referenced by the
 *  templates + styles is listed in `tokens` (engine-provided font vars exempt). */
async function checkTokensDeclared(record: ComponentRecord): Promise<CheckResult> {
	const m = record.manifest;
	const declared = new Set(m.tokens ?? []);
	const rels = [m.template?.en, m.template?.ar, m.styles].filter((r): r is string => !!r);
	const referenced = new Set<string>();
	for (const rel of rels) {
		let content: string;
		try {
			content = await readFile(join(record.dir, rel), 'utf-8');
		} catch {
			continue;
		}
		for (const match of content.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
			referenced.add(match[1].toLowerCase());
		}
	}
	const undeclared = [...referenced]
		.filter((v) => !declared.has(v) && !ENGINE_PROVIDED_VARS.has(v))
		.sort();
	return undeclared.length
		? {
				name: 'tokens_declared',
				status: 'failed',
				detail: `template references CSS variables not declared in tokens[]: ${undeclared.join(', ')}`,
				undeclared,
		  }
		: { name: 'tokens_declared', status: 'passed' };
}

/** Spawn doc-render once for a single composition entry, return exit + stderr. */
function runDocRender(
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<{ exit_code: number; stderr: string; timed_out: boolean }> {
	return new Promise((resolveP) => {
		const proc = spawn('uv', ['run', DOC_RENDER_ENTRY], {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: DOC_RENDER_DIR,
		});
		let stderr = '';
		proc.stderr.on('data', (d) => {
			stderr += d;
			if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
		});
		const timeoutHandle = setTimeout(() => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.kill('SIGKILL'), 2000);
		}, timeoutMs);
		proc.on('close', (code, signal) => {
			clearTimeout(timeoutHandle);
			resolveP({
				exit_code: code ?? -1,
				stderr,
				timed_out: signal === 'SIGTERM' || signal === 'SIGKILL',
			});
		});
		proc.stdin.end(JSON.stringify(payload));
	});
}

/** Check 3 (presentation): renders_standalone — doc-render renders this one
 *  component with its manifest sample_inputs, in EN and (if it declares an ar
 *  template) AR. Each must exit 0 and write a non-empty PDF. */
async function checkRendersStandalone(record: ComponentRecord): Promise<CheckResult> {
	const m = record.manifest;
	const langs = ['en'];
	if (m.template?.ar) langs.push('ar');
	const results: RenderLangResult[] = [];
	for (const lang of langs) {
		const outPdf = join(
			tmpdir(),
			`naseej-gate-${m.name}-${lang}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`,
		);
		const res = await runDocRender(
			{
				composition: [{ component: m.name, inputs: m.sample_inputs ?? {} }],
				lang,
				out_pdf: outPdf,
				catalog_root: DEFAULT_CATALOG_DIR,
			},
			RENDER_TIMEOUT_MS,
		);
		let bytes = 0;
		try {
			bytes = (await stat(outPdf)).size;
		} catch {
			/* not written */
		}
		const ok = res.exit_code === 0 && bytes > 0 && !res.timed_out;
		results.push({
			lang,
			exit_code: res.exit_code,
			bytes,
			ok,
			...(ok ? {} : { stderr_excerpt: res.stderr.trim().slice(-1024) || undefined }),
		});
		await rm(outPdf, { force: true }).catch(() => {});
	}
	const allOk = results.length > 0 && results.every((r) => r.ok);
	return {
		name: 'renders_standalone',
		status: allOk ? 'passed' : 'failed',
		langs: results,
		...(allOk ? {} : { detail: 'one or more languages failed to render a non-empty PDF' }),
	};
}

/** Shared soft-warning check (ADR-006 D5) — warns if the component name collides
 *  with an active recipe slug. Component names should describe verbs/systems,
 *  not workflows. Non-fatal: a warning never fails the gate. */
async function checkNamingConvention(record: ComponentRecord): Promise<CheckResult> {
	const RECIPES_DIR = resolvePath(process.cwd(), 'catalog/recipes');
	let recipeSlugs: string[] = [];
	try {
		const entries = await readdir(RECIPES_DIR);
		recipeSlugs = (
			await Promise.all(
				entries.map(async (dir) =>
					(await fileExists(join(RECIPES_DIR, dir, 'recipe.yaml'))) ? dir : null,
				),
			)
		).filter((s): s is string => s !== null);
	} catch {
		// Catalog dir missing — no conflicts possible.
	}
	const conflict = recipeSlugs.includes(record.manifest.name);
	return {
		name: 'naming_convention',
		status: conflict ? 'warning' : 'passed',
		...(conflict
			? {
					detail: `component name "${record.manifest.name}" matches an active recipe slug. Per ADR-006 D5, components describe verbs or systems, not workflows. Soft warning — publish still succeeds.`,
					conflicts: [record.manifest.name],
			  }
			: {}),
	};
}

/** GET /api/components — list Naseej components from catalog/components/.
 *  Filters: ?category=, ?runtime=, ?q= (substring on name + description) */
export const GET: RequestHandler = async ({ url }) => {
	const records = await loadAllComponentManifests();
	const category = url.searchParams.get('category')?.toLowerCase() || null;
	const runtime = url.searchParams.get('runtime')?.toLowerCase() || null;
	const q = url.searchParams.get('q')?.toLowerCase() || null;

	const results = records
		.filter((r) => {
			if (category && (r.manifest.category || '').toLowerCase() !== category) return false;
			if (runtime && r.manifest.runtime.toLowerCase() !== runtime) return false;
			if (q) {
				const hay = `${r.manifest.name} ${r.manifest.description || ''}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		})
		.map((r) => ({
			// List shape — only the fields the marketplace cards render. The
			// full per-component detail (`inputs`, `outputs`, `invocation`)
			// belongs in a future detail endpoint, not the list payload —
			// keeping it out shaves ~60% off the response on a 20-component
			// catalog and tightens the contract.
			name: r.manifest.name,
			version: r.manifest.version,
			id: r.id,
			type: r.manifest.type,
			category: r.manifest.category,
			runtime: r.manifest.runtime,
			tier: r.manifest.tier,
			description: r.manifest.description,
			author: r.manifest.author,
			project: r.manifest.project,
			manifest_path: r.manifest_path,
		}));

	const facets = {
		categories: Array.from(
			new Set(records.map((r) => r.manifest.category).filter((v): v is string => !!v)),
		).sort(),
		runtimes: Array.from(new Set(records.map((r) => r.manifest.runtime))).sort(),
	};

	return json({ results, total: results.length, facets });
};

/** POST /api/components — validate a component against the publish gate.
 *  Body: { name: string }   (component dir under catalog/components/) */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { name } = (body as Record<string, unknown>) ?? {};
	if (typeof name !== 'string' || !name) {
		return json({ error: 'name (string) is required' }, { status: 400 });
	}
	if (!NAME_RE.test(name)) {
		return json(
			{ error: `name must match ${NAME_RE.source} (kebab-case, starts with a letter)` },
			{ status: 400 },
		);
	}

	const componentDir = resolvePath(DEFAULT_CATALOG_DIR, name);
	// Path-traversal defence (NAME_RE already blocks `/` and `..`, this is belt-and-braces)
	if (!componentDir.startsWith(DEFAULT_CATALOG_DIR + '/')) {
		return json({ error: 'name resolves outside catalog/components/' }, { status: 400 });
	}
	if (!(await fileExists(componentDir))) {
		return json(
			{ error: `component not found: catalog/components/${name}` },
			{ status: 404 },
		);
	}

	const startedAt = Date.now();
	const checks: CheckResult[] = [];

	// Check 1: manifest_schema
	const safe = await loadComponentManifestSafe(componentDir);
	if (!safe.ok) {
		const errors =
			safe.reason === 'schema_invalid'
				? safe.errors
				: [{ path: [], message: `${safe.reason}: ${safe.detail}` }];
		checks.push({ name: 'manifest_schema', status: 'failed', errors });
		const result: PublishResult = {
			component: name,
			status: 'failed',
			duration_ms: Date.now() - startedAt,
			checks,
		};
		recordPublish({
			component: name,
			publishedAt: Date.now(),
			status: 'failed',
			checksJson: JSON.stringify(checks),
			durationMs: result.duration_ms,
		});
		return json(result, { status: 422 });
	}
	checks.push({ name: 'manifest_schema', status: 'passed' });

	const record = safe.record;

	// ── Presentation-kind gate (ADR-030 CP3) ──────────────────────────────
	// A `kind: presentation` component is a pure template with no run entry, so
	// it takes a different gate: manifest_schema (done) + templates_exist +
	// renders_standalone + tokens_declared. Subprocess components fall through
	// to the unchanged entry_exists / tests gate below.
	if (record.manifest.kind === 'presentation') {
		checks.push(await checkTemplatesExist(record));
		checks.push(await checkTokensDeclared(record));
		// Only attempt a render if the static checks passed — a missing template
		// or undeclared token makes the render result noise.
		const staticOk = checks.every((c) => c.status !== 'failed');
		if (staticOk) {
			checks.push(await checkRendersStandalone(record));
		} else {
			checks.push({
				name: 'renders_standalone',
				status: 'failed',
				detail: 'skipped — templates_exist or tokens_declared failed first',
			});
		}

		// naming_convention (shared soft warning — applies to any component name).
		checks.push(await checkNamingConvention(record));

		const presFailed = checks.some((c) => c.status === 'failed');
		const presResult: PublishResult = {
			component: record.manifest.name,
			version: record.manifest.version,
			status: presFailed ? 'failed' : 'passed',
			duration_ms: Date.now() - startedAt,
			checks,
		};
		recordPublish({
			component: record.manifest.name,
			version: record.manifest.version,
			publishedAt: Date.now(),
			status: presFailed ? 'failed' : 'passed',
			checksJson: JSON.stringify(checks),
			durationMs: presResult.duration_ms,
		});
		if (!presFailed) {
			void regenCatalogIndexBestEffort();
		}
		return json(presResult, { status: presFailed ? 422 : 200 });
	}

	// Check 2: entry_exists
	if (!(await fileExists(record.entry))) {
		checks.push({
			name: 'entry_exists',
			status: 'failed',
			detail: `expected ${record.entry.replace(process.cwd() + '/', '')} not found`,
		});
		const result: PublishResult = {
			component: record.manifest.name,
			version: record.manifest.version,
			status: 'failed',
			duration_ms: Date.now() - startedAt,
			checks,
		};
		recordPublish({
			component: record.manifest.name,
			version: record.manifest.version,
			publishedAt: Date.now(),
			status: 'failed',
			checksJson: JSON.stringify(checks),
			durationMs: result.duration_ms,
		});
		return json(result, { status: 422 });
	}
	checks.push({ name: 'entry_exists', status: 'passed' });

	// Check 3: tests
	const testFiles = await discoverTests(componentDir);
	if (testFiles.length === 0) {
		checks.push({
			name: 'tests',
			status: 'skipped',
			detail: 'no tests/test_*.{py,mjs} files found',
		});
	} else {
		const testResults = await Promise.all(
			testFiles.map((f) => runTestFile(f, record.dir, TEST_TIMEOUT_MS)),
		);
		const allPassed = testResults.every((t) => t.exit_code === 0 && !t.timed_out);
		checks.push({
			name: 'tests',
			status: allPassed ? 'passed' : 'failed',
			test_files: testResults,
		});
	}

	// Check 4: naming_convention (ADR-006 D5) — shared soft warning.
	checks.push(await checkNamingConvention(record));

	const failed = checks.some((c) => c.status === 'failed');
	const result: PublishResult = {
		component: record.manifest.name,
		version: record.manifest.version,
		status: failed ? 'failed' : 'passed',
		duration_ms: Date.now() - startedAt,
		checks,
	};
	recordPublish({
		component: record.manifest.name,
		version: record.manifest.version,
		publishedAt: Date.now(),
		status: failed ? 'failed' : 'passed',
		checksJson: JSON.stringify(checks),
		durationMs: result.duration_ms,
	});
	// ADR-027 P2.2 — auto-regen catalog-index on successful publish so the
	// AI-as-author surface stays current. Best-effort + non-blocking: the
	// publish has already passed, a regen failure must not invalidate it.
	if (!failed) {
		void regenCatalogIndexBestEffort();
	}
	return json(result, { status: failed ? 422 : 200 });
};
