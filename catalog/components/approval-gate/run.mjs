#!/usr/bin/env node
/**
 * approval-gate component v1.0.0 — Tier-1 gate capability per ADR-023.
 *
 * Implements the stdout-code-2 pause protocol (see BLOCK.md).
 * First invocation: emits pause-request JSON, exits 2.
 * Second invocation (resume_response present): validates decision, emits
 * {decision, comment?}, exits 0.
 *
 * Ported from runGateStep() at src/lib/naseej/runner.ts:619-677.
 * Exit code 0 on both 'approved' and 'rejected' — rejection is a valid
 * decision, not an error. Downstream steps branch via outputs.decision.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { prompt, allow_comment?, timeout_sec?, resume_response? }
 *   stdout: { pause: true, kind: "gate", prompt, allow_comment, timeout_sec }  (exit 2)
 *         | { decision, comment? }                                              (exit 0)
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
const VALID_DECISIONS = new Set(['approved', 'rejected']);

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

	const { prompt, allow_comment, timeout_sec, resume_response } = payload;

	// Validate prompt on every invocation — required regardless of phase.
	if (typeof prompt !== 'string' || !prompt.trim()) {
		fail('prompt must be a non-empty string');
	}

	// Validate allow_comment when provided.
	const resolvedAllowComment = allow_comment ?? true;
	if (typeof resolvedAllowComment !== 'boolean') {
		fail('allow_comment must be a boolean');
	}

	// Second invocation: resume_response is present — validate and emit decision.
	if (resume_response !== undefined) {
		if (typeof resume_response !== 'object' || resume_response === null || Array.isArray(resume_response)) {
			fail('resume_response must be an object');
		}
		const { decision, comment } = resume_response;
		if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision)) {
			fail(`resume_response.decision must be "approved" or "rejected", got: ${JSON.stringify(decision)}`);
		}

		const output = { decision };
		// Include comment only when allow_comment is true and a non-empty string was provided.
		if (resolvedAllowComment && typeof comment === 'string' && comment.trim()) {
			output.comment = comment;
		}
		emit(output);
		process.exit(EXIT.OK);
	}

	// First invocation: validate optional inputs, emit pause-request, exit 2.
	if (timeout_sec !== undefined) {
		if (typeof timeout_sec !== 'number' || !Number.isInteger(timeout_sec) || timeout_sec <= 0) {
			fail('timeout_sec must be a positive integer');
		}
	}
	const resolvedTimeout = timeout_sec ?? DEFAULT_TIMEOUT_SEC;

	emit({
		pause: true,
		kind: 'gate',
		prompt,
		allow_comment: resolvedAllowComment,
		timeout_sec: resolvedTimeout,
	});
	process.exit(EXIT.PAUSE);
}

main().catch((err) => {
	fail(`unexpected error: ${err.message || err}`);
});
