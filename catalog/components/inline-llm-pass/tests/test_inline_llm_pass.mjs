#!/usr/bin/env node
/**
 * Tests for inline-llm-pass v1.0.0 (ADR-022 CP1).
 *
 * Uses tests/fixtures/claude-stub/claude as the `claude` binary so we exercise
 * every code path of run.mjs without making live API calls. The stub is a
 * PEP-723 Python script that mimics the real `claude -p --output-format=json`
 * shape and branches behaviour on the prompt's leading sentinel.
 *
 * Run: node test_inline_llm_pass.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');
const STUB = resolve(__dirname, 'fixtures', 'claude-stub', 'claude');

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
		throw new Error(`stdout was not JSON: ${stdout.slice(0, 300)}`);
	}
}

// ── Happy path ─────────────────────────────────────────────────────────────

async function test_basic_prompt_returns_text() {
	const { code, stdout } = await invoke({
		prompt: 'OK: rewrite this sentence',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout.slice(0, 200)}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 0) throw new Error(`expected outputs.exit_code 0, got ${out.exit_code}`);
	if (!out.text.startsWith('OK:')) throw new Error(`expected echoed prompt, got: ${out.text.slice(0, 80)}`);
	if (out.cost_usd !== 0.0015) throw new Error(`expected cost_usd 0.0015, got ${out.cost_usd}`);
	if (out.num_turns !== 1) throw new Error(`expected num_turns 1, got ${out.num_turns}`);
	if (typeof out.duration_ms !== 'number') throw new Error('duration_ms missing');
}

async function test_input_text_appended_to_prompt() {
	const { code, stdout } = await invoke({
		prompt: 'rewrite the input',
		input_text: 'original content to operate on',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	// Default (non-sentinel) path echoes the full composed prompt back as result.
	if (!out.text.includes('original content to operate on')) {
		throw new Error(`input_text not appended; result: ${out.text.slice(0, 200)}`);
	}
	if (!out.text.includes('# Input')) {
		throw new Error(`expected '# Input' delimiter in composed prompt; result: ${out.text.slice(0, 200)}`);
	}
}

async function test_model_override_honored() {
	const { code, stdout } = await invoke({
		prompt: 'MODEL: echo the model',
		model: 'claude-haiku-4-5-20251001',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.text.includes('claude-haiku-4-5-20251001')) {
		throw new Error(`model not propagated; result: ${out.text}`);
	}
	if (out.model_used !== 'claude-haiku-4-5-20251001') {
		throw new Error(`model_used wrong; got: ${out.model_used}`);
	}
}

async function test_system_prompt_propagated() {
	const { code, stdout } = await invoke({
		prompt: 'SYS: echo the system prompt',
		system_prompt: 'You are a copy editor.',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.text.includes('You are a copy editor.')) {
		throw new Error(`system_prompt not propagated; result: ${out.text}`);
	}
}

// ── Sad path ───────────────────────────────────────────────────────────────

async function test_missing_prompt_rejected() {
	const { code, stdout } = await invoke({ claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2 (bad input), got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('prompt')) {
		throw new Error(`expected error mentioning prompt; got: ${out.error}`);
	}
}

async function test_empty_prompt_rejected() {
	const { code, stdout } = await invoke({ prompt: '   ', claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2 (bad input), got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('non-empty')) {
		throw new Error(`expected non-empty error; got: ${out.error}`);
	}
}

async function test_invalid_budget_rejected() {
	const { code } = await invoke({ prompt: 'OK: x', budget_seconds: -5, claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
}

async function test_cli_is_error_surfaced_as_exit_1() {
	const { code, stdout } = await invoke({
		prompt: 'ERROR: content filter case',
		claude_binary: STUB,
	});
	if (code !== 1) throw new Error(`expected exit 1 (cli error), got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 1) throw new Error(`expected outputs.exit_code 1, got ${out.exit_code}`);
	if (!out.text.includes('content filter')) {
		throw new Error(`expected envelope result echoed in text; got: ${out.text}`);
	}
}

async function test_cli_hard_exit_surfaced_as_exit_1() {
	const { code, stdout } = await invoke({
		prompt: 'EXIT1: hard fail',
		claude_binary: STUB,
	});
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (out.exit_code !== 1) throw new Error(`expected outputs.exit_code 1, got ${out.exit_code}`);
}

async function test_garbage_envelope_surfaced_as_exit_1() {
	const { code, stdout } = await invoke({
		prompt: 'GARBAGE: not json',
		claude_binary: STUB,
	});
	if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('parse')) {
		throw new Error(`expected parse-failure error; got: ${out.error}`);
	}
}

async function test_timeout_fires() {
	const startedAt = Date.now();
	const { code, stdout } = await invoke({
		prompt: 'SLOW: should be killed',
		budget_seconds: 1,
		claude_binary: STUB,
	});
	const elapsed = Date.now() - startedAt;
	if (code !== 124) throw new Error(`expected exit 124, got ${code}`);
	if (elapsed > 8000) throw new Error(`took too long (${elapsed}ms); SIGTERM/SIGKILL didn't fire`);
	const out = parseOut(stdout);
	if (out.timed_out !== true) throw new Error('timed_out flag not set');
}

async function test_invalid_claude_binary_rejected() {
	const { code, stdout } = await invoke({
		prompt: 'OK: x',
		claude_binary: 'not-absolute',
	});
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('absolute path')) {
		throw new Error(`expected absolute-path error; got: ${out.error}`);
	}
}

async function test_cost_strip_flags_passed() {
	const { code, stdout } = await invoke({
		prompt: 'FLAGS: echo flag state',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	for (const want of ['tools=', "setting-sources=", 'no-session-persistence=true', 'exclude-dynamic=true']) {
		if (!out.text.includes(want)) {
			throw new Error(`missing flag ${want} in response; got: ${out.text}`);
		}
	}
}

async function test_max_budget_usd_passed() {
	const { code, stdout } = await invoke({
		prompt: 'BUDGET: echo budget',
		max_budget_usd: 0.25,
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.text.includes('0.25')) {
		throw new Error(`max_budget_usd not propagated; got: ${out.text}`);
	}
}

async function test_invalid_max_budget_rejected() {
	const { code } = await invoke({ prompt: 'OK: x', max_budget_usd: -1, claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
}

async function test_json_schema_passed() {
	const { code, stdout } = await invoke({
		prompt: 'SCHEMA: echo schema',
		json_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!/json-schema-len=\d+/.test(out.text)) {
		throw new Error(`json_schema not propagated; got: ${out.text}`);
	}
}

async function test_invalid_json_schema_rejected() {
	const { code } = await invoke({ prompt: 'OK: x', json_schema: 'not-an-object', claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
}

async function test_input_text_path_read_from_disk() {
	const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	const dir = await mkdtemp(join(tmpdir(), 'inline-llm-pass-test-'));
	try {
		const filePath = join(dir, 'big-input.txt');
		const bigContent = 'X'.repeat(50_000) + ' SENTINEL_FROM_FILE';
		await writeFile(filePath, bigContent);
		const { code, stdout } = await invoke({
			prompt: 'rewrite the input',
			input_text_path: filePath,
			claude_binary: STUB,
		});
		if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
		const out = parseOut(stdout);
		if (!out.text.includes('SENTINEL_FROM_FILE')) {
			throw new Error(`file content not read; result didn't include sentinel`);
		}
		if (out.text.length < 40_000) {
			throw new Error(`file content truncated; got ${out.text.length} chars, expected ~50k+`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function test_input_text_path_invalid_rejected() {
	const { code } = await invoke({ prompt: 'OK: x', input_text_path: 'not-absolute', claude_binary: STUB });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
}

async function test_input_text_and_path_mutually_exclusive() {
	const { code, stdout } = await invoke({
		prompt: 'OK: x',
		input_text: 'inline',
		input_text_path: '/tmp/somefile.txt',
		claude_binary: STUB,
	});
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('mutually exclusive')) {
		throw new Error(`expected mutually-exclusive error; got: ${out.error}`);
	}
}

// ── Session mode (ADR-028) ───────────────────────────────────────────────────

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function test_session_start_passes_session_id() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: echo session flags',
		session_action: 'start',
		session_id: VALID_UUID,
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout.slice(0, 200)}`);
	const out = parseOut(stdout);
	if (!out.text.includes(`session-id=${VALID_UUID}`)) {
		throw new Error(`--session-id not passed; got: ${out.text}`);
	}
	if (!out.text.includes('resume=None')) throw new Error(`should not pass --resume on start; got: ${out.text}`);
	if (!out.text.includes('persist-disabled=False')) {
		throw new Error(`session mode must drop --no-session-persistence; got: ${out.text}`);
	}
	if (out.session_id !== VALID_UUID) throw new Error(`expected outputs.session_id ${VALID_UUID}, got ${out.session_id}`);
}

async function test_session_start_generates_uuid() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: echo session flags',
		session_action: 'start',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.session_id || !UUID_RE.test(out.session_id)) {
		throw new Error(`expected a generated UUID in outputs.session_id, got: ${out.session_id}`);
	}
	if (!out.text.includes(`session-id=${out.session_id}`)) {
		throw new Error(`generated UUID not passed as --session-id; got: ${out.text}`);
	}
}

async function test_session_continue_passes_resume() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: echo session flags',
		session_action: 'continue',
		session_id: VALID_UUID,
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.text.includes(`resume=${VALID_UUID}`)) {
		throw new Error(`--resume not passed on continue; got: ${out.text}`);
	}
	if (!out.text.includes('session-id=None')) {
		throw new Error(`continue should use --resume, not --session-id; got: ${out.text}`);
	}
	if (out.session_id !== VALID_UUID) throw new Error(`expected outputs.session_id ${VALID_UUID}, got ${out.session_id}`);
}

async function test_session_continue_requires_session_id() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: x',
		session_action: 'continue',
		claude_binary: STUB,
	});
	if (code !== 2) throw new Error(`expected exit 2 (bad input), got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('session_id')) {
		throw new Error(`expected error mentioning session_id; got: ${out.error}`);
	}
}

async function test_invalid_session_action_rejected() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: x',
		session_action: 'bogus',
		claude_binary: STUB,
	});
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('session_action')) {
		throw new Error(`expected session_action error; got: ${out.error}`);
	}
}

async function test_session_id_without_action_rejected() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: x',
		session_id: VALID_UUID,
		claude_binary: STUB,
	});
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('session_action')) {
		throw new Error(`expected error requiring session_action; got: ${out.error}`);
	}
}

async function test_invalid_session_id_rejected() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: x',
		session_action: 'start',
		session_id: 'not-a-uuid',
		claude_binary: STUB,
	});
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
	const out = parseOut(stdout);
	if (!out.error || !out.error.includes('UUID')) {
		throw new Error(`expected UUID error; got: ${out.error}`);
	}
}

async function test_stateless_omits_session_and_no_session_id_output() {
	const { code, stdout } = await invoke({
		prompt: 'SESSION: echo session flags',
		claude_binary: STUB,
	});
	if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
	const out = parseOut(stdout);
	if (!out.text.includes('session-id=None') || !out.text.includes('resume=None')) {
		throw new Error(`stateless must pass neither session flag; got: ${out.text}`);
	}
	if (!out.text.includes('persist-disabled=True')) {
		throw new Error(`stateless must keep --no-session-persistence; got: ${out.text}`);
	}
	if ('session_id' in out) throw new Error(`stateless output must not include session_id; got: ${out.session_id}`);
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
	test_basic_prompt_returns_text,
	test_input_text_appended_to_prompt,
	test_model_override_honored,
	test_system_prompt_propagated,
	test_missing_prompt_rejected,
	test_empty_prompt_rejected,
	test_invalid_budget_rejected,
	test_cli_is_error_surfaced_as_exit_1,
	test_cli_hard_exit_surfaced_as_exit_1,
	test_garbage_envelope_surfaced_as_exit_1,
	test_timeout_fires,
	test_invalid_claude_binary_rejected,
	test_cost_strip_flags_passed,
	test_max_budget_usd_passed,
	test_invalid_max_budget_rejected,
	test_json_schema_passed,
	test_invalid_json_schema_rejected,
	test_input_text_path_read_from_disk,
	test_input_text_path_invalid_rejected,
	test_input_text_and_path_mutually_exclusive,
	test_session_start_passes_session_id,
	test_session_start_generates_uuid,
	test_session_continue_passes_resume,
	test_session_continue_requires_session_id,
	test_invalid_session_action_rejected,
	test_session_id_without_action_rejected,
	test_invalid_session_id_rejected,
	test_stateless_omits_session_and_no_session_id_output,
];

let passed = 0;
let failed = 0;
const failures = [];

for (const test of tests) {
	try {
		await test();
		console.log(`  ✓ ${test.name}`);
		passed++;
	} catch (err) {
		console.error(`  ✗ ${test.name}: ${err.message}`);
		failures.push({ name: test.name, message: err.message });
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed of ${tests.length}`);
if (failed > 0) {
	console.error(`\nFailures:`);
	for (const f of failures) {
		console.error(`  - ${f.name}: ${f.message}`);
	}
	process.exit(1);
}
process.exit(0);
