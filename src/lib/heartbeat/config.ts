/** Channel-neutral heartbeat config seam (ADR-001 P2).
 *
 *  The engine reads its runtime config from an injected provider instead of
 *  importing a channel schema or the global config object — this is what makes
 *  the heartbeat a channel-agnostic primitive rather than a WhatsApp feature.
 *  A channel adapter (today: WhatsApp) registers a provider that maps its own
 *  settings into this neutral shape; the engine never learns where the values
 *  live on disk. */

export interface HeartbeatRuntimeConfig {
	/** Resolved on/off — already ANDed with the delivery channel's enable flag. */
	enabled: boolean;
	/** Delivery binding — a pointer into the channel-adapter registry
	 *  (`getHeartbeatChannel(channel)`). `target` null → the engine logs and
	 *  no-ops. Change `channel` to move the heartbeat between channels. */
	delivery: { channel: string; target: string | null };
	/** Vault-relative path to the personality file (system prompt body). */
	soulPath: string;
	/** Vault-relative path to the checklist + tasks file (user prompt body). */
	checklistPath: string;
	activeHours: { start: string; end: string; timezone: string };
	maxPerDay: number;
	muteUntil: string | null;
	ackMaxChars: number;
	/** Provider:model ref, e.g. "gemini:gemini-2.5-flash". */
	model: string;
	basePrompt: string;
	/** Extractor-inferred commitment gating + per-tick cap. */
	commitments: { enabled: boolean; maxPerDay: number };
	/** User-explicit reminder / CRM-follow-up gating + per-tick cap. */
	reminders: { enabled: boolean; maxPerDay: number };
}

export type HeartbeatConfigProvider = () => HeartbeatRuntimeConfig | null;

let provider: HeartbeatConfigProvider | null = null;

/** Register the source of truth for heartbeat runtime config. Called once at
 *  module-load time by the active channel adapter (side-effect import), well
 *  before `initHeartbeat()` runs. Last registration wins. */
export function registerHeartbeatConfigProvider(fn: HeartbeatConfigProvider): void {
	provider = fn;
}

/** Resolve the current heartbeat runtime config, or null when no provider is
 *  registered or the underlying config is invalid. Read fresh each call so
 *  `reloadConfig()` is picked up without a restart. */
export function getHeartbeatConfig(): HeartbeatRuntimeConfig | null {
	return provider ? provider() : null;
}
