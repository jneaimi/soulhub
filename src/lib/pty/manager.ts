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
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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
	/** UI surface that spawned this session (e.g. 'chat-drawer'). Recorded on
	 *  SessionMeta. For a fresh drawer spawn (no resume/continue) we also mint a
	 *  `--session-id` so the conversation is resumable later via the picker. */
	origin?: string;
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
	/** UI surface that spawned this session (e.g. 'chat-drawer'). Used to enforce
	 *  one live session per (origin, cwd) — the tmux-style singleton. */
	origin?: string;
	/**
	 * Server-side headless xterm mirror. Every PTY output byte is also fed here,
	 * so it always holds the session's *current* parsed screen. On reconnect we
	 * `serialize()` it into a VT snapshot string and paint that into the fresh
	 * client terminal — geometry-matched and complete — instead of replaying the
	 * raw (tail-truncated, wrong-geometry) log. Optional: a headless-init failure
	 * never blocks the real session.
	 */
	headless?: HeadlessTerminal;
	serializer?: SerializeAddon;
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
	const home = process.env.HOME || homedir();
	const rawCwd = opts.cwd || home || '/';
	// Expand a leading ~ before existsSync. Callers (e.g. the chat scope resolver)
	// may pass '~/dev/soul-hub'; on the literal tilde existsSync fails and we'd
	// silently fall back to HOME — recording the wrong cwd and breaking the
	// session picker's exact-cwd match (and refresh restore).
	const expandedCwd = rawCwd === '~' ? home
		: rawCwd.startsWith('~/') ? resolve(home, rawCwd.slice(2))
		: rawCwd;
	const cwd = existsSync(expandedCwd) ? expandedCwd : home;
	const cols = opts.cols || config.terminal.cols;
	const rows = opts.rows || config.terminal.rows;
	const configuredClaude = config.resolved.claudeBinary;
	const isShell = opts.shell === true;
	// Mint a Claude session id for fresh (non-resume/continue) sessions that
	// declare an origin (the chat drawer), so the conversation is resumable later
	// via the picker. Resuming/continuing must NOT also set --session-id.
	const claudeSessionUuid = opts.claudeSessionId
		?? (opts.origin && !opts.resumeSessionId && !opts.continueSession && !isShell
			? crypto.randomUUID()
			: undefined);
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
		if (claudeSessionUuid) {
			args.push('--session-id', claudeSessionUuid);
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

	// Singleton-per-workspace (tmux-style): a chat-drawer spawn replaces any other
	// live drawer session for the same cwd, so there is exactly one attachable
	// session per workspace that every browser/device attaches to. Auto-reattach
	// means we normally attach to the live one instead of reaching here; this
	// covers explicit "New" and spawn races from two clients at once.
	if (opts.origin) {
		for (const [sid, s] of sessions) {
			if (s.origin === opts.origin && s.cwd === cwd) {
				try { s.pty.kill(); } catch { /* already dead */ }
				try { s.headless?.dispose(); } catch { /* best effort */ }
				sessions.delete(sid);
				console.log(`[pty:${sid}] replaced by new ${opts.origin} session for ${cwd}`);
			}
		}
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
		origin: opts.origin,
	};

	// Headless mirror for reconnect snapshots (see PtySession.headless). Wrapped
	// so a headless/serialize init failure degrades to the SIGWINCH-repaint
	// fallback rather than killing the real terminal.
	try {
		const headless = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
		const serializer = new SerializeAddon();
		headless.loadAddon(serializer);
		session.headless = headless;
		session.serializer = serializer;
	} catch (err) {
		console.warn(`[pty:${sessionId}] headless mirror init failed (reconnect snapshots disabled):`, err);
	}

	// Persist session metadata to disk
	const meta: SessionMeta = {
		id: sessionId,
		prompt: (opts.prompt || '').slice(0, 500),
		cwd,
		pid: pty.pid,
		status: 'running',
		startedAt: new Date().toISOString(),
		logSize: 0,
		claudeSessionId: claudeSessionUuid ?? opts.resumeSessionId,
		origin: opts.origin,
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

		// Mirror into the headless terminal so reconnects can serialize the
		// current screen instead of replaying the raw log.
		try { session.headless?.write(data); } catch { /* best effort */ }

		// Write to session log file
		try { appendLog(sessionId, data); } catch { /* best effort */ }

		// Auto-prompt injection: detect when Claude is ready for input.
		// ONLY for genuinely new sessions — a resume (--resume) or continue
		// (--continue) restores an existing conversation, so injecting the scope
		// primer again would paste it as a fresh user message. Restore must just
		// reattach, not re-prompt.
		if (opts.prompt && !session.promptSent && !opts.resumeSessionId && !opts.continueSession) {
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
		try { session.headless?.dispose(); } catch { /* best effort */ }
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
	try { session.headless?.resize(cols, rows); } catch { /* best effort */ }
	return true;
}

/**
 * Serialize a session's current screen into a VT snapshot string for reconnect.
 * Returns null when the session (or its headless mirror) is unavailable — the
 * caller then falls back to a SIGWINCH-driven repaint.
 */
export function serializeSession(sessionId: string): string | null {
	const session = sessions.get(sessionId);
	if (!session?.serializer || !session.headless) return null;
	try {
		const body = session.serializer.serialize();
		// Prepend the alternate-screen enter ONLY when the live process is
		// actually on the alt buffer (Claude's TUI). serialize() captures the
		// active buffer's content but not the mode switch; guessing wrong
		// (forcing alt-screen when the process is on the normal buffer) is what
		// made reconnect *intermittently* garble. Reading the real buffer type
		// makes the snapshot self-describing and removes the guess.
		const isAlt = session.headless.buffer.active.type === 'alternate';
		return isAlt ? `\x1b[?1049h\x1b[H${body}` : body;
	} catch {
		return null;
	}
}

/** Kill a session and clean up */
export function killSession(sessionId: string): boolean {
	const session = sessions.get(sessionId);
	if (!session) return false;
	try {
		session.pty.kill();
	} catch { /* already dead */ }
	try { session.headless?.dispose(); } catch { /* best effort */ }
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
