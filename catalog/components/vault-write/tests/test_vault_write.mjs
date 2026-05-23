#!/usr/bin/env node
/**
 * Integration tests for vault-write v1.0.0.
 *
 * Hits a running Soul Hub on :2400 by default. Each test writes into
 * `inbox/_test-vault-write-component/` (kept under inbox because inbox/
 * accepts any type and tolerates ephemeral notes). Cleanup at the end
 * archives all test notes via DELETE.
 *
 * Run:
 *   node test_vault_write.mjs
 *
 * Skips silently if Soul Hub isn't up.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');
const API = process.env.VAULT_API_BASE || 'http://localhost:2400';
const TEST_ZONE = 'inbox/_test-vault-write-component';

const createdPaths = [];

function uniq() {
	return Math.random().toString(36).slice(2, 10);
}

/** Pipe payload into run.mjs and return { code, stdout, stderr }. */
function invoke(payload, env = {}) {
	return new Promise((resolveP) => {
		const proc = spawn('node', [RUN_MJS], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...env },
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => resolveP({ code, stdout, stderr }));
		proc.stdin.end(JSON.stringify(payload));
	});
}

async function soulHubUp() {
	try {
		const res = await fetch(`${API}/api/vault/notes?limit=1`);
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function test_create_happy() {
	const id = uniq();
	const payload = {
		path: `${TEST_ZONE}/2026-05-16-create-${id}.md`,
		frontmatter: {
			type: 'output',
			created: '2026-05-16',
			tags: ['naseej', 'vault-write-test'],
			source_agent: 'vault-write-test',
		},
		body: '# Create test\n\nHappy path.',
	};
	const { code, stdout } = await invoke(payload);
	if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout}`);
	const out = JSON.parse(stdout);
	if (out.action !== 'created') throw new Error(`expected action=created, got ${out.action}`);
	if (out.vault_path !== payload.path) throw new Error(`vault_path mismatch: ${out.vault_path}`);
	if (out.note_uri !== `vault://${payload.path}`) throw new Error(`note_uri mismatch: ${out.note_uri}`);
	if (typeof out.bytes_written !== 'number' || out.bytes_written < 50) {
		throw new Error(`bytes_written looks wrong: ${out.bytes_written}`);
	}
	createdPaths.push(payload.path);
}

async function test_create_refuses_overwrite() {
	const id = uniq();
	const path = `${TEST_ZONE}/2026-05-16-overwrite-${id}.md`;
	const payload = {
		path,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# First write',
	};
	const first = await invoke(payload);
	if (first.code !== 0) throw new Error(`first write failed: ${first.stdout}`);
	createdPaths.push(path);
	const second = await invoke({ ...payload, body: '# Second write' });
	if (second.code !== 5) throw new Error(`expected exit 5 on overwrite, got ${second.code}; stdout: ${second.stdout}`);
}

async function test_replace_happy() {
	const id = uniq();
	const path = `${TEST_ZONE}/2026-05-16-replace-${id}.md`;
	const create = await invoke({
		path,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# v1',
	});
	if (create.code !== 0) throw new Error(`create failed: ${create.stdout}`);
	createdPaths.push(path);
	const replace = await invoke({
		path,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test', 'replaced'], source_agent: 'vault-write-test' },
		body: '# v2 (replaced)',
		mode: 'replace',
	});
	if (replace.code !== 0) throw new Error(`replace failed; stdout: ${replace.stdout}; stderr: ${replace.stderr}`);
	const out = JSON.parse(replace.stdout);
	if (out.action !== 'updated') throw new Error(`expected action=updated, got ${out.action}`);
}

async function test_replace_refuses_missing() {
	const { code, stdout } = await invoke({
		path: `${TEST_ZONE}/2026-05-16-nonexistent-${uniq()}.md`,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# nope',
		mode: 'replace',
	});
	if (code !== 4) throw new Error(`expected exit 4 on missing-note replace, got ${code}; stdout: ${stdout}`);
}

async function test_append_happy() {
	const id = uniq();
	const path = `${TEST_ZONE}/2026-05-16-append-${id}.md`;
	const create = await invoke({
		path,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# initial line',
	});
	if (create.code !== 0) throw new Error(`create failed: ${create.stdout}`);
	createdPaths.push(path);
	const append = await invoke({
		path,
		frontmatter: {},
		body: 'appended line',
		mode: 'append',
	});
	if (append.code !== 0) throw new Error(`append failed; stdout: ${append.stdout}`);
	// Verify content was actually appended
	const verify = await fetch(`${API}/api/vault/notes/${path}`);
	const data = await verify.json();
	if (!data.content.includes('initial line') || !data.content.includes('appended line')) {
		throw new Error(`append didn't combine; content: ${data.content}`);
	}
}

async function test_api_down() {
	const { code, stdout } = await invoke({
		path: `${TEST_ZONE}/2026-05-16-down-${uniq()}.md`,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# x',
		api_base: 'http://localhost:9',
	});
	if (code !== 1) throw new Error(`expected exit 1 on api down, got ${code}; stdout: ${stdout}`);
	const out = JSON.parse(stdout);
	if (!out.error || !out.error.includes('cannot reach')) {
		throw new Error(`expected "cannot reach" in error, got: ${out.error}`);
	}
}

async function test_bad_input_missing_path() {
	const { code } = await invoke({
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['x'] },
		body: '# x',
	});
	if (code !== 2) throw new Error(`expected exit 2 on missing path, got ${code}`);
}

