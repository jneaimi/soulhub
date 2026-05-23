/** WhatsApp heartbeat channel adapter (ADR-001 Phase 1, S1).
 *
 *  Wraps the existing outbound path (worker or socket) behind the
 *  channel-neutral `HeartbeatChannel` seam, and owns the E.164 → JID mapping
 *  so the engine can address an opaque `target`. Mirrors the logic of
 *  `heartbeat.ts`'s `deliver()` verbatim — behaviour-preserving.
 *
 *  Self-registers on import; the engine begins resolving through the registry
 *  in S2 (no call site uses this yet in S1).
 */

import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import type { WhatsAppChannelConfig } from './types.js';
import { getSocket } from './connection.js';
import { sendText } from './outbound.js';
import { workerSend } from './worker-client.js';
import {
	registerHeartbeatChannel,
	type HeartbeatChannel,
	type HeartbeatDeliveryResult,
} from '../../heartbeat/channel.js';

function readChannelConfig(): WhatsAppChannelConfig | null {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

function targetToJid(e164: string): string {
	return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}

export const whatsappHeartbeatChannel: HeartbeatChannel = {
	id: 'whatsapp',
	async deliver(target: string, text: string): Promise<HeartbeatDeliveryResult> {
		const cfg = readChannelConfig();
		if (!cfg) return { ok: false, error: 'WhatsApp settings are invalid' };
		const jid = targetToJid(target);
		if (cfg.worker.enabled) {
			const result = await workerSend(cfg.worker, { to: jid, text });
			return { ok: !!result?.ok, error: result?.error };
		}
		const sock = getSocket();
		if (!sock) return { ok: false, error: 'WhatsApp socket not connected' };
		const result = await sendText(sock, jid, text, cfg.delivery);
		return { ok: result.ok, error: result.error };
	},
};

registerHeartbeatChannel(whatsappHeartbeatChannel);
