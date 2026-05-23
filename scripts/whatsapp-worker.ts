#!/usr/bin/env node
/** Soul Hub WhatsApp worker — runs the Baileys socket in its own PM2 app
 *  so a Baileys crash doesn't take down the SvelteKit web UI. Reuses the
 *  same `connection`/`inbound`/`outbound`/`media`/`transcribe`/`intent`/
 *  `access-control` modules as the in-process adapter — only the entry
 *  shape differs (HTTP control plane + outbound POST callbacks).
 *
 *  Run via `npm run prod:start` (PM2 picks it up from `ecosystem.config.cjs`)
 *  or directly with `node scripts/whatsapp-worker.ts`. Node's native TS
 *  support (>=22.6) handles the `.ts` extension without a build step.
 *
 *  Wire format (see /api/channels/whatsapp/_inbound for the reciprocal):
 *
 *    GET  /status                  → ConnectionStatus
 *    POST /login                   → ConnectionStatus (idempotent)
 *    POST /logout {wipeAuth?: bool}→ {ok: true}
 *    POST /send {to, text?, attachPath?, kind?, caption?} → {ok, messageId?, error?}
 *
 *  Inbound dispatch: the worker POSTs every accepted message envelope to
 *  `${mainAppUrl}/api/channels/whatsapp/_inbound`. The main app applies
 *  routes/RAG and POSTs the reply back to `/send` here. */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigSchema, WhatsAppChannelSchema } from '../src/lib/config.schema.ts';
import {
	getStatus,
	onMessage,
	onConnect,
	start,
	stop,
	getSocket,
} from '../src/lib/channels/whatsapp/connection.ts';
import { resolveSenderLid, seedLidMappingsForAllowlist } from '../src/lib/channels/whatsapp/lid-resolve.ts';
import { collectMentionedJids } from '../src/lib/channels/whatsapp/inbound.ts';
import { sendMedia, sendText, reactTo, editText, sendTypingIndicator } from '../src/lib/channels/whatsapp/outbound.ts';
import { startTypingLoop } from '../src/lib/channels/_shared/typing.ts';
import { kindFromPath, downloadMedia, saveMediaToDisk } from '../src/lib/channels/whatsapp/media.ts';
import { transcribeVoiceNote } from '../src/lib/channels/whatsapp/transcribe.ts';
import { checkAccess } from '../src/lib/channels/whatsapp/access-control.ts';
import type {
	InboundEnvelope,
	WhatsAppChannelConfig,
} from '../src/lib/channels/whatsapp/types.ts';

const HOME = homedir();
const SOUL_HUB_HOME = process.env.SOUL_HUB_HOME || resolve(HOME, '.soul-hub');

function loadEnvFile(): void {
	const envPath = resolve(SOUL_HUB_HOME, '.env');
	try {
		const content = readFileSync(envPath, 'utf-8');
		for (const raw of content.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) continue;
			const eq = line.indexOf('=');
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			let value = line.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (!process.env[key]) process.env[key] = value;
		}
	} catch {
		// .env is optional — secrets may already be in process env from PM2.
	}
}

function loadConfig(): WhatsAppChannelConfig {
	const candidates = [
		process.env.SOUL_HUB_SETTINGS,
		resolve(SOUL_HUB_HOME, 'settings.json'),
		resolve(process.cwd(), 'settings.json'),
	].filter(Boolean) as string[];

	let parsed: unknown = {};
	for (const path of candidates) {
		try {
			parsed = JSON.parse(readFileSync(path, 'utf-8'));
			break;
		} catch {
			continue;
		}
	}

	const fullCfg = ConfigSchema.safeParse(parsed);
	const raw = fullCfg.success ? fullCfg.data.channels?.whatsapp ?? {} : {};
	const result = WhatsAppChannelSchema.safeParse(raw);
	if (!result.success) {
		console.error('[whatsapp-worker] settings.json validation failed:');
		for (const issue of result.error.issues) {
			console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
		}
		console.error('[whatsapp-worker] Falling back to defaults.');
		return WhatsAppChannelSchema.parse({});
	}
	return result.data;
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', rejectBody);
	});
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

