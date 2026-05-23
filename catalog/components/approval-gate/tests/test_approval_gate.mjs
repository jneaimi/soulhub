#!/usr/bin/env node
/**
 * Tests for approval-gate v1.0.0 (ADR-023 CP3).
 *
 * Spawns the component as a subprocess (mirroring how the Naseej runner invokes
 * it), pipes JSON in via stdin, asserts on exit code + parsed stdout JSON.
 * No live API — pure subprocess validation.
 *
 * Run: node test_approval_gate.mjs
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
		prompt: 'Approve to send the newsletter to 847 subscribers.',
		allow_comment: true,
		timeout_sec: 86400,
	});
	if (code !== 2) throw new Error(`expected exit 2 (pause), got ${code}`);
	const out = parseOut(stdout);
	if (out.pause !== true) throw new Error(`expected pause:true, got ${out.pause}`);
	if (out.kind !== 'gate') throw new Error(`expected kind:'gate', got ${out.kind}`);
	if (out.prompt !== 'Approve to send the newsletter to 847 subscribers.') {
		throw new Error(`prompt mismatch: ${out.prompt}`);
	}
	if (out.allow_comment !== true) throw new Error(`expected allow_comment:true`);
	if (out.timeout_sec !== 86400) throw new Error(`timeout_sec mismatch: ${out.timeout_sec}`);
}

async function test_first_invocation_defaults() {
	const { code, stdout } = await invoke({ prompt: 'Proceed with the deployment?' });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (out.allow_comment !== true) throw new Error(`expected default allow_comment:true`);
	if (out.timeout_sec !== 3600) throw new Error(`expected default timeout_sec:3600`);
}

// ── (b) Second invocation: approved decision ───────────────────────────────

async function test_approved_decision_with_comment() {
	const { code, stdout } = await invoke({
		prompt: 'Approve to send?',
		allow_comment: true,
		resume_response: { decision: 'approved', comment: 'Great draft, send it.' },
	});
	if (code !== 0) throw new Error(`expected exit 0 (resumed), got ${code}`);
	const out = parseOut(stdout);
	if (out.decision !== 'approved') throw new Error(`expected decision:approved, got ${out.decision}`);
	if (out.comment !== 'Great draft, send it.') throw new Error(`comment mismatch: ${out.comment}`);
}

async function test_approved_decision_without_comment() {
	const { code, stdout } = await invoke({
		prompt: 'Approve to proceed?',
		resume_response: { decision: 'approved' },
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.decision !== 'approved') throw new Error(`expected approved`);
	if ('comment' in out) throw new Error(`comment should be absent when not provided`);
}

// ── (c) Second invocation: rejected decision with comment ──────────────────

async function test_rejected_decision_with_comment() {
	const { code, stdout } = await invoke({
		prompt: 'Approve the draft?',
		allow_comment: true,
		resume_response: { decision: 'rejected', comment: 'Too long, please trim the intro.' },
	});
	if (code !== 0) throw new Error(`expected exit 0 (rejection is valid), got ${code}`);
	const out = parseOut(stdout);
	if (out.decision !== 'rejected') throw new Error(`expected rejected`);
	if (out.comment !== 'Too long, please trim the intro.') throw new Error(`comment mismatch: ${out.comment}`);
}

// ── (d) allow_comment false strips comment ─────────────────────────────────

async function test_allow_comment_false_strips_comment() {
	const { code, stdout } = await invoke({
		prompt: 'Confirm to delete archive?',
		allow_comment: false,
		resume_response: { decision: 'approved', comment: 'This comment should be stripped.' },
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.decision !== 'approved') throw new Error(`expected approved`);
	if ('comment' in out) throw new Error(`comment should be stripped when allow_comment is false`);
}

async function test_rejected_allow_comment_false() {
	const { code, stdout } = await invoke({
		prompt: 'Gate check.',
		allow_comment: false,
		resume_response: { decision: 'rejected', comment: 'some comment' },
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.decision !== 'rejected') throw new Error(`expected rejected`);
	if ('comment' in out) throw new Error(`comment must be absent when allow_comment is false`);
}

// ── Bad input: missing / empty prompt ──────────────────────────────────────

async function test_missing_prompt_exits_1() {
	const { code, stdout } = await invoke({ allow_comment: false });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field');
}

async function test_empty_prompt_exits_1() {
	const { code, stdout } = await invoke({ prompt: '' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field');
}

// ── Bad input: invalid decision ────────────────────────────────────────────

async function test_invalid_decision_exits_1() {
	const { code, stdout } = await invoke({
		prompt: 'Gate.',
		resume_response: { decision: 'maybe' },
	});
	if (code !== 1) throw new Error(`expected exit 1 for invalid decision, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error) throw new Error('expected error field');
}

async function test_missing_decision_exits_1() {
	const { code, stdout } = await invoke({
		prompt: 'Gate.',
		resume_response: { comment: 'no decision here' },
	});
	if (code !== 1) throw new Error(`expected exit 1 for missing decision, got ${code}`);
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
	['first invocation uses defaults (allow_comment:true, timeout:3600)', test_first_invocation_defaults],
	['approved decision with comment, exits 0', test_approved_decision_with_comment],
	['approved decision without comment', test_approved_decision_without_comment],
	['rejected decision with comment, exits 0 (rejection is valid)', test_rejected_decision_with_comment],
	['allow_comment:false strips comment from approved', test_allow_comment_false_strips_comment],
	['allow_comment:false strips comment from rejected', test_rejected_allow_comment_false],
	['missing prompt exits 1', test_missing_prompt_exits_1],
	['empty prompt exits 1', test_empty_prompt_exits_1],
	['invalid decision value exits 1', test_invalid_decision_exits_1],
	['missing decision in resume_response exits 1', test_missing_decision_exits_1],
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
