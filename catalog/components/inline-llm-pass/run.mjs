#!/usr/bin/env node
/**
 * inline-llm-pass component v1.0.0 — Tier-1 capability per ADR-022.
 *
 * Runs a single-purpose LLM call via `claude -p --output-format=json`. No
 * agent definition, no `/goal` loop — pure prompt-in/text-out. The
 * decomposition primitive for ADR-022's peer-brief v2 shadow.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { prompt, input_text?, model?, system_prompt?, budget_seconds?, claude_binary?,
 *             session_id?, session_action? }
 *   stdout: { text, exit_code, duration_ms, cost_usd, num_turns, model_used?, timed_out?, session_id? }
 *   exit:   0 ok | 1 cli error | 2 bad input | 124 timeout
 *
 * Session mode (ADR-028 Phase 1): when `session_action` is set the call joins a
 * persistent claude conversation instead of running stateless.
 *   - 'start':    drop --no-session-persistence, pass --session-id <uuid>
 *                 (generated if session_id absent), return session_id in outputs.
 *   - 'continue': pass --resume <session_id> (required) to carry prior context.
 *   - absent:     stateless path, unchanged (--no-session-persistence kept).
 * A session chain MUST use the same `cwd` across steps — claude keys sessions
 * by project dir, so a mismatched cwd makes --resume miss the session.
 *
 * ESM, Node 18+. No external deps.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

/** RFC-4122 UUID shape — `claude --session-id` requires a valid UUID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ACTIONS = new Set(['start', 'continue']);

const EXIT = {
	OK: 0,
	CLI_ERROR: 1,
	BAD_INPUT: 2,
	TIMEOUT: 124,
};

const KILL_GRACE_MS = 5_000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_BUDGET_SEC = 120;
/** Default cwd is a clean temp dir — avoids inheriting the calling process's
 *  CLAUDE.md context, which would auto-load into every `claude -p` call and
 *  10× the per-call cost. Empirically measured 2026-05-19: soul-hub cwd =
 *  $0.159/PONG; /tmp = $0.066; clean dir + setting-sources "" +
 *  exclude-dynamic-system-prompt-sections = $0.015. */
const DEFAULT_CWD = '/tmp';

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, message, extra = {}) {
	emit({ error: message, exit_code: code, ...extra });
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

function validateInputs(payload) {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}
	const { prompt, input_text, input_text_path, model, system_prompt, budget_seconds, claude_binary, cwd, max_budget_usd, json_schema, session_id, session_action } = payload;

	if (typeof prompt !== 'string' || !prompt.trim()) {
		fail(EXIT.BAD_INPUT, 'prompt must be a non-empty string');
	}
	if (input_text !== undefined && typeof input_text !== 'string') {
		fail(EXIT.BAD_INPUT, 'input_text must be a string');
	}
	if (input_text_path !== undefined) {
		if (typeof input_text_path !== 'string' || !isAbsolute(input_text_path)) {
			fail(EXIT.BAD_INPUT, 'input_text_path must be an absolute path');
		}
	}
	if (input_text !== undefined && input_text_path !== undefined && input_text && input_text_path) {
		fail(EXIT.BAD_INPUT, 'input_text and input_text_path are mutually exclusive');
	}
	if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
		fail(EXIT.BAD_INPUT, 'model must be a non-empty string');
	}
	if (system_prompt !== undefined && typeof system_prompt !== 'string') {
		fail(EXIT.BAD_INPUT, 'system_prompt must be a string');
	}
	if (budget_seconds !== undefined) {
		if (typeof budget_seconds !== 'number' || !Number.isInteger(budget_seconds) || budget_seconds <= 0) {
			fail(EXIT.BAD_INPUT, 'budget_seconds must be a positive integer');
		}
	}
	if (claude_binary !== undefined) {
		if (typeof claude_binary !== 'string' || !isAbsolute(claude_binary)) {
			fail(EXIT.BAD_INPUT, 'claude_binary must be an absolute path');
		}
	}
	if (cwd !== undefined) {
		if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
			fail(EXIT.BAD_INPUT, 'cwd must be an absolute path');
		}
	}
	if (max_budget_usd !== undefined) {
		if (typeof max_budget_usd !== 'number' || max_budget_usd <= 0) {
			fail(EXIT.BAD_INPUT, 'max_budget_usd must be a positive number');
		}
	}
	if (json_schema !== undefined) {
		if (typeof json_schema !== 'object' || json_schema === null || Array.isArray(json_schema)) {
			fail(EXIT.BAD_INPUT, 'json_schema must be a JSON Schema object');
		}
	}
	// ── Session mode (ADR-028) ──────────────────────────────────────────────
	if (session_action !== undefined && !SESSION_ACTIONS.has(session_action)) {
		fail(EXIT.BAD_INPUT, "session_action must be 'start' or 'continue'");
	}
	if (session_id !== undefined) {
		if (typeof session_id !== 'string' || !UUID_RE.test(session_id)) {
			fail(EXIT.BAD_INPUT, 'session_id must be a valid UUID');
		}
		if (session_action === undefined) {
			fail(EXIT.BAD_INPUT, 'session_id requires session_action (start | continue)');
		}
	}
	if (session_action === 'continue' && !session_id) {
		fail(EXIT.BAD_INPUT, "session_action 'continue' requires session_id");
	}
	return {
		prompt,
		input_text: input_text ?? '',
		input_text_path: input_text_path ?? undefined,
		model: model ?? DEFAULT_MODEL,
		system_prompt: system_prompt ?? '',
		budget_seconds: budget_seconds ?? DEFAULT_BUDGET_SEC,
		claude_binary: claude_binary ?? 'claude',
		cwd: cwd ?? DEFAULT_CWD,
		max_budget_usd,
		json_schema,
		session_id,
		session_action,
	};
}

