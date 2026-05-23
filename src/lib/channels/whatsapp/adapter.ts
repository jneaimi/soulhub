/** WhatsApp `ChannelAdapter` registration. Implements the existing
 *  Telegram-shaped contract so the rest of Soul Hub (sendViaChannel,
 *  pipeline runner, declared-secrets registry) sees it identically.
 *
 *  Two runtime modes:
 *   - **in-process** (default): the SvelteKit server owns the Baileys
 *     socket. Simple, but a Baileys crash takes the web UI with it.
 *   - **worker**: when `channels.whatsapp.worker.enabled` is true, the
 *     Baileys socket lives in the separate `soul-hub-whatsapp` PM2 app
 *     and this adapter HTTP-proxies to it. A worker crash only takes
 *     down the worker; PM2 restarts it and the main app keeps serving. */

import type { ChannelAdapter, ChannelMeta, SendResult, TestResult } from '../types.js';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { getSocket, getStatus, onMessage, onConnect, start } from './connection.js';
import { sendMedia, sendText } from './outbound.js';
import { kindFromPath } from './media.js';
import { seedLidMappingsForAllowlist } from './lid-resolve.js';
// Side-effect import: registers the WhatsApp adapter on the heartbeat channel
// registry (ADR-001 P1) so getHeartbeatChannel('whatsapp') resolves at runtime.
import './heartbeat-channel.js';
// Side-effect import: registers the WhatsApp heartbeat config provider (ADR-001
// P2) so getHeartbeatConfig() resolves for the scheduler heartbeat handler.
import './heartbeat-config-provider.js';
import {
	workerLogin,
	workerLogout,
	workerSend,
	workerStatus,
} from './worker-client.js';
import type {
	ConnectionStatus,
	WhatsAppChannelConfig,
} from './types.js';

export const meta: ChannelMeta = {
	id: 'whatsapp',
	name: 'WhatsApp',
	icon: 'message-circle',
	// WhatsApp doesn't use API tokens; auth is on disk under ~/.soul-hub/data/.
	// Declaring no `secret` fields keeps the secrets table tidy.
	fields: [],
	actions: ['send'],
};

function readChannelConfig(): WhatsAppChannelConfig | null {
	// Fall back to `{}` so the schema defaults populate when the user's
	// settings.json only has `channels.telegram` (Zod's prefault on the
	// `channels` map only fires when the whole field is missing). Returns
	// null only when the raw shape genuinely fails validation.
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	if (!parsed.success) return null;
	return parsed.data;
}

function inWorkerMode(cfg: WhatsAppChannelConfig): boolean {
	return cfg.worker.enabled === true;
}

export function isConfigured(): boolean {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) return false;
	if (inWorkerMode(cfg)) {
		// Synchronous probe is impossible; assume `connected` when worker
		// mode is on — the worker is the source of truth and a stale
		// `false` here would block sendViaChannel. The actual send call
		// surfaces a precise error if the worker is unreachable.
		return true;
	}
	return getStatus().state === 'connected';
}

/** Send a chat message to the configured target, optionally attaching a
 *  local file. With no explicit target this delivers to the first
 *  allowlisted DM number — useful for notifications. When `attachPath`
 *  is provided, the file kind (image/video/audio/document) is inferred
 *  from the extension and `message` is sent as the caption. Documents
 *  send the caption alongside the file; audio messages drop the caption
 *  because WhatsApp ignores it on voice/audio. */
export async function send(message: string, attachPath?: string): Promise<SendResult> {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) return { ok: false, error: 'WhatsApp channel disabled in settings.' };

	const target = cfg.access.allowFrom.find((n) => n !== '*');
	if (!target) {
		return {
			ok: false,
			error: 'No recipient configured — add an E.164 number to channels.whatsapp.access.allowFrom.',
		};
	}

	const targetJid = `${target.replace(/^\+/, '')}@s.whatsapp.net`;

	if (inWorkerMode(cfg)) {
		const result = await workerSend(cfg.worker, {
			to: targetJid,
			text: attachPath ? undefined : message,
			attachPath,
			kind: attachPath ? kindFromPath(attachPath) : undefined,
			caption: attachPath
				? kindFromPath(attachPath) === 'audio'
					? undefined
					: message
				: undefined,
		}).catch((err) => ({ ok: false, error: (err as Error).message }) as const);
		if (!result.ok) return { ok: false, error: result.error ?? 'worker send failed' };
		// Audio: follow up with text since WhatsApp drops audio captions.
		if (attachPath && kindFromPath(attachPath) === 'audio' && message.trim()) {
			const tail = await workerSend(cfg.worker, { to: targetJid, text: message }).catch(
				(err) => ({ ok: false, error: (err as Error).message }) as const,
			);
			if (!tail.ok) {
				return {
					ok: false,
					error: `audio sent, text follow-up failed: ${tail.error}`,
				};
			}
		}
		return { ok: true, messageId: result.messageId };
	}

	// In-process path
	const sock = getSocket();
	if (!sock) return { ok: false, error: 'WhatsApp socket not connected — link via /api/channels/whatsapp/login.' };

	if (attachPath) {
		const kind = kindFromPath(attachPath);
		const result = await sendMedia(sock, targetJid, {
			kind,
			path: attachPath,
			caption: kind === 'audio' ? undefined : message,
		});
		if (!result.ok) return { ok: false, error: result.error ?? 'send failed' };
		if (kind === 'audio' && message.trim()) {
			const textResult = await sendText(sock, targetJid, message, cfg.delivery);
			if (!textResult.ok) {
				return {
					ok: false,
					error: `audio sent, text follow-up failed: ${textResult.error}`,
				};
			}
		}
		return { ok: true, messageId: result.messageId };
	}

	const result = await sendText(sock, targetJid, message, cfg.delivery);
	if (!result.ok) return { ok: false, error: result.error ?? 'send failed' };
	return { ok: true, messageId: result.messageIds[0] };
}

