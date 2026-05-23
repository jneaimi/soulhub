#!/usr/bin/env node
/**
 * Tests for agent-dispatch v1.0.0 (ADR-023 CP1).
 *
 * Uses AGENT_DISPATCH_STUB_PATH to inject tests/fixtures/stub-agents.mjs
 * so every code path exercises without requiring a live soul-hub agent
 * registry or built SvelteKit output.
 *
 * Test matrix:
 *   (a) happy path — success status, exit 0, expected outputs
 *   (b) goal_achieved — exit 0, agent_status: goal_achieved
 *   (c) failed status — exit 1, agent_status: failed, error present
 *   (d) missing agent slug — exit 1, error message
 *   (e) artifact marker extraction — artifact_path populated
 *   (f) bad input (missing task) — exit 2
 *   (g) bad input (invalid JSON) — exit 2
 *   (h) dispatcher throw — exit 1, error captured
 *   (i) cancelled status — exit 1, agent_status: cancelled
 *   (j) context truncation — 5000-char context capped to 4000
 *
 * Run: node test_agent_dispatch.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');
const STUB_PATH = resolve(__dirname, 'fixtures', 'stub-agents.mjs');

function invoke(payload) {
	return new Promise((resolveP) => {
		const proc = spawn('node', [RUN_MJS], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, AGENT_DISPATCH_STUB_PATH: STUB_PATH },
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => resolveP({ code, stdout, stderr }));
		proc.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
	});
}

function parseOut(stdout) {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`stdout was not JSON: ${stdout.slice(0, 400)}`);
	}
}

let passed = 0;
let failed = 0;

async function run(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}: ${err.message}`);
		failed++;
	}
}

// ── (a) Happy path — success ────────────────────────────────────────────────

await run('(a) success: exit 0, output_excerpt, agent_status success', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-success', task: 'Do something useful.' });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout.slice(0, 300)}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 0) throw new Error(`exit_code in JSON should be 0, got ${out.exit_code}`);
	if (out.agent_status !== 'success') throw new Error(`agent_status wrong: ${out.agent_status}`);
	if (typeof out.output_excerpt !== 'string' || out.output_excerpt.length === 0) {
		throw new Error('output_excerpt missing or empty');
	}
	if (typeof out.num_turns !== 'number') throw new Error('num_turns missing');
	if (typeof out.cost_usd !== 'number') throw new Error('cost_usd missing');
	if (out.artifact_path !== undefined) throw new Error('artifact_path should not be set on success');
	if (out.error !== undefined) throw new Error(`error should not be set on success, got: ${out.error}`);
});

// ── (b) goal_achieved — still exit 0 ───────────────────────────────────────

await run('(b) goal_achieved: exit 0, agent_status goal_achieved', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-goal', task: 'Research until done.' });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.agent_status !== 'goal_achieved') throw new Error(`agent_status: ${out.agent_status}`);
	if (out.exit_code !== 0) throw new Error(`exit_code in JSON: ${out.exit_code}`);
});

// ── (c) failed status — exit 1 ─────────────────────────────────────────────

await run('(c) failed: exit 1, agent_status failed, error present', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-failed', task: 'Exceed budget.' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (out.agent_status !== 'failed') throw new Error(`agent_status: ${out.agent_status}`);
	if (out.exit_code !== 1) throw new Error(`exit_code in JSON: ${out.exit_code}`);
	if (typeof out.error !== 'string' || !out.error) throw new Error('error message missing');
});

// ── (d) missing agent slug — exit 1 ────────────────────────────────────────

await run('(d) missing agent: exit 1, error contains agent name', async () => {
	const { code, stdout } = await invoke({ agent: 'nonexistent-agent-xyz', task: 'Do something.' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('nonexistent-agent-xyz')) {
		throw new Error(`error should mention the slug, got: ${out.error}`);
	}
});

// ── (e) artifact marker extraction ─────────────────────────────────────────

await run('(e) artifact marker: artifact_path populated, exit 0', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-artifact', task: 'Write a vault note.' });
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (out.agent_status !== 'success') throw new Error(`agent_status: ${out.agent_status}`);
	if (typeof out.artifact_path !== 'string' || !out.artifact_path.includes('vault')) {
		throw new Error(`artifact_path wrong: ${out.artifact_path}`);
	}
	// artifact path should NOT appear verbatim in output_excerpt (marker stripped from excerpt)
	// — actually the excerpt IS the raw output, the marker is just also there. Just verify path.
	if (!out.artifact_path.includes('stub-result')) {
		throw new Error(`artifact_path content wrong: ${out.artifact_path}`);
	}
});

// ── (f) bad input — missing task ───────────────────────────────────────────

await run('(f) bad input: missing task exits 2', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-success' });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 2) throw new Error(`exit_code in JSON: ${out.exit_code}`);
	if (!out.error || !out.error.toLowerCase().includes('task')) {
		throw new Error(`error should mention 'task', got: ${out.error}`);
	}
});

// ── (g) bad input — invalid JSON ───────────────────────────────────────────

await run('(g) bad input: invalid JSON exits 2', async () => {
	const { code, stdout } = await invoke('not valid json {{{');
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 2) throw new Error(`exit_code in JSON: ${out.exit_code}`);
});

// ── (h) dispatcher throw — exit 1 ──────────────────────────────────────────

await run('(h) dispatcher throw: exit 1, error captured', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-throw', task: 'Trigger crash.' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('dispatcher threw')) {
		throw new Error(`error should mention dispatcher threw, got: ${out.error}`);
	}
});

// ── (i) cancelled status — exit 1 ──────────────────────────────────────────

await run('(i) cancelled: exit 1, agent_status cancelled', async () => {
	const { code, stdout } = await invoke({ agent: 'stub-cancelled', task: 'Should be aborted.' });
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (out.agent_status !== 'cancelled') throw new Error(`agent_status: ${out.agent_status}`);
});

// ── (j) context truncation ──────────────────────────────────────────────────

await run('(j) context truncation: 5000-char context capped, still exits 0', async () => {
	const longContext = 'x'.repeat(5000);
	const { code, stdout } = await invoke({
		agent: 'stub-success',
		task: 'Task with long context.',
		context: longContext,
	});
	// The component caps context internally but doesn't error — exit 0 expected
	if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout.slice(0, 200)}`);
	const out = parseOut(stdout);
	if (out.agent_status !== 'success') throw new Error(`agent_status: ${out.agent_status}`);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
