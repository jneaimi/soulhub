/**
 * Shared PTY Manager — wraps node-pty for both interactive terminals and pipeline agent steps.
 *
 * Replaces the Python pty_bridge.py with a direct node-pty implementation,
 * eliminating 2 serialization layers (Python JSON encode/decode).
 *
 * Used by:
 *   - /api/pty endpoint (interactive terminals)
 *   - pipeline runner (headless agent steps)
 */

import * as nodePty from 'node-pty';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '$lib/config.js';
import { saveMeta, loadMeta, appendLog, getLogSize, type SessionMeta } from './store.js';
import { captureSessionToVault } from '../vault/session-bridge.js';

export interface PtySessionOptions {
	prompt?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
	model?: string;
	env?: Record<string, string>;
	/** Pass --continue to resume the most recent session in this cwd */
	continueSession?: boolean;
	/** Pass --resume <id> to resume a specific Claude session */
	resumeSessionId?: string;
	/** Spawn a plain shell (zsh/bash) instead of Claude Code */
	shell?: boolean;
	/** Extra CLI args to pass to Claude Code */
	extraArgs?: string[];
	/** ADR-002 Layer 1 — set a deterministic Claude Code session id via
	 *  `--session-id <uuid>`. Must be a valid UUID. Recorded on SessionMeta so
	 *  the vault session capture can locate the JSONL transcript. */
	claudeSessionId?: string;
	/** Claude Code agent profile id — translated to `--agent <id>`. When set,
	 *  Claude Code loads the system prompt from `~/.claude/agents/<id>.md`
	 *  itself, so callers MUST NOT pre-paste the agent's system_prompt into
	 *  `prompt`. Pasting >100 lines of input into the TUI fragments into
	 *  multiple `[Pasted text #N]` preview blocks that never auto-confirm —
	 *  the canonical fix is to keep typed input short and let `--agent` do
	 *  its job. See `2026-05-06-pty-paste-stall-and-agent-flag` learning. */
	agentId?: string;
}

export interface PtySession {
	id: string;
	pty: nodePty.IPty;
	emitter: EventEmitter;
	pid: number;
	createdAt: number;
	promptSent: boolean;
	prompt: string;
	cwd: string;
}

/**
 * Session registry — maps sessionId to PtySession.
 * Survives HMR via globalThis singleton pattern.
 */
const _global = globalThis as unknown as {
	__soulhub_pty_sessions?: Map<string, PtySession>;
};
if (!_global.__soulhub_pty_sessions) {
	_global.__soulhub_pty_sessions = new Map();
}
const sessions = _global.__soulhub_pty_sessions;

/** System env vars safe to pass through */
const SYSTEM_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'USER', 'SHELL', 'TMPDIR'];

/**
 * Spawn a new PTY session running Claude Code.
 *
 * Events emitted on session.emitter:
 *   - 'output' (data: string)   — terminal output chunk
 *   - 'exit' (code: number)     — process exited
 *   - 'prompt_sent' ()          — auto-prompt was injected
 */
/** Resolve the Claude Code binary. Prefer the configured path, but if it
 *  doesn't exist (common on a fresh install where `claude` landed somewhere
 *  other than the recorded path), search PATH + common install locations so
 *  the terminal auto-heals instead of hard-failing. Returns null when `claude`
 *  can't be found anywhere. */