async function main(): Promise<void> {
	loadEnvFile();
	let cfg = loadConfig();

	const PORT = Number(process.env.SOUL_HUB_WHATSAPP_WORKER_PORT) || 2401;
	const MAIN_APP_URL =
		process.env.SOUL_HUB_MAIN_APP_URL || cfg.worker.mainAppUrl || 'http://127.0.0.1:2400';

	console.log(`[whatsapp-worker] starting on :${PORT} → main app ${MAIN_APP_URL}`);

	// Inbound pipeline: access-control → optional voice transcription →
	// POST envelope to main app → ship the reply back via Baileys.
	// Seed the LID mapping store on connect so the first DM from any
	// allowlisted number resolves correctly even if Baileys hasn't yet
	// learned that user's LID via inline message metadata.
	onConnect(async (sock) => {
		const result = await seedLidMappingsForAllowlist(
			sock,
			[...cfg.access.allowFrom, ...cfg.access.groupAllowFrom],
			console,
		);
		console.log(`[whatsapp-worker] LID mapping seed: ${JSON.stringify(result)}`);
	});

	onMessage(async (rawEnvelope: InboundEnvelope, raw) => {
		try {
			const sock = getSocket();
			if (!sock) {
				console.warn(`[whatsapp-worker] inbound from ${rawEnvelope.senderNumber || '<empty>'}: no socket, dropping`);
				return;
			}

			// Promote @lid sender JIDs to their phone-number form via the local
			// mapping store. The `inbound.ts` builder already handled the sync
			// fast-path (key.remoteJidAlt); this catches the harder cases where
			// only the LID is on the message.
			const envelope = await resolveSenderLid(rawEnvelope, sock);
			const senderTag = `${envelope.senderNumber || '<empty>'} (jid=${envelope.jid || '<empty>'})${envelope.lidJid ? ` lidJid=${envelope.lidJid}` : ''}${envelope.isGroup ? ' [group]' : ''}`;

			const access = checkAccess(envelope, cfg.access);
			if (!access.allow) {
				const extra = access.reason === 'mention-required'
					? ` mentionedJid=${JSON.stringify(collectMentionedJids(raw.message))} botJids=[${[sock.user?.id, sock.user?.lid].filter(Boolean).join(', ')}]`
					: '';
				console.log(`[whatsapp-worker] inbound from ${senderTag}: ACCESS DENIED (${access.reason ?? 'no reason'}) — allowFrom=${JSON.stringify(cfg.access.allowFrom)}${extra}`);
				return;
			}
			console.log(`[whatsapp-worker] inbound from ${senderTag}: ${envelope.body?.slice(0, 80) ?? `[${envelope.media?.kind ?? 'unknown'}]`}`);

			// Per ADR-022 Layer A: start "typing…" presence updates as soon
			// as we accept the message. Re-fires every 4s; cleared by the
			// `finally` below regardless of outcome (transcription error,
			// dispatch failure, success). The in-process dispatch.ts had the
			// same wiring but worker mode bypasses it — this is the parallel
			// implementation. Fire-and-forget; presence failures never block
			// the reply path.
			const stopTyping = startTypingLoop(() => sendTypingIndicator(sock, envelope.chatJid));
			try {

			// Ack reaction first.
			if (cfg.delivery.ackEmoji) {
				await reactTo(sock, envelope.chatJid, envelope.messageId, cfg.delivery.ackEmoji);
			}

			// Voice → transcript (worker-side; same Gemini call as in-process
			// dispatcher). Failures degrade to a friendly user-visible reply.
			// Also collect the buffer for ANY media kind (image/voice/video/
			// document) so the main app's `/save` brain handler can archive
			// the asset + run multimodal extraction without re-downloading.
			// Cap-checked against `delivery.maxMediaSizeMB`; oversize media
			// skips the buffer ride (text caption still flows through).
			let transcript: string | undefined;
			let mediaBase64: string | undefined;
			if (envelope.media) {
				const maxBytes = cfg.delivery.maxMediaSizeMB * 1024 * 1024;
				const oversize = !!envelope.media.fileLength && envelope.media.fileLength > maxBytes;
				if (oversize && envelope.media.kind === 'voice' && cfg.delivery.transcribeVoiceNotes) {
					await sendText(
						sock,
						envelope.chatJid,
						`Voice note exceeds ${cfg.delivery.maxMediaSizeMB}MB cap (was ${(envelope.media.fileLength! / 1024 / 1024).toFixed(1)}MB) — not transcribing.`,
						cfg.delivery,
					);
					return;
				}
				if (!oversize) {
					try {
						const buffer = await downloadMedia(raw);
						try {
							saveMediaToDisk({
								account: cfg.account,
								messageId: envelope.messageId || `inbound-${Date.now()}`,
								payload: envelope.media,
								buffer,
							});
						} catch {
							/* archival is optional */
						}
						mediaBase64 = buffer.toString('base64');
						if (envelope.media.kind === 'voice' && cfg.delivery.transcribeVoiceNotes) {
							try {
								const result = await transcribeVoiceNote({
									audio: buffer,
									mimetype: envelope.media.mimetype,
									providerRef: cfg.delivery.transcribeProvider,
								});
								transcript = result.text;
							} catch (err) {
								await sendText(
									sock,
									envelope.chatJid,
									`Couldn't transcribe voice note: ${(err as Error).message}`,
									cfg.delivery,
								);
								return;
							}
						}
					} catch (err) {
						console.warn(`[whatsapp-worker] media download failed for ${senderTag}: ${(err as Error).message}`);
						// Fall through — main app still gets the envelope; routes
						// that don't need media will continue working.
					}
				}
			}

			// Hand off to the main app for routes/RAG dispatch.
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (cfg.worker.bearerToken) {
				headers.Authorization = `Bearer ${cfg.worker.bearerToken}`;
			}
			const resp = await fetch(`${MAIN_APP_URL}/api/channels/whatsapp/_inbound`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ envelope, transcript, mediaBase64 }),
			});
			const dispatch = (await resp.json()) as {
				ok?: boolean;
				action?: 'reply' | 'help' | 'drop';
				text?: string;
				attachPath?: string;
				kind?: 'image' | 'video' | 'audio' | 'voice' | 'document';
				caption?: string;
				error?: string;
			};
			if (!resp.ok || !dispatch.ok) {
				console.warn(`[whatsapp-worker] dispatch failed for ${senderTag}: ${dispatch.error ?? `HTTP ${resp.status}`}`);
				await sendText(
					sock,
					envelope.chatJid,
					`Sorry, the main app rejected this message: ${dispatch.error ?? `HTTP ${resp.status}`}.`,
					cfg.delivery,
				);
				return;
			}
			console.log(`[whatsapp-worker] dispatch ok for ${senderTag}: action=${dispatch.action ?? 'reply'} replyLen=${dispatch.text?.length ?? 0} attach=${dispatch.attachPath ? 'yes' : 'no'}`);
			if (dispatch.action === 'drop') return;
			// Slice 6 — `attachPath` is a valid response *without* `text` (an
			// image-only `/img` reply). When both are present, `caption` (or
			// `text` as a fallback) becomes the WhatsApp caption beneath the
			// media. Audio doesn't take a caption param so the text is sent
			// as a follow-up message instead.
			if (dispatch.attachPath) {
				const kind = dispatch.kind ?? kindFromPath(dispatch.attachPath);
				// Audio + voice notes don't take captions; the text rides as a
				// separate message after the media. Image/video/document
				// accept captions inline.
				const noCaption = kind === 'audio' || kind === 'voice';
				const cap = dispatch.caption ?? (noCaption ? undefined : dispatch.text);
				await sendMedia(sock, envelope.chatJid, {
					kind,
					path: dispatch.attachPath,
					caption: noCaption ? undefined : cap,
				});
				if (noCaption && dispatch.text) {
					await sendText(sock, envelope.chatJid, dispatch.text, cfg.delivery);
				}
			} else if (dispatch.text) {
				await sendText(sock, envelope.chatJid, dispatch.text, cfg.delivery);
			}
			} finally {
				// Stop the typing loop. The reply has either landed (above)
				// or one of the early-return paths fired (transcription error,
				// dispatch failure, action='drop'). All of those need the
				// indicator cleared so it doesn't keep firing for the
				// channel's auto-clear window after delivery.
				stopTyping();
			}
		} catch (err) {
			console.error('[whatsapp-worker] inbound handler error:', (err as Error).message);
		}
	});

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

		if (cfg.worker.bearerToken) {
			const auth = req.headers['authorization'] ?? '';
			const expected = `Bearer ${cfg.worker.bearerToken}`;
			if (auth !== expected) {
				return send(res, 401, { ok: false, error: 'Bad bearer token.' });
			}
		}

		try {
			if (req.method === 'GET' && url.pathname === '/status') {
				return send(res, 200, getStatus());
			}

			if (req.method === 'POST' && url.pathname === '/login') {
				cfg = loadConfig(); // refresh in case settings changed
				const status = await start(cfg);
				return send(res, 200, status);
			}

			if (req.method === 'POST' && url.pathname === '/logout') {
				const raw = await readBody(req);
				let body: { wipeAuth?: boolean } = {};
				try {
					body = raw ? (JSON.parse(raw) as { wipeAuth?: boolean }) : {};
				} catch {
					return send(res, 400, { ok: false, error: 'Invalid JSON.' });
				}
				await stop({ wipeAuth: body.wipeAuth !== false });
				return send(res, 200, { ok: true });
			}

			if (req.method === 'POST' && url.pathname === '/send') {
				const sock = getSocket();
				if (!sock) return send(res, 503, { ok: false, error: 'Socket not connected.' });

				const raw = await readBody(req);
				let body: {
					to: string;
					text?: string;
					attachPath?: string;
					kind?: 'image' | 'video' | 'audio' | 'voice' | 'document';
					caption?: string;
					/** ADR-005 Phase 2 — when present, edit the previously sent
					 *  message identified by `editId` instead of sending a new
					 *  one. Used by the orchestrator's progress callback. */
					editId?: string;
				};
				try {
					body = JSON.parse(raw) as typeof body;
				} catch {
					return send(res, 400, { ok: false, error: 'Invalid JSON.' });
				}
				if (!body.to) return send(res, 400, { ok: false, error: 'Missing `to`.' });

				if (body.editId) {
					if (!body.text) {
						return send(res, 400, { ok: false, error: 'Edit requires `text`.' });
					}
					const editResult = await editText(sock, body.to, body.editId, body.text);
					if (!editResult.ok) return send(res, 502, editResult);
					return send(res, 200, { ok: true, messageId: body.editId });
				}

				if (body.attachPath) {
					const kind = body.kind ?? kindFromPath(body.attachPath);
					const result = await sendMedia(sock, body.to, {
						kind,
						path: body.attachPath,
						caption: body.caption,
					});
					return send(res, result.ok ? 200 : 502, result);
				}

				if (!body.text) return send(res, 400, { ok: false, error: 'Missing `text` or `attachPath`.' });
				const result = await sendText(sock, body.to, body.text, cfg.delivery);
				if (!result.ok) return send(res, 502, result);
				return send(res, 200, { ok: true, messageId: result.messageIds[0] });
			}

			return send(res, 404, { ok: false, error: `Not found: ${req.method} ${url.pathname}` });
		} catch (err) {
			return send(res, 500, { ok: false, error: (err as Error).message });
		}
	});

	server.listen(PORT, '127.0.0.1', () => {
		console.log(`[whatsapp-worker] listening on http://127.0.0.1:${PORT}`);
	});

	// Auto-start the Baileys connection if the channel is enabled and creds
	// already exist on disk — keeps prod warm across PM2 restarts.
	if (cfg.enabled) {
		void start(cfg).catch((err: Error) => {
			console.error('[whatsapp-worker] auto-start failed:', err.message);
		});
	}

	// Graceful shutdown so PM2's kill_timeout has something to do.
	const shutdown = async (sig: string) => {
		console.log(`[whatsapp-worker] received ${sig}, shutting down`);
		try {
			await stop({ wipeAuth: false });
		} catch {
			/* ignore */
		}
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 5_000).unref();
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err: Error) => {
	console.error('[whatsapp-worker] fatal:', err.stack ?? err.message);
	process.exit(1);
});
