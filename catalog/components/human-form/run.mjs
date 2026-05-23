#!/usr/bin/env node
/**
 * human-form component v1.0.0 — Tier-1 gate capability per ADR-023.
 *
 * Implements the stdout-code-2 pause protocol (see BLOCK.md).
 * First invocation: emits pause-request JSON, exits 2.
 * Second invocation (resume_response present): echoes response, exits 0.
 *
 * Ported from runHumanStep() at src/lib/naseej/runner.ts:564-617.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { prompt, fields?, timeout_sec?, resume_response? }
 *   stdout: { pause: true, kind: "human", prompt, fields, timeout_sec }  (exit 2)
 *         | { response: <object> }                                        (exit 0)
 *   exit:  0 resume path | 1 bad input | 2 first invocation (pause)
 *
 * ESM, Node 18+. No external deps.
 */

const EXIT = {
	OK: 0,
	BAD_INPUT: 1,
	PAUSE: 2,
};

const DEFAULT_TIMEOUT_SEC = 3600;

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(message) {
	emit({ error: message });
	process.exit(EXIT.BAD_INPUT);
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

function validateField(field, index) {
	if (typeof field !== 'object' || field === null || Array.isArray(field)) {
		fail(`fields[${index}] must be an object`);
	}
	if (typeof field.name !== 'string' || !field.name.trim()) {
		fail(`fields[${index}].name must be a non-empty string`);
	}
	if (typeof field.type !== 'string' || !field.type.trim()) {
		fail(`fields[${index}].type must be a non-empty string`);
	}
	if (field.label !== undefined && typeof field.label !== 'string') {
		fail(`fields[${index}].label must be a string`);
	}
	if (field.required !== undefined && typeof field.required !== 'boolean') {
		fail(`fields[${index}].required must be a boolean`);
	}
	if (field.options !== undefined) {
		if (!Array.isArray(field.options) || field.options.some((o) => typeof o !== 'string')) {
			fail(`fields[${index}].options must be an array of strings`);
		}
	}
}

async function main() {
	const raw = await readStdin();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(`stdin is not valid JSON: ${err.message}`);
	}

	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail('stdin JSON must be an object');
	}

	const { prompt, fields, timeout_sec, resume_response } = payload;

	// Validate prompt on every invocation — required regardless of phase.
	if (typeof prompt !== 'string' || !prompt.trim()) {
		fail('prompt must be a non-empty string');
	}

	// Second invocation: resume_response is present — emit final output and exit 0.
	if (resume_response !== undefined) {
		if (typeof resume_response !== 'object' || resume_response === null || Array.isArray(resume_response)) {
			fail('resume_response must be an object');
		}
		emit({ response: resume_response });
		process.exit(EXIT.OK);
	}

	// First invocation: validate optional inputs, emit pause-request, exit 2.
	const resolvedFields = fields ?? [];
	if (!Array.isArray(resolvedFields)) {
		fail('fields must be an array');
	}
	resolvedFields.forEach((f, i) => validateField(f, i));

	if (timeout_sec !== undefined) {
		if (typeof timeout_sec !== 'number' || !Number.isInteger(timeout_sec) || timeout_sec <= 0) {
			fail('timeout_sec must be a positive integer');
		}
	}
	const resolvedTimeout = timeout_sec ?? DEFAULT_TIMEOUT_SEC;

	emit({
		pause: true,
		kind: 'human',
		prompt,
		fields: resolvedFields,
		timeout_sec: resolvedTimeout,
	});
	process.exit(EXIT.PAUSE);
}

main().catch((err) => {
	fail(`unexpected error: ${err.message || err}`);
});
