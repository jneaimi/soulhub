#!/usr/bin/env node
/**
 * channel-send-text component v1.0.0 — send a text message via a channel adapter.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { channel, text, api_base? }
 *   stdout: { message_id, delivered_at, ok }
 *   exit:   0 success | 1 api down | 2 bad input | 4 unknown channel | 5 adapter refused
 *
 * Wraps POST /api/channels/send (added with this component). Node 18+ for
 * built-in fetch. ESM. No external deps.
 */

const EXIT = {
	OK: 0,
	API_DOWN: 1,
	BAD_INPUT: 2,
	UNKNOWN_CHANNEL: 4,
	ADAPTER_REFUSED: 5,
};

const ALLOWED_CHANNELS = new Set(['telegram', 'whatsapp']);

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, msg, extra = {}) {
	emit({ error: msg, ...extra });
	process.exit(code);
}

async function readStdin() {
	return new Promise((resolve, reject) => {
		let buf = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => { buf += chunk; });
		process.stdin.on('end', () => resolve(buf));
		process.stdin.on('error', reject);
	});
}

async function main() {
	let raw;
	try {
		raw = await readStdin();
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin read failed: ${err.message}`);
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin is not valid JSON: ${err.message}`);
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}

	const { channel, text, api_base = 'http://localhost:2400' } = payload;

	if (typeof channel !== 'string' || !ALLOWED_CHANNELS.has(channel)) {
		fail(EXIT.BAD_INPUT, `channel must be one of: ${Array.from(ALLOWED_CHANNELS).join(', ')}`);
	}
	if (typeof text !== 'string' || !text) {
		fail(EXIT.BAD_INPUT, 'text must be a non-empty string');
	}

	const api = String(api_base).replace(/\/$/, '');
	let res;
	try {
		res = await fetch(`${api}/api/channels/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ channel, text }),
		});
	} catch (err) {
		fail(EXIT.API_DOWN, `cannot reach ${api}: ${err.message}`);
	}

	let body;
	try {
		body = await res.json();
	} catch {
		fail(EXIT.ADAPTER_REFUSED, `non-JSON response from /api/channels/send`, { status: res.status });
	}

	if (res.status === 200 && body.ok) {
		emit({
			message_id: body.message_id ?? '',
			delivered_at: body.delivered_at ?? new Date().toISOString(),
			ok: true,
		});
		process.exit(EXIT.OK);
	}

	if (res.status === 404) {
		fail(EXIT.UNKNOWN_CHANNEL, body.error || `unknown channel: ${channel}`, { status: res.status });
	}

	fail(EXIT.ADAPTER_REFUSED, body.error || `send refused (status ${res.status})`, { status: res.status });
}

main().catch((err) => {
	fail(EXIT.BAD_INPUT, `unexpected error: ${err.message || err}`);
});
