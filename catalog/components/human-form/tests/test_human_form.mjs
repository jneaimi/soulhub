#!/usr/bin/env node
/**
 * Tests for human-form v1.0.0 (ADR-023 CP2).
 *
 * Spawns the component as a subprocess (mirroring how the Naseej runner invokes
 * it), pipes JSON in via stdin, asserts on exit code + parsed stdout JSON.
 * No live API — pure subprocess validation.
 *
 * Run: node test_human_form.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
		return JSON.parse(stdout.trim());
	} catch {
		throw new Error(`stdout was not JSON: ${stdout.slice(0, 300)}`);
	}
}

// ── (a) First invocation: pause-request + exit 2 ───────────────────────────

async function test_first_invocation_emits_pause_request() {
	const { code, stdout } = await invoke({
		prompt: 'Please fill in the form below.',
		fields: [
			{ name: 'verdict', type: 'select', label: 'Your verdict', required: true, options: ['approve', 'reject'] },
			{ name: 'notes', type: 'text', label: 'Notes' },
		],
		timeout_sec: 7200,
	});
	if (code !== 2) throw new Error(`expected exit 2 (pause), got ${code}`);
	const out = parseOut(stdout);
	if (out.pause !== true) throw new Error(`expected pause:true, got ${out.pause}`);
	if (out.kind !== 'human') throw new Error(`expected kind:'human', got ${out.kind}`);
	if (out.prompt !== 'Please fill in the form below.') throw new Error(`prompt mismatch: ${out.prompt}`);
	if (!Array.isArray(out.fields) || out.fields.length !== 2) throw new Error(`fields missing or wrong length`);
	if (out.timeout_sec !== 7200) throw new Error(`timeout_sec mismatch: ${out.timeout_sec}`);
}

async function test_first_invocation_default_timeout() {
	const { code, stdout } = await invoke({ prompt: 'Review the output.' });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (out.timeout_sec !== 3600) throw new Error(`expected default timeout 3600, got ${out.timeout_sec}`);
	if (!Array.isArray(out.fields) || out.fields.length !== 0) throw new Error(`expected empty fields array`);
}

// ── (b) Second invocation: resume_response echoed, exit 0 ──────────────────

async function test_second_invocation_echoes_response() {
	const resumePayload = { verdict: 'approve', notes: 'Looks good.' };
	const { code, stdout } = await invoke({
		prompt: 'Review the output.',
		resume_response: resumePayload,
	});
	if (code !== 0) throw new Error(`expected exit 0 (resumed), got ${code}`);
	const out = parseOut(stdout);
	if (!out.response) throw new Error('response field missing from output');
	if (out.response.verdict !== 'approve') throw new Error(`verdict mismatch: ${out.response.verdict}`);
	if (out.response.notes !== 'Looks good.') throw new Error(`notes mismatch: ${out.response.notes}`);
}

async function test_second_invocation_empty_resume_response() {
	const { code, stdout } = await invoke({
		prompt: 'Confirm to proceed.',
		resume_response: {},
	});
	if (code !== 0) throw new Error(`expected exit 0 for empty resume_response, got ${code}`);
	const out = parseOut(stdout);
	if (typeof out.response !== 'object' || out.response === null) throw new Error('response must be an object');
}

// ── (c) Bad input → exit 1 ────────────────────────────────────────────────

async function test_missing_prompt_exits_1() {
	const { code, stdout } = await invoke({ fields: [] });
	if (code !== 1) throw new Error(`expected exit 1 (bad input), got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field in output');
}

async function test_empty_prompt_exits_1() {
	const { code, stdout } = await invoke({ prompt: '   ' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field in output');
}

async function test_invalid_field_type_exits_1() {
	const { code, stdout } = await invoke({
		prompt: 'Fill in.',
		fields: [{ name: 'x' }], // missing type
	});
	if (code !== 1) throw new Error(`expected exit 1 for missing field.type, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field');
}

async function test_resume_response_not_object_exits_1() {
	const { code, stdout } = await invoke({
		prompt: 'Fill in.',
		resume_response: 'not-an-object',
	});
	if (code !== 1) throw new Error(`expected exit 1 for non-object resume_response, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field');
}

async function test_invalid_json_exits_1() {
	return new Promise((resolveP) => {
		const proc = spawn('node', [RUN_MJS], { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.on('close', (code) => {
			if (code !== 1) throw new Error(`expected exit 1 for invalid JSON, got ${code}`);
			resolveP();
		});
		proc.stdin.end('not json at all');
	});
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
	['first invocation emits pause-request + exits 2', test_first_invocation_emits_pause_request],
	['first invocation uses default timeout 3600', test_first_invocation_default_timeout],
	['second invocation echoes resume_response, exits 0', test_second_invocation_echoes_response],
	['second invocation with empty resume_response', test_second_invocation_empty_resume_response],
	['missing prompt exits 1', test_missing_prompt_exits_1],
	['empty prompt exits 1', test_empty_prompt_exits_1],
	['invalid field (missing type) exits 1', test_invalid_field_type_exits_1],
	['non-object resume_response exits 1', test_resume_response_not_object_exits_1],
	['invalid stdin JSON exits 1', test_invalid_json_exits_1],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err.message}`);
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
