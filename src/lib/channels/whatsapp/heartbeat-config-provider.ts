/** Heartbeat config provider (ADR-001 P2 + P3).
 *
 *  Maps Soul Hub config into the channel-neutral `HeartbeatRuntimeConfig` the
 *  engine consumes. Since ADR-001 P3 the heartbeat block lives at the top-level
 *  `config.heartbeat` key (lifted off `channels.whatsapp.heartbeat`); this
 *  provider reads it there. Channel-scoped gating (the delivery channel's
 *  enable flag + its commitments/reminders caps) is resolved per
 *  `delivery.channel` — today only WhatsApp defines those sub-schemas.
 *
 *  Self-registers on import; pulled in as a side-effect from `adapter.ts`
 *  before `initHeartbeat()` runs. */

import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import {
	registerHeartbeatConfigProvider,
	type HeartbeatRuntimeConfig,
} from '../../heartbeat/config.js';

function readHeartbeatConfig(): HeartbeatRuntimeConfig | null {
	const hb = soulHubConfig.heartbeat;
	if (!hb) return null;
	const channelId = hb.delivery.channel;

	// Channel-scoped gating for the delivery channel. WhatsApp owns the
	// commitments/reminders extraction sub-schemas; other channels default
	// them off (their config has no such block).
	let channelEnabled = false;
	let commitments = { enabled: false, maxPerDay: 0 };
	let reminders = { enabled: false, maxPerDay: 0 };
	if (channelId === 'whatsapp') {
		const parsed = WhatsAppChannelSchema.safeParse(soulHubConfig.channels?.whatsapp ?? {});
		if (parsed.success) {
			channelEnabled = parsed.data.enabled;
			commitments = {
				enabled: parsed.data.commitments.enabled,
				maxPerDay: parsed.data.commitments.maxPerDay,
			};
			reminders = {
				enabled: parsed.data.reminders.enabled,
				maxPerDay: parsed.data.reminders.maxPerDay,
			};
		}
	} else {
		channelEnabled = Boolean(
			(soulHubConfig.channels?.[channelId] as { enabled?: boolean } | undefined)?.enabled,
		);
	}

	return {
		enabled: hb.enabled && channelEnabled,
		delivery: { channel: channelId, target: hb.delivery.target ?? null },
		soulPath: hb.soulPath,
		checklistPath: hb.checklistPath,
		activeHours: {
			start: hb.activeHours.start,
			end: hb.activeHours.end,
			timezone: hb.activeHours.timezone,
		},
		maxPerDay: hb.maxPerDay,
		muteUntil: hb.muteUntil ?? null,
		ackMaxChars: hb.ackMaxChars,
		model: hb.model,
		basePrompt: hb.basePrompt,
		commitments,
		reminders,
	};
}

registerHeartbeatConfigProvider(readHeartbeatConfig);