function composePrompt(prompt, inputText) {
	if (!inputText) return prompt;
	return `${prompt}\n\n---\n\n# Input\n\n${inputText}`;
}

async function main() {
	const raw = await readStdin();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin is not valid JSON: ${err.message}`);
	}

	const { prompt, input_text, input_text_path, model, system_prompt, budget_seconds, claude_binary, cwd, max_budget_usd, json_schema, session_id, session_action } = validateInputs(payload);
	// If input_text_path is set, read the file from disk. This is the escape
	// hatch when upstream shell-exec's `outputs.stdout` would otherwise
	// truncate inline at 10 KB (the runner's INLINE_CAP_BYTES). Pair with
	// upstream step's `stdout_to_file` and pass `outputs.stdout_path` here.
	let resolvedInputText = input_text;
	if (input_text_path) {
		try {
			resolvedInputText = await readFile(input_text_path, 'utf-8');
		} catch (err) {
			fail(EXIT.BAD_INPUT, `input_text_path read failed: ${err.message}`, { path: input_text_path });
		}
	}
	const composedPrompt = composePrompt(prompt, resolvedInputText);
	const startedAt = Date.now();

	// Cost-stripping flags (hardcoded, not exposed): skip all setting sources
	// so project + local CLAUDE.md don't auto-load; move per-machine sections
	// (cwd, env info, memory paths, git status) out of the system prompt to
	// reduce token count + improve cache reuse; disable tools (we never call
	// any) so tool definitions don't ride in the system prompt.
	// Empirically measured 91% per-call cost reduction (2026-05-19 +
	// 2026-05-19 follow-up). Recipe authors get this for free.
	const args = [
		'-p', composedPrompt,
		'--output-format', 'json',
		'--model', model,
		'--dangerously-skip-permissions',
		'--setting-sources', '',
		'--exclude-dynamic-system-prompt-sections',
		'--tools', '',
	];
	// Session mode (ADR-028). `start` opens/uses a named session; `continue`
	// resumes it carrying prior turns' context. Stateless mode keeps
	// --no-session-persistence (no session JSON on disk) for the cost-strip
	// win; session mode MUST drop it so the conversation is resumable.
	let resolvedSessionId = session_id;
	if (session_action === 'start') {
		resolvedSessionId = session_id ?? randomUUID();
		args.push('--session-id', resolvedSessionId);
	} else if (session_action === 'continue') {
		args.push('--resume', resolvedSessionId);
	} else {
		args.push('--no-session-persistence');
	}
	if (system_prompt) {
		args.push('--append-system-prompt', system_prompt);
	}
	if (max_budget_usd !== undefined) {
		args.push('--max-budget-usd', String(max_budget_usd));
	}
	if (json_schema !== undefined) {
		args.push('--json-schema', JSON.stringify(json_schema));
	}

	let stdout = '';
	let stderr = '';
	let timedOut = false;
	let spawnFailed = false;
	let spawnErrorMsg = '';

	const proc = spawn(claude_binary, args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, CLAUDE_CODE_DISABLE_HOOKS: '1' },
	});

	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		try { proc.kill('SIGTERM'); } catch { /* ignore */ }
		setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* ignore */ }
		}, KILL_GRACE_MS);
	}, budget_seconds * 1000);

	proc.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
	proc.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
	proc.on('error', (err) => {
		spawnFailed = true;
		spawnErrorMsg = err.message;
	});

	const cliExitCode = await new Promise((resolveP) => {
		proc.on('close', (code) => {
			clearTimeout(timeoutHandle);
			resolveP(code ?? -1);
		});
	});

	const durationMs = Date.now() - startedAt;

	if (spawnFailed) {
		fail(EXIT.CLI_ERROR, `claude spawn failed: ${spawnErrorMsg}`, { duration_ms: durationMs });
	}
	if (timedOut) {
		emit({
			text: stdout.trim().slice(0, 2000),
			exit_code: EXIT.TIMEOUT,
			duration_ms: durationMs,
			cost_usd: 0,
			num_turns: 0,
			timed_out: true,
			error: `inline-llm-pass exceeded ${budget_seconds}s budget`,
		});
		process.exit(EXIT.TIMEOUT);
	}

	// Parse the envelope. `claude -p --output-format=json` emits one JSON object
	// at the end of the run with { result, is_error, num_turns, total_cost_usd, ... }
	let envelope = null;
	try {
		envelope = JSON.parse(stdout.trim());
	} catch {
		// Envelope parse failure — surface raw stdout so the recipe author can debug.
		emit({
			text: stdout.trim().slice(0, 2000),
			exit_code: EXIT.CLI_ERROR,
			duration_ms: durationMs,
			cost_usd: 0,
			num_turns: 0,
			error: `failed to parse claude envelope: cli exit ${cliExitCode}${stderr ? '; stderr: ' + stderr.trim().slice(0, 300) : ''}`,
		});
		process.exit(EXIT.CLI_ERROR);
	}

	if (envelope.is_error || cliExitCode !== 0) {
		emit({
			text: (envelope.result ?? '').trim(),
			exit_code: EXIT.CLI_ERROR,
			duration_ms: durationMs,
			cost_usd: envelope.total_cost_usd ?? 0,
			num_turns: envelope.num_turns ?? 0,
			model_used: envelope.model,
			error: envelope.result ?? stderr.trim().slice(0, 300) ?? 'cli returned is_error=true',
		});
		process.exit(EXIT.CLI_ERROR);
	}

	const outputs = {
		text: (envelope.result ?? '').trim(),
		exit_code: EXIT.OK,
		duration_ms: durationMs,
		cost_usd: envelope.total_cost_usd ?? 0,
		num_turns: envelope.num_turns ?? 0,
	};
	if (envelope.model) outputs.model_used = envelope.model;
	// Surface the session id when in session mode so the next step can thread
	// it via `{{steps.X.outputs.session_id}}`. Prefer the CLI's echoed id;
	// fall back to the one we passed/generated.
	if (session_action) {
		outputs.session_id = envelope.session_id ?? resolvedSessionId;
	}

	emit(outputs);
	process.exit(EXIT.OK);
}

main().catch((err) => {
	fail(EXIT.BAD_INPUT, `unexpected error: ${err.message || err}`);
});