function resolveClaudeBinary(configured: string): string | null {
	if (configured && existsSync(configured)) return configured;
	const home = process.env.HOME || '';
	const dirs = [
		...(process.env.PATH || '').split(':'),
		`${home}/.local/bin`,
		`${home}/.claude/local`,
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
	];
	for (const d of dirs) {
		if (!d) continue;
		const candidate = resolve(d, 'claude');
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function spawnSession(opts: PtySessionOptions): PtySession {
	const sessionId = crypto.randomUUID().slice(0, 8);
	const rawCwd = opts.cwd || process.env.HOME || '/';
	const cwd = existsSync(rawCwd) ? rawCwd : (process.env.HOME || '/');
	const cols = opts.cols || config.terminal.cols;
	const rows = opts.rows || config.terminal.rows;
	const configuredClaude = config.resolved.claudeBinary;
	const isShell = opts.shell === true;
	// Resolve lazily for Claude sessions (auto-heals a stale configured path).
	const claudeBinary = isShell ? configuredClaude : (resolveClaudeBinary(configuredClaude) ?? configuredClaude);

	// Determine binary and args
	let spawnBinary: string;
	let args: string[];

	if (isShell) {
		// Plain shell — use user's shell or fallback to bash/zsh
		spawnBinary = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
		args = ['--login'];
	} else {
		// Claude Code — verify binary exists before attempting spawn. We already
		// searched PATH + common locations (resolveClaudeBinary); reaching here
		// means it's genuinely not installed.
		if (!existsSync(claudeBinary)) {
			throw new Error(
				`Claude Code CLI not found (configured: ${configuredClaude}, and not on PATH). ` +
				`Install it (npm i -g @anthropic-ai/claude-code), or set paths.claudeBinary in settings.json to the output of \`which claude\`.`
			);
		}
		spawnBinary = claudeBinary;
		args = ['--dangerously-skip-permissions'];
		if (opts.continueSession) {
			args.push('--continue');
		} else if (opts.resumeSessionId) {
			args.push('--resume', opts.resumeSessionId);
		}
		if (opts.model) {
			args.push('--model', opts.model);
		}
		if (opts.agentId) {
			args.push('--agent', opts.agentId);
		}
		if (opts.claudeSessionId) {
			args.push('--session-id', opts.claudeSessionId);
		}
		if (opts.extraArgs) {
			args.push(...opts.extraArgs);
		}
	}

	// Build env — either custom (pipeline) or filtered system env
	const env: Record<string, string> = {};
	if (opts.env) {
		// Pipeline provides its own isolated env — use it directly
		Object.assign(env, opts.env);
	} else {
		// Interactive terminal — pass through system env
		for (const key of SYSTEM_ENV_KEYS) {
			if (process.env[key]) env[key] = process.env[key]!;
		}
		// Pass through all env vars for interactive mode (user needs API keys etc.)
		Object.assign(env, process.env);
	}

	// Ensure Claude binary is on PATH and terminal is configured
	const pathSep = process.platform === 'win32' ? ';' : ':';
	env.PATH = `${dirname(claudeBinary)}${pathSep}${env.PATH || ''}`;
	env.TERM = 'xterm-256color';
	// Prevent nvm/npm_config_prefix conflict in PTY shells
	delete env.npm_config_prefix;
	if (!isShell) {
		env.CLAUDE_CODE_DISABLE_HOOKS = '1';
	}

	const pty = nodePty.spawn(spawnBinary, args, {
		name: 'xterm-256color',
		cols,
		rows,
		cwd,
		env,
	});

	const emitter = new EventEmitter();
	emitter.setMaxListeners(10);

	const session: PtySession = {
		id: sessionId,
		pty,
		emitter,
		pid: pty.pid,
		createdAt: Date.now(),
		promptSent: false,
		prompt: opts.prompt || '',
		cwd,
	};

	// Persist session metadata to disk
	const meta: SessionMeta = {
		id: sessionId,
		prompt: (opts.prompt || '').slice(0, 500),
		cwd,
		pid: pty.pid,
		status: 'running',
		startedAt: new Date().toISOString(),
		logSize: 0,
		claudeSessionId: opts.claudeSessionId,
	};
	saveMeta(meta);

	// Wire PTY output → emitter + log
	let outputBuffer = '';
	let promptCharCount = 0;
	let seenStatusBar = false;
	let trustPromptHandled = false;
	let readyTimestamp = Date.now();

	pty.onData((data: string) => {
		emitter.emit('output', data);

		// Write to session log file
		try { appendLog(sessionId, data); } catch { /* best effort */ }

		// Auto-prompt injection: detect when Claude is ready for input
		if (opts.prompt && !session.promptSent) {
			outputBuffer += data;

			// Handle workspace trust prompt before prompt injection
			if (!trustPromptHandled) {
				// Strip ANSI escape codes before matching — PTY output has cursor/color codes between words
				const stripped = outputBuffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').toLowerCase();
				if ((stripped.includes('trust') && stripped.includes('safety')) || stripped.includes('yes, i trust')) {
					trustPromptHandled = true;
					setTimeout(() => {
						pty.write('1');
						setTimeout(() => pty.write('\r'), 200);
					}, 500);
					// Reset readiness detection — prompt injection starts after trust is accepted
					outputBuffer = '';
					promptCharCount = 0;
					seenStatusBar = false;
					readyTimestamp = Date.now();
					return;
				}
			}

			const elapsed = (Date.now() - readyTimestamp) / 1000;

			promptCharCount += (data.match(/\u276f/g) || []).length;

			if (data.includes('bypass') || data.includes('shift+tab')) {
				seenStatusBar = true;
			}

			if (seenStatusBar || (elapsed > 8.0 && promptCharCount >= 1)) {
				setTimeout(() => {
					if (!session.promptSent) {
						session.promptSent = true;
						// Write prompt, then Enter after a brief pause
						// Claude Code shows "Pasted text" preview — needs Enter to confirm
						pty.write(opts.prompt!);
						setTimeout(() => {
							pty.write('\r');
							// Send a second Enter after 500ms in case paste preview needs confirmation
							setTimeout(() => pty.write('\r'), 500);
							emitter.emit('prompt_sent');
						}, 200);
					}
				}, 500);
			}
		}
	});

	pty.onExit(({ exitCode }) => {
		emitter.emit('exit', exitCode);
		sessions.delete(sessionId);

		// Update metadata on disk
		meta.status = 'exited';
		meta.exitCode = exitCode;
		meta.endedAt = new Date().toISOString();
		meta.logSize = getLogSize(sessionId);
		saveMeta(meta);
		captureSessionToVault(sessionId, meta).catch(() => {});
	});

	sessions.set(sessionId, session);

	console.log(`[pty:${sessionId}] spawned ${isShell ? 'shell' : 'claude'} pid=${pty.pid} cwd=${cwd} args=[${args.join(' ')}] prompt=${opts.prompt ? opts.prompt.slice(0, 60) + '...' : '(interactive)'}`);

	return session;
}

/** Get an active session by ID */
export function getSession(sessionId: string): PtySession | undefined {
	return sessions.get(sessionId);
}

/** List all active session IDs */
export function listSessions(): string[] {
	return Array.from(sessions.keys());
}

/** Send input data to a session's PTY */
export function writeInput(sessionId: string, data: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	session.pty.write(data);
	return true;
}

/** Resize a session's PTY */
export function resizeSession(sessionId: string, cols: number, rows: number): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	try {
		session.pty.resize(cols, rows);
	} catch { /* process already exited — EBADF */ }
	return true;
}

/** Kill a session and clean up */
export function killSession(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	try {
		session.pty.kill();
	} catch { /* already dead */ }
	sessions.delete(sessionId);

	// Update metadata
	const meta = loadMeta(sessionId);
	if (meta) {
		meta.status = 'killed';
		meta.endedAt = new Date().toISOString();
		meta.logSize = getLogSize(sessionId);
		saveMeta(meta);
		captureSessionToVault(sessionId, meta).catch(() => {});
	}
	return true;
}

/** Check if a session is still alive */
export function isAlive(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	try {
		// node-pty processes that have exited will have been cleaned up by onExit
		return sessions.has(sessionId);
	} catch {
		return false;
	}
}
