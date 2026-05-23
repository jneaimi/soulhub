/** WhatsApp LID (Linked ID) ↔ phone-number resolution.
 *
 *  WhatsApp's privacy layer routes some inbound messages with an opaque
 *  `<id>@lid` sender JID instead of `<phone>@s.whatsapp.net`. The LID
 *  *digits are not the user's phone number*, so a naive `jidToE164` of a
 *  LID never matches an E.164 allowlist entry — every DM gets dropped
 *  with `dm-not-allowlisted` even when the sender is in the allowlist.
 *
 *  Baileys 7.x maintains a persistent LID↔PN mapping store on the socket
 *  (`sock.signalRepository.lidMapping`) backed by the auth state. It's
 *  populated automatically:
 *    - by every incoming message whose `key.remoteJidAlt` carries the
 *      counterpart JID (handled inline in `inbound.ts`'s sync fast-path),
 *    - by USync round-trips when we ask `getLIDForPN(pn)` proactively
 *      (the `seedLidMappingsForAllowlist` call below).
 *
 *  This module owns the two helpers: a runtime resolver that promotes a
 *  LID-form envelope to its PN form, and a startup seeder that primes
 *  the store from the configured allowlist so cold-start DMs from a new
 *  contact land correctly without a "first message will be dropped" gap. */

import { jidToE164, isLidJid } from './inbound.js';
import type { InboundEnvelope } from './types.js';

/** Minimal shape of the Baileys socket we depend on — keeps this module
 *  testable without dragging in the full WASocket type. */
interface LidCapableSocket {
	signalRepository?: {
		lidMapping?: {
			getPNForLID(lid: string): Promise<string | null>;
			getLIDForPN(pn: string): Promise<string | null>;
		};
	};
}

/** When the envelope's sender JID is still an `@lid` after the sync
 *  fast-path in `buildEnvelope` (i.e. `key.remoteJidAlt` was missing on
 *  the inbound message), consult the local mapping store. Returns a new
 *  envelope with `jid`/`senderNumber` rewritten and the original LID
 *  preserved as `lidJid`; returns the input unchanged when the sender
 *  isn't a LID or the mapping store has no entry yet. */
export async function resolveSenderLid(
	envelope: InboundEnvelope,
	sock: LidCapableSocket,
): Promise<InboundEnvelope> {
	if (!isLidJid(envelope.jid)) return envelope;
	const store = sock.signalRepository?.lidMapping;
	if (!store) return envelope;
	const pnJid = await store.getPNForLID(envelope.jid);
	if (!pnJid || isLidJid(pnJid)) return envelope;
	return {
		...envelope,
		jid: pnJid,
		senderNumber: jidToE164(pnJid),
		lidJid: envelope.lidJid ?? envelope.jid,
	};
}

/** Seed the LID mapping store at connect time by USync-querying WhatsApp
 *  for the LID of every allowlisted phone number. Caches the (PN ↔ LID)
 *  pair locally so the reverse `getPNForLID()` lookup at message-receive
 *  time hits cache from the very first inbound message — closes the
 *  cold-start gap where a new chat's first message lacks `remoteJidAlt`.
 *
 *  Best-effort: failures (network, unknown numbers, wildcard `*` entries)
 *  are tallied for logging but never throw. Wildcard allowlists skip
 *  seeding entirely (nothing meaningful to seed). */
export async function seedLidMappingsForAllowlist(
	sock: LidCapableSocket,
	allowFrom: string[],
	logger: { info?: (m: string) => void; warn?: (m: string) => void },
): Promise<{ seeded: number; failed: number; skipped: number }> {
	const store = sock.signalRepository?.lidMapping;
	if (!store || allowFrom.length === 0) {
		return { seeded: 0, failed: 0, skipped: allowFrom.length };
	}
	let seeded = 0;
	let failed = 0;
	let skipped = 0;
	for (const e164 of allowFrom) {
		if (!e164 || e164 === '*') {
			skipped++;
			continue;
		}
		const digits = e164.replace(/[^0-9]/g, '');
		if (!digits) {
			skipped++;
			continue;
		}
		const pnJid = `${digits}@s.whatsapp.net`;
		try {
			const lid = await store.getLIDForPN(pnJid);
			if (lid) seeded++;
			else failed++;
		} catch (err) {
			logger.warn?.(`[lid-seed] ${e164}: ${(err as Error).message}`);
			failed++;
		}
	}
	logger.info?.(
		`[lid-seed] allowlist seed complete — seeded=${seeded} failed=${failed} skipped=${skipped}`,
	);
	return { seeded, failed, skipped };
}
