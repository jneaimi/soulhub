/** Module-scoped Baileys socket singleton + state machine. Lives across
 *  HTTP requests in the SvelteKit Node-adapter process. PM2 reload spawns
 *  a fresh process so the singleton resets cleanly; auth files persist
 *  on disk and reconnect happens automatically.
 *
 *  Intentional scope limits:
 *   - Single active account (multi-account is a future enhancement)
 *   - Simple exponential-backoff reconnect rather than a sophisticated
 *     circuit breaker — Baileys + backoff covers ~90% of real cases */

import { Boom } from '@hapi/boom';
import {
	default as makeWASocket,
	Browsers,
	DisconnectReason,
	fetchLatestBaileysVersion,
	jidNormalizedUser,
	useMultiFileAuthState,
	type WASocket,
	type ConnectionState as BaileysConnectionState,
} from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import type { WhatsAppChannelConfig, ConnectionStatus, InboundEnvelope } from './types.js';
import { resolveAuthDir, clearAuthDir } from './auth-store.js';
import { qrToDataUrl, qrToAscii } from './qr.js';
import { buildEnvelope } from './inbound.js';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

type MessageHandler = (env: InboundEnvelope, raw: proto.IWebMessageInfo) => void;
type ConnectHandler = (sock: WASocket) => void | Promise<void>;

interface ManagerState {
	sock: WASocket | null;
	authDir: string | null;
	config: WhatsAppChannelConfig | null;
	status: ConnectionStatus;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectAttempt: number;
	messageHandler: MessageHandler | null;
	connectHandler: ConnectHandler | null;
	silentLogger: SilentLogger;
	lastTerminalQr: string | null;
}

interface SilentLogger {
	level: string;
	trace: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	fatal: (...args: unknown[]) => void;
	child: () => SilentLogger;
}

function makeSilentLogger(): SilentLogger {
	const noop = () => {};
	const logger: SilentLogger = {
		level: 'silent',
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => logger,
	};
	return logger;
}

const _global = globalThis as unknown as { __soulhub_whatsapp?: ManagerState };
if (!_global.__soulhub_whatsapp) {
	_global.__soulhub_whatsapp = {
		sock: null,
		authDir: null,
		config: null,
		reconnectTimer: null,
		reconnectAttempt: 0,
		messageHandler: null,
		connectHandler: null,
		silentLogger: makeSilentLogger(),
		status: { state: 'disconnected', since: Date.now() },
		lastTerminalQr: null,
	};
}
const state: ManagerState = _global.__soulhub_whatsapp;

function setStatus(patch: Partial<ConnectionStatus>): void {
	state.status = { ...state.status, ...patch, since: Date.now() };
}

export function getStatus(): ConnectionStatus {
	return { ...state.status };
}

export function onMessage(handler: MessageHandler): void {
	state.messageHandler = handler;
}

/** Subscribe to the post-connect lifecycle event. The handler is invoked
 *  once each time Baileys reaches the `open` state with the live socket.
 *  Used by callers that need to perform setup work that depends on a
 *  connected socket — e.g. seeding the LID mapping store via USync. Only
 *  one handler is held; later calls replace earlier ones. */
export function onConnect(handler: ConnectHandler): void {
	state.connectHandler = handler;
}

function clearReconnectTimer(): void {
	if (state.reconnectTimer) {
		clearTimeout(state.reconnectTimer);
		state.reconnectTimer = null;
	}
}

function scheduleReconnect(config: WhatsAppChannelConfig): void {
	clearReconnectTimer();
	state.reconnectAttempt += 1;
	const delay = Math.min(
		RECONNECT_BASE_MS * 2 ** Math.min(state.reconnectAttempt, 6),
		RECONNECT_MAX_MS,
	);
	const jitter = Math.floor(delay * 0.2 * Math.random());
	setStatus({ state: 'reconnecting' });
	state.reconnectTimer = setTimeout(() => {
		void start(config).catch((err) => {
			setStatus({ state: 'disconnected', lastError: (err as Error).message });
		});
	}, delay + jitter);
}

/** Start (or restart) the Baileys socket for `config.account`. Idempotent —
 *  calling it while already connected is a no-op. */
