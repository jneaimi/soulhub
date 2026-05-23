#!/usr/bin/env node
/**
 * shell-exec component v1.0.0 — Tier-1 capability per ADR-006 D7.
 *
 * Runs an arbitrary subprocess via `child_process.spawn` (no shell), captures
 * stdout/stderr with optional file redirection, enforces a wall-clock timeout,
 * and surfaces the wrapped command's exit code via both `outputs.exit_code`
 * and the component's own exit code (so the Naseej runner's halt-on-non-zero
 * fires when the wrapped command fails).
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { cmd, args?, cwd?, stdin?, env?, timeout_sec?, stdout_to_file?, stderr_to_file? }
 *   stdout: { exit_code, stdout, stderr, stdout_path?, stderr_path?, duration_ms, timed_out? }
 *   exit:   0 ok | 2 bad input | 124 timeout | 126 spawn fail | 1-255 cmd's own exit
 *
 * ESM, Node 18+. No external deps.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const EXIT = {
	OK: 0,
	BAD_INPUT: 2,
	TIMEOUT: 124,
	SPAWN_FAIL: 126,
};

/** 10KB inline cap on stdout/stderr captured into outputs. Full payload still
 *  lands at stdout_path/stderr_path when stdout_to_file/stderr_to_file is set. */
const INLINE_CAP_BYTES = 10 * 1024;

/** Grace period between SIGTERM and SIGKILL when the wall-clock timeout fires. */
const KILL_GRACE_MS = 5_000;

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, message, extra = {}) {
	emit({ error: message, ...extra });
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

function truncate(buf) {
	const s = buf.toString('utf-8');
	if (s.length <= INLINE_CAP_BYTES) return s;
	const dropped = s.length - INLINE_CAP_BYTES;
	return s.slice(0, INLINE_CAP_BYTES) + `\n... [truncated, ${dropped} more bytes]`;
}

function validateInputs(payload) {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}
	const { cmd, args, cwd, stdin: stdinText, env, timeout_sec, stdout_to_file, stderr_to_file } = payload;

	if (typeof cmd !== 'string' || !cmd.trim()) {
		fail(EXIT.BAD_INPUT, 'cmd must be a non-empty string');
	}
	if (args !== undefined) {
		if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
			fail(EXIT.BAD_INPUT, 'args must be an array of strings');
		}
	}
	if (cwd !== undefined && typeof cwd !== 'string') {
		fail(EXIT.BAD_INPUT, 'cwd must be a string');
	}
	if (stdinText !== undefined && typeof stdinText !== 'string') {
		fail(EXIT.BAD_INPUT, 'stdin must be a string');
	}
	if (env !== undefined) {
		if (typeof env !== 'object' || env === null || Array.isArray(env)) {
			fail(EXIT.BAD_INPUT, 'env must be an object of string→string');
		}
		for (const [k, v] of Object.entries(env)) {
			if (typeof v !== 'string') {
				fail(EXIT.BAD_INPUT, `env.${k} must be a string`);
			}
		}
	}
	if (timeout_sec !== undefined) {
		if (typeof timeout_sec !== 'number' || !Number.isInteger(timeout_sec) || timeout_sec <= 0) {
			fail(EXIT.BAD_INPUT, 'timeout_sec must be a positive integer');
		}
	}
	if (stdout_to_file !== undefined) {
		if (typeof stdout_to_file !== 'string' || !isAbsolute(stdout_to_file)) {
			fail(EXIT.BAD_INPUT, 'stdout_to_file must be an absolute path');
		}
	}
	if (stderr_to_file !== undefined) {
		if (typeof stderr_to_file !== 'string' || !isAbsolute(stderr_to_file)) {
			fail(EXIT.BAD_INPUT, 'stderr_to_file must be an absolute path');
		}
	}
	return { cmd, args: args ?? [], cwd, stdinText: stdinText ?? '', env, timeout_sec: timeout_sec ?? 60, stdout_to_file, stderr_to_file };
}

async function main() {
	const raw = await readStdin();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin is not valid JSON: ${err.message}`);
	}

	const { cmd, args, cwd, stdinText, env, timeout_sec, stdout_to_file, stderr_to_file } = validateInputs(payload);
	const mergedEnv = env ? { ...process.env, ...env } : process.env;
	const startedAt = Date.now();

	const stdoutChunks = [];
	const stderrChunks = [];
	let timedOut = false;
	let spawnFailed = false;
	let spawnErrorMsg = '';

	const proc = spawn(cmd, args, {
		cwd: cwd || process.cwd(),
		env: mergedEnv,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		try { proc.kill('SIGTERM'); } catch { /* ignore */ }
		setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* ignore */ }
		}, KILL_GRACE_MS);
	}, timeout_sec * 1000);

	proc.stdout.on('data', (d) => stdoutChunks.push(d));
	proc.stderr.on('data', (d) => stderrChunks.push(d));
	proc.on('error', (err) => {
		spawnFailed = true;
		spawnErrorMsg = err.message;
	});

	try {
		proc.stdin.end(stdinText);
	} catch (err) {
		// EPIPE if the subprocess exits before we finish writing — harmless.
		if (err.code !== 'EPIPE') throw err;
	}

	const exitCode = await new Promise((resolveP) => {
		proc.on('close', (code) => {
			clearTimeout(timeoutHandle);
			resolveP(code ?? -1);
		});
	});

	const durationMs = Date.now() - startedAt;
	const stdoutFull = Buffer.concat(stdoutChunks);
	const stderrFull = Buffer.concat(stderrChunks);

	// Optional file redirection — fail loudly if write fails (recipe is depending on the path).
	let stdoutPath;
	let stderrPath;
	if (stdout_to_file) {
		try {
			await writeFile(stdout_to_file, stdoutFull);
			stdoutPath = stdout_to_file;
		} catch (err) {
			fail(EXIT.BAD_INPUT, `stdout_to_file write failed: ${err.message}`, { path: stdout_to_file });
		}
	}
	if (stderr_to_file) {
		try {
			await writeFile(stderr_to_file, stderrFull);
			stderrPath = stderr_to_file;
		} catch (err) {
			fail(EXIT.BAD_INPUT, `stderr_to_file write failed: ${err.message}`, { path: stderr_to_file });
		}
	}

	let resolvedExitCode = exitCode;
	if (spawnFailed) {
		resolvedExitCode = EXIT.SPAWN_FAIL;
	} else if (timedOut) {
		resolvedExitCode = EXIT.TIMEOUT;
	}

	const outputs = {
		exit_code: resolvedExitCode,
		stdout: truncate(stdoutFull),
		stderr: spawnFailed ? `[spawn error] ${spawnErrorMsg}\n${truncate(stderrFull)}` : truncate(stderrFull),
		duration_ms: durationMs,
	};
	if (stdoutPath) outputs.stdout_path = stdoutPath;
	if (stderrPath) outputs.stderr_path = stderrPath;
	if (timedOut) outputs.timed_out = true;

	emit(outputs);
	// Component exit code mirrors the wrapped command's exit so the Naseej
	// runner's halt-on-non-zero fires correctly. Values outside 0-255 are
	// clamped by Node — already in range for our cases.
	process.exit(resolvedExitCode);
}

main().catch((err) => {
	fail(EXIT.BAD_INPUT, `unexpected error: ${err.message || err}`);
});
