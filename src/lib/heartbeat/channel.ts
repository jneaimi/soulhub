/** Channel-neutral delivery seam for the heartbeat (ADR-001 Phase 1, S1).
 *
 *  The heartbeat engine holds an opaque per-channel `target` string and no
 *  longer needs to know how to reach the user — each registered adapter owns
 *  its own addressing + transport. WhatsApp is the first adapter
 *  (`channels/whatsapp/heartbeat-channel.ts`); other channels slot in later
 *  without touching the engine.
 *
 *  S1 introduces the interface + registry only. The engine begins resolving
 *  through it in S2; the inbound reply-ack seam follows in S3.
 */

export interface HeartbeatDeliveryResult {
	ok: boolean;
	error?: string;
}

export interface HeartbeatChannel {
	/** Channel id, matching the `commitments.channel` value (e.g. `'whatsapp'`). */
	readonly id: string;
	/** Deliver a composed proactive message to an opaque channel target. */
	deliver(target: string, text: string): Promise<HeartbeatDeliveryResult>;
}

const registry = new Map<string, HeartbeatChannel>();

export function registerHeartbeatChannel(channel: HeartbeatChannel): void {
	registry.set(channel.id, channel);
}

export function getHeartbeatChannel(id: string): HeartbeatChannel | undefined {
	return registry.get(id);
}

/** Ids of every registered heartbeat channel — the set the operator can pick
 *  from for `heartbeat.delivery.channel` (ADR-001 P3). */
export function listHeartbeatChannelIds(): string[] {
	return Array.from(registry.keys()).sort();
}