export async function start(config: WhatsAppChannelConfig): Promise<ConnectionStatus> {
	if (state.status.state === 'connected' || state.status.state === 'connecting') {
		state.config = config;
		return getStatus();
	}

	state.config = config;
	const authDir = resolveAuthDir(config);
	state.authDir = authDir;
	const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

	setStatus({ state: 'connecting', qr: undefined, qrDataUrl: undefined, lastError: undefined });

	// Fetch the live WhatsApp Web version — Baileys' bundled version drifts
	// quickly and a stale version is the most common cause of "Connection
	// Failure" with no detail. Fall back to the bundled default if the
	// fetch itself fails (offline at startup, etc.).
	let waVersion: [number, number, number] | undefined;
	try {
		const fetched = await fetchLatestBaileysVersion();
		waVersion = fetched.version;
	} catch {
		waVersion = undefined;
	}

	// `makeWASocket` types use a different logger interface but accept any
	// pino-shaped object; cast through unknown to avoid pulling pino in.
	const sock = makeWASocket({
		auth: authState,
		printQRInTerminal: false,
		browser: Browsers.macOS('Soul Hub'),
		version: waVersion,
		logger: state.silentLogger as unknown as Parameters<typeof makeWASocket>[0]['logger'],
	});
	state.sock = sock;

	sock.ev.on('creds.update', saveCreds);

	sock.ev.on('connection.update', (update: Partial<BaileysConnectionState>) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			setStatus({ state: 'qr-required', qr });
			void qrToDataUrl(qr).then((dataUrl) => {
				if (state.status.state === 'qr-required') setStatus({ qrDataUrl: dataUrl });
			});
			// Headless first-run aid: print to stdout so the operator can scan
			// without opening Settings. Skip duplicate prints when the same
			// QR rotates back through (Baileys emits the same string twice
			// during the keepalive cycle).
			if (
				state.config?.delivery?.printTerminalQr &&
				qr !== state.lastTerminalQr
			) {
				state.lastTerminalQr = qr;
				void qrToAscii(qr).then((ascii) => {
					if (!ascii) return;
					process.stdout.write(
						'\n[soul-hub:whatsapp] scan this QR with WhatsApp → Linked Devices:\n' +
							ascii +
							'\n',
					);
				});
			}
		}

		if (connection === 'open') {
			state.reconnectAttempt = 0;
			state.lastTerminalQr = null;
			const linked = sock.user?.id?.split(':')[0]?.split('@')[0];
			console.log(
				`[whatsapp/connection] connected — sock.user.id=${sock.user?.id ?? '<undef>'} sock.user.lid=${sock.user?.lid ?? '<undef>'} sock.user.phoneNumber=${sock.user?.phoneNumber ?? '<undef>'}`,
			);
			setStatus({
				state: 'connected',
				qr: undefined,
				qrDataUrl: undefined,
				lastError: undefined,
				linkedNumber: linked,
			});
			// Fire post-connect hook off the event loop so the connection.update
			// handler returns promptly. Errors are logged but never bubble — a
			// failed seed should not tear down the socket.
			if (state.connectHandler) {
				const handler = state.connectHandler;
				queueMicrotask(() => {
					Promise.resolve(handler(sock)).catch((err) => {
						console.warn('[whatsapp/connection] onConnect handler failed:', (err as Error).message);
					});
				});
			}
			return;
		}

		if (connection === 'close') {
			const error = lastDisconnect?.error;
			const statusCode =
				error instanceof Boom ? error.output?.statusCode : undefined;
			const message = error instanceof Error ? error.message : undefined;

			if (statusCode === DisconnectReason.loggedOut) {
				// Phone-side logout — wipe creds and stop reconnecting.
				if (state.authDir) clearAuthDir(state.authDir);
				state.sock = null;
				setStatus({
					state: 'logged-out',
					lastError: 'Logged out from WhatsApp side. Re-link required.',
					linkedNumber: undefined,
					qr: undefined,
					qrDataUrl: undefined,
				});
				return;
			}

			if (statusCode === DisconnectReason.restartRequired) {
				// Common after pairing — reconnect immediately.
				setStatus({ state: 'reconnecting', lastError: message });
				setTimeout(() => void start(config).catch(() => {}), 1_000);
				return;
			}

			setStatus({ state: 'reconnecting', lastError: message });
			scheduleReconnect(config);
		}
	});

	sock.ev.on('messages.upsert', ({ messages, type }) => {
		if (type !== 'notify') return;
		const handler = state.messageHandler;
		if (!handler) return;
		// Bot's identity has two forms (PN + LID) AND each one carries a
		// `:<device>` suffix because the bot is a linked device. Group
		// @-mentions encode against the *base* JID (no device suffix), so
		// we normalize each form and pass both raw + normalized variants
		// to be safe across Baileys versions.
		const rawIds = [sock.user?.id, sock.user?.lid].filter(
			(j): j is string => typeof j === 'string' && j.length > 0,
		);
		const botJids = [
			...rawIds,
			...rawIds.map((j) => jidNormalizedUser(j)).filter((j) => j),
		];
		for (const msg of messages) {
			if (msg.key.fromMe) continue;
			if (!msg.message) continue;
			const env = buildEnvelope(msg, botJids);
			if (!env) continue;
			try {
				handler(env, msg);
			} catch (err) {
				setStatus({ lastError: `handler error: ${(err as Error).message}` });
			}
		}
	});

	return getStatus();
}

/** Tear down the socket and remove on-disk auth so the next `start()`
 *  begins a fresh QR flow. */
export async function stop(opts: { wipeAuth?: boolean } = {}): Promise<void> {
	clearReconnectTimer();
	state.reconnectAttempt = 0;
	const sock = state.sock;
	state.sock = null;

	if (sock) {
		try {
			await sock.logout();
		} catch {
			/* ignore — best-effort */
		}
		try {
			sock.end(undefined);
		} catch {
			/* ignore */
		}
	}

	if (opts.wipeAuth && state.authDir) {
		clearAuthDir(state.authDir);
	}

	setStatus({
		state: 'disconnected',
		linkedNumber: undefined,
		qr: undefined,
		qrDataUrl: undefined,
		// Clear any spurious 401 the WhatsApp server sent in response to
		// our explicit logout — that close-event handler is for unsolicited
		// remote logouts.
		lastError: undefined,
	});
}

/** Send text via the active socket. Returns null when disconnected so the
 *  caller can surface a clean error. */
export function getSocket(): WASocket | null {
	return state.sock;
}
