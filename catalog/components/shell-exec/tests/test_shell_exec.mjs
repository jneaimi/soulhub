#!/usr/bin/env node
/**
 * Tests for shell-exec v1.0.0 (ADR-006 D7).
 *
 * Spawns the component as a subprocess (mirroring how the Naseej runner invokes
 * it), pipes JSON in via stdin, asserts on exit code + parsed stdout JSON.
 * No live API — pure subprocess wrapper.
 *
 * Run: node test_shell_exec.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');

function invoke(payload) {
	return new Promise((resolveP) => {
		const proc = spawn('node', [RUN_MJS], { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => resolveP({ code, stdout, stderr }));
		proc.stdin.end(JSON.stringify(payload));
	});
}

function parseOut(stdout) {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`stdout was not JSON: ${stdout.slice(0, 200)}`);
	}
}

// ── Happy path ─────────────────────────────────────────────────────────────

async function test_basic_echo() {
	const { code, stdout } = await invoke({ cmd: 'echo', args: ['hello', 'naseej'] });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 0) throw new Error(`expected outputs.exit_code 0, got ${out.exit_code}`);
	if (!out.stdout.includes('hello naseej')) throw new Error(`stdout missing expected content: ${out.stdout}`);
	if (typeof out.duration_ms !== 'number') throw new Error('duration_ms missing');
}

async function test_stdin_piped_through() {
	const { code, stdout } = await invoke({ cmd: 'cat', stdin: 'piped content\n' });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.stdout !== 'piped content\n') throw new Error(`stdin not piped through; got: ${out.stdout}`);
}

async function test_cwd_respected() {
	const { code, stdout } = await invoke({ cmd: 'pwd', cwd: '/tmp' });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	const reported = out.stdout.trim();
	// /tmp is a symlink to /private/tmp on macOS; either resolution is valid.
	if (reported !== '/tmp' && reported !== '/private/tmp') {
		throw new Error(`expected cwd /tmp, got ${reported}`);
	}
}

async function test_env_merged() {
	const { code, stdout } = await invoke({
		cmd: 'sh',
		args: ['-c', 'echo $NASEEJ_TEST_TOKEN'],
		env: { NASEEJ_TEST_TOKEN: 'sentinel-value' },
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.stdout.includes('sentinel-value')) throw new Error(`env not merged; stdout: ${out.stdout}`);
}

async function test_stdout_to_file() {
	const dir = await mkdtemp(join(tmpdir(), 'shell-exec-test-'));
	const target = join(dir, 'out.txt');
	try {
		const { code, stdout } = await invoke({
			cmd: 'echo',
			args: ['file-redirect-payload'],
			stdout_to_file: target,
		});
		if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
		const out = parseOut(stdout);
		if (out.stdout_path !== target) throw new Error(`stdout_path mismatch: ${out.stdout_path}`);
		const written = await readFile(target, 'utf-8');
		if (!written.includes('file-redirect-payload')) throw new Error(`file content wrong: ${written}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── Sad path ───────────────────────────────────────────────────────────────

async function test_missing_cmd() {
	const { code } = await invoke({});
	if (code !== 2) throw new Error(`expected exit 2 on missing cmd, got ${code}`);
}

async function test_empty_cmd() {
	const { code } = await invoke({ cmd: '   ' });
	if (code !== 2) throw new Error(`expected exit 2 on blank cmd, got ${code}`);
}

async function test_args_not_array() {
	const { code } = await invoke({ cmd: 'echo', args: 'not-an-array' });
	if (code !== 2) throw new Error(`expected exit 2 on non-array args, got ${code}`);
}

async function test_args_non_string_element() {
	const { code } = await invoke({ cmd: 'echo', args: ['ok', 123] });
	if (code !== 2) throw new Error(`expected exit 2 on non-string arg, got ${code}`);
}

async function test_relative_stdout_path_refused() {
	const { code } = await invoke({ cmd: 'echo', args: ['x'], stdout_to_file: 'relative.txt' });
	if (code !== 2) throw new Error(`expected exit 2 on relative path, got ${code}`);
}

async function test_command_not_found() {
	const { code, stdout } = await invoke({ cmd: 'this-command-does-not-exist-xyz' });
	if (code !== 126) throw new Error(`expected exit 126 on spawn fail, got ${code}; stdout: ${stdout}`);
	const out = parseOut(stdout);
	if (!out.stderr.includes('spawn error')) throw new Error(`stderr missing spawn error marker: ${out.stderr}`);
}

async function test_command_nonzero_passthrough() {
	const { code, stdout } = await invoke({ cmd: 'sh', args: ['-c', 'exit 42'] });
	if (code !== 42) throw new Error(`expected exit 42 passthrough, got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 42) throw new Error(`outputs.exit_code should be 42, got ${out.exit_code}`);
}

async function test_timeout() {
	const startedAt = Date.now();
	const { code, stdout } = await invoke({
		cmd: 'sh',
		args: ['-c', 'sleep 10'],
		timeout_sec: 1,
	});
	const elapsed = Date.now() - startedAt;
	if (code !== 124) throw new Error(`expected exit 124 on timeout, got ${code}`);
	if (elapsed > 8000) throw new Error(`timeout took too long (${elapsed}ms) — SIGTERM didn't fire?`);
	const out = parseOut(stdout);
	if (out.timed_out !== true) throw new Error(`outputs.timed_out should be true, got ${out.timed_out}`);
}

async function test_bad_json_stdin() {
	const proc = spawn('node', [RUN_MJS], { stdio: ['pipe', 'pipe', 'pipe'] });
	const { code } = await new Promise((resolveP) => {
		let stdout = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.on('close', (c) => resolveP({ code: c, stdout }));
		proc.stdin.end('not-json{{');
	});
	if (code !== 2) throw new Error(`expected exit 2 on bad JSON, got ${code}`);
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
	test_basic_echo,
	test_stdin_piped_through,
	test_cwd_respected,
	test_env_merged,
	test_stdout_to_file,
	test_missing_cmd,
	test_empty_cmd,
	test_args_not_array,
	test_args_non_string_element,
	test_relative_stdout_path_refused,
	test_command_not_found,
	test_command_nonzero_passthrough,
	test_timeout,
	test_bad_json_stdin,
];

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		await t();
		console.log(`✓ ${t.name}`);
		passed++;
	} catch (err) {
		console.error(`✗ ${t.name}: ${err.message}`);
		failed++;
	}
}
console.log(`\n${passed}/${tests.length} tests passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
