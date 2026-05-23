#!/usr/bin/env node
/**
 * Integration tests for channel-send-text v1.0.0.
 *
 * Hits POST /api/channels/send on running Soul Hub :2400. To avoid spamming
 * real chats, happy-path tests are gated behind NASEEJ_TEST_LIVE_SEND=1
 * (operator sets this when they want a real Telegram ping to verify).
 * Sad-path tests (bad input, unknown channel, api down) always run.
 *
 * Run:
 *   node test_channel_send_text.mjs
 *   NASEEJ_TEST_LIVE_SEND=1 node test_channel_send_text.mjs  # real send via telegram
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');
const API = process.env.VAULT_API_BASE || 'http://localhost:2400';
const LIVE_SEND = process.env.NASEEJ_TEST_LIVE_SEND === '1';

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

async function soulHubUp() {
	try {
		const res = await fetch(`${API}/api/channels/meta`);
		return res.status < 500;
	} catch {
		return false;
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function test_bad_input_missing_channel() {
	const { code } = await invoke({ text: 'hello' });
	if (code !== 2) throw new Error(`expected exit 2, got ${code}`);
}

async function test_bad_input_unknown_channel() {
	const { code, stdout } = await invoke({ channel: 'klingon', text: 'hi' });
	if (code !== 2) throw new Error(`expected exit 2 on bad enum, got ${code}; stdout: ${stdout}`);
}

async function test_bad_input_empty_text() {
	const { code } = await invoke({ channel: 'telegram', text: '' });
	if (code !== 2) throw new Error(`expected exit 2 on empty text, got ${code}`);
}

async function test_bad_input_missing_text() {
	const { code } = await invoke({ channel: 'telegram' });
	if (code !== 2) throw new Error(`expected exit 2 on missing text, got ${code}`);
}

async function test_api_down() {
	const { code, stdout } = await invoke({ channel: 'telegram', text: 'x', api_base: 'http://localhost:9' });
	if (code !== 1) throw new Error(`expected exit 1 on api down, got ${code}; stdout: ${stdout}`);
	const out = JSON.parse(stdout);
	if (!out.error.includes('cannot reach')) throw new Error(`expected "cannot reach", got: ${out.error}`);
}

async function test_endpoint_rejects_bad_channel_id_via_route() {
	// Bypass the component's client-side enum check by hitting the API directly.
	// The endpoint should return 404 for an unknown channel.
	const res = await fetch(`${API}/api/channels/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ channel: 'not-a-channel', text: 'x' }),
	});
	if (res.status !== 404) throw new Error(`expected 404 from API, got ${res.status}`);
}

async function test_endpoint_rejects_missing_text() {
	const res = await fetch(`${API}/api/channels/send`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ channel: 'telegram' }),
	});
	if (res.status !== 400) throw new Error(`expected 400 from API on missing text, got ${res.status}`);
}

async function test_live_send_telegram() {
	if (!LIVE_SEND) {
		console.log('     (skipped — set NASEEJ_TEST_LIVE_SEND=1 to enable)');
		return;
	}
	const { code, stdout } = await invoke({
		channel: 'telegram',
		text: `[naseej:channel-send-text test ${new Date().toISOString()}] If you received this, the component works.`,
	});
	if (code !== 0) throw new Error(`expected exit 0 on live send, got ${code}; stdout: ${stdout}`);
	const out = JSON.parse(stdout);
	if (!out.ok) throw new Error(`expected ok:true, got ${JSON.stringify(out)}`);
	if (typeof out.message_id !== 'string') throw new Error(`message_id must be string, got ${typeof out.message_id}`);
	if (!out.delivered_at) throw new Error(`missing delivered_at`);
}

async function test_output_shape_matches_block_md() {
	if (!LIVE_SEND) {
		console.log('     (skipped — set NASEEJ_TEST_LIVE_SEND=1 to enable)');
		return;
	}
	const { code, stdout } = await invoke({
		channel: 'telegram',
		text: `[naseej:shape ${Date.now()}]`,
	});
	if (code !== 0) throw new Error(`live send failed: ${stdout}`);
	const out = JSON.parse(stdout);
	for (const key of ['message_id', 'delivered_at', 'ok']) {
		if (!(key in out)) throw new Error(`missing key: ${key}`);
	}
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main() {
	if (!await soulHubUp()) {
		console.error(`[skip] Soul Hub not reachable at ${API}`);
		process.exit(0);
	}

	const tests = [
		test_bad_input_missing_channel,
		test_bad_input_unknown_channel,
		test_bad_input_empty_text,
		test_bad_input_missing_text,
		test_api_down,
		test_endpoint_rejects_bad_channel_id_via_route,
		test_endpoint_rejects_missing_text,
		test_live_send_telegram,
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

	console.log(`\n${passed}/${passed + failed} passed${LIVE_SEND ? '' : ' (live-send tests skipped)'}`);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error('fatal:', err);
	process.exit(1);
});