/** Health check used by the secrets/test surface (no API key to validate
 *  here — we report the live socket state instead). In worker mode we
 *  fetch status from the worker; in-process we read the singleton. */
export async function test(): Promise<TestResult> {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) {
		return { ok: false, status: 'unconfigured', message: 'WhatsApp channel disabled.' };
	}

	let status: ConnectionStatus;
	if (inWorkerMode(cfg)) {
		try {
			status = await workerStatus(cfg.worker);
		} catch (err) {
			return {
				ok: false,
				status: 'network',
				message: `Worker unreachable at ${cfg.worker.url}: ${(err as Error).message}`,
			};
		}
	} else {
		status = getStatus();
	}

	switch (status.state) {
		case 'connected':
			return { ok: true, status: 'ok' };
		case 'qr-required':
		case 'connecting':
			return {
				ok: false,
				status: 'unconfigured',
				message: `Linking in progress (${status.state}) — finish the QR scan.`,
			};
		case 'reconnecting':
			return { ok: false, status: 'network', message: status.lastError ?? 'reconnecting' };
		case 'logged-out':
			return {
				ok: false,
				status: 'unauthorized',
				message: 'Logged out from WhatsApp side. Re-link via the login endpoint.',
			};
		default:
			return {
				ok: false,
				status: 'unconfigured',
				message: 'Not linked yet. POST /api/channels/whatsapp/login to start.',
			};
	}
}

export const adapter: ChannelAdapter = { meta, send, isConfigured, test };

/** Status surface used by `/api/channels/whatsapp/status` — async because
 *  worker mode requires an HTTP roundtrip. In-process mode resolves
 *  synchronously to the singleton state. */
export async function getResolvedStatus(): Promise<{
	status: ConnectionStatus;
	mode: 'worker' | 'in-process';
	error?: string;
}> {
	const cfg = readChannelConfig();
	if (!cfg) return { status: { state: 'disconnected', since: 0 }, mode: 'in-process' };
	if (inWorkerMode(cfg)) {
		try {
			const status = await workerStatus(cfg.worker);
			return { status, mode: 'worker' };
		} catch (err) {
			return {
				status: { state: 'disconnected', since: Date.now(), lastError: (err as Error).message },
				mode: 'worker',
				error: `Worker unreachable at ${cfg.worker.url}.`,
			};
		}
	}
	return { status: getStatus(), mode: 'in-process' };
}

/** Trigger login. Worker mode forwards to the worker; in-process starts
 *  the local Baileys socket. Returns the freshest status the caller can
 *  show to the user — usually `connecting` immediately, with the QR
 *  arriving on the next status poll. */
export async function triggerLogin(): Promise<{
	status: ConnectionStatus;
	mode: 'worker' | 'in-process';
}> {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) {
		return {
			status: {
				state: 'disconnected',
				since: Date.now(),
				lastError: 'WhatsApp channel disabled in settings.',
			},
			mode: 'in-process',
		};
	}
	if (inWorkerMode(cfg)) {
		const status = await workerLogin(cfg.worker);
		return { status, mode: 'worker' };
	}
	const status = await start(cfg);
	return { status, mode: 'in-process' };
}

export async function triggerLogout(wipeAuth = true): Promise<{ ok: true; mode: 'worker' | 'in-process' }> {
	const cfg = readChannelConfig();
	if (cfg && inWorkerMode(cfg)) {
		await workerLogout(cfg.worker, wipeAuth);
		return { ok: true, mode: 'worker' };
	}
	const { stop } = await import('./connection.js');
	await stop({ wipeAuth });
	return { ok: true, mode: 'in-process' };
}

/** Wire the inbound dispatcher and (optionally) auto-start the socket if
 *  channel config has `enabled: true` and creds already exist on disk.
 *  In worker mode this is a no-op for inbound (the worker POSTs to our
 *  `_inbound` endpoint instead) and for auto-start (the worker boots
 *  itself when the PM2 app comes up). */
export function bootstrap(): void {
	const cfg = readChannelConfig();
	if (!cfg) return;

	// ADR-001 P3 — the heartbeat is now driven by the scheduler `heartbeat`
	// task, not a private timer started here. Delivery still routes through the
	// WhatsApp adapter (registered via the side-effect imports above).
	if (inWorkerMode(cfg)) return;

	// ADR-028 Phase 2 (shipped 2026-05-12) deleted `whatsapp/dispatch.ts`
	// (the in-process Baileys dispatcher). The remaining in-process send
	// paths above stay for now as a thin dev/legacy escape hatch, but
	// inbound dispatch ALWAYS goes through `/api/channels/whatsapp/_inbound`
	// via the worker. If you're running the main app without the worker
	// in dev, inbound messages won't be handled — start the worker too.

	// Seed the LID mapping store on connect so allowlisted numbers resolve
	// from the very first DM (closes the cold-start gap where Baileys
	// doesn't yet know the user's LID). Mirrors the worker's onConnect.
	onConnect(async (sock) => {
		const result = await seedLidMappingsForAllowlist(
			sock,
			[...cfg.access.allowFrom, ...cfg.access.groupAllowFrom],
			console,
		);
		console.log(`[whatsapp] LID mapping seed: ${JSON.stringify(result)}`);
	});

	if (cfg.enabled) {
		void start(cfg).catch(() => {
			/* status carries the error; logs surface it */
		});
	}
}

export function getChannelConfig(): WhatsAppChannelConfig | null {
	return readChannelConfig();
}