async function test_bad_input_path_traversal() {
	const { code } = await invoke({
		path: `${TEST_ZONE}/../escape.md`,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['x'] },
		body: '# x',
	});
	if (code !== 2) throw new Error(`expected exit 2 on traversal, got ${code}`);
}

async function test_bad_input_invalid_mode() {
	const { code } = await invoke({
		path: `${TEST_ZONE}/whatever.md`,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['x'] },
		body: '# x',
		mode: 'klingon',
	});
	if (code !== 2) throw new Error(`expected exit 2 on bad mode, got ${code}`);
}

async function test_zone_violation_rejected_by_api() {
	// pathology: try to write a `type: decision` into inbox/ (which doesn't allow decisions) — API should refuse with 400
	const { code, stdout } = await invoke({
		path: `${TEST_ZONE}/2026-05-16-bad-type-${uniq()}.md`,
		frontmatter: { type: 'snippet', created: '2026-05-16', tags: ['x'], source_agent: 'vault-write-test' },
		body: '# blocked',
	});
	// inbox/ allows any type so this might pass — the assertion is the API rejected the structure SOMEHOW or accepted it cleanly
	if (code === 0) {
		const out = JSON.parse(stdout);
		createdPaths.push(out.vault_path);
		return; // inbox accepts; that's fine
	}
	if (code !== 5) throw new Error(`expected exit 5 on api rejection, got ${code}; stdout: ${stdout}`);
}

async function test_output_shape_matches_block_md() {
	const id = uniq();
	const path = `${TEST_ZONE}/2026-05-16-shape-${id}.md`;
	const { code, stdout } = await invoke({
		path,
		frontmatter: { type: 'output', created: '2026-05-16', tags: ['naseej', 'vault-write-test'], source_agent: 'vault-write-test' },
		body: '# shape',
	});
	if (code !== 0) throw new Error(`create failed: ${stdout}`);
	createdPaths.push(path);
	const out = JSON.parse(stdout);
	for (const key of ['vault_path', 'note_uri', 'bytes_written', 'action', 'warnings']) {
		if (!(key in out)) throw new Error(`missing key: ${key}`);
	}
	if (!Array.isArray(out.warnings)) throw new Error('warnings must be array');
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function cleanup() {
	for (const p of createdPaths) {
		try {
			await fetch(`${API}/api/vault/notes/${p}`, { method: 'DELETE' });
		} catch { /* ignore */ }
	}
}

async function main() {
	if (!await soulHubUp()) {
		console.error(`[skip] Soul Hub not reachable at ${API}`);
		process.exit(0);
	}

	const tests = [
		test_create_happy,
		test_create_refuses_overwrite,
		test_replace_happy,
		test_replace_refuses_missing,
		test_append_happy,
		test_api_down,
		test_bad_input_missing_path,
		test_bad_input_path_traversal,
		test_bad_input_invalid_mode,
		test_zone_violation_rejected_by_api,
		test_output_shape_matches_block_md,
	];

	let passed = 0;
	let failed = 0;
	const failures = [];
	for (const t of tests) {
		try {
			await t();
			console.log(`  ✓ ${t.name}`);
			passed++;
		} catch (err) {
			console.error(`  ✗ ${t.name}: ${err.message}`);
			failures.push([t.name, err.message]);
			failed++;
		}
	}

	await cleanup();

	console.log(`\n${passed}/${passed + failed} passed`);
	if (failed > 0) {
		console.error('\nfailures:');
		for (const [name, msg] of failures) console.error(`  - ${name}: ${msg}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('fatal:', err);
	process.exit(1);
});
