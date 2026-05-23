/** Multi-layer access control mirroring WhatsApp's: DM policy → group
 *  policy → group-sender allowlist → mention gating. Decisions are pure
 *  data; the dispatcher applies them before any provider call so denied
 *  messages cost nothing. */

import type {
	AccessDecision,
	InboundEnvelope,
	TelegramAccessConfig,
} from './types.js';

export function checkAccess(
	envelope: InboundEnvelope,
	access: TelegramAccessConfig,
): AccessDecision {
	if (envelope.isGroup) {
		if (access.groupPolicy === 'disabled') {
			return { allow: false, reason: 'group-disabled' };
		}
		if (access.groupPolicy === 'allowlist') {
			const groupAllowed =
				access.groups[envelope.chatJid] ?? access.groups['*'];
			if (!groupAllowed && !access.groupAllowFrom.includes(envelope.chatJid)) {
				// The allowlist for groups is the union of `groupAllowFrom` (raw
				// list) and `groups` keys (with per-group requireMention config).
				return { allow: false, reason: 'group-not-allowlisted' };
			}
		}

		// Sender allowlist for groups — falls back to the DM allowlist when
		// `groupAllowFrom` is empty (typical setup: same trust circle).
		const senderList: string[] =
			access.groupAllowFrom.length > 0
				? access.groupAllowFrom
				: (access.allowFrom as string[]);
		if (
			!senderList.includes('*') &&
			!senderList.includes(envelope.senderNumber)
		) {
			return { allow: false, reason: 'group-sender-not-allowlisted' };
		}

		const groupConfig =
			access.groups[envelope.chatJid] ?? access.groups['*'];
		// Default requireMention=true on groups when not configured — matches
		// WhatsApp's default and Telegram's privacy-mode-on stance.
		const requireMention = groupConfig?.requireMention ?? true;
		if (requireMention && !envelope.botMentioned) {
			return { allow: false, reason: 'mention-required' };
		}
		return { allow: true };
	}

	// Direct chat path
	if (access.dmPolicy === 'disabled') return { allow: false, reason: 'dm-disabled' };
	if (access.dmPolicy === 'allowlist') {
		if (
			!access.allowFrom.includes('*') &&
			!access.allowFrom.includes(envelope.senderNumber)
		) {
			return { allow: false, reason: 'dm-not-allowlisted' };
		}
	}
	// `open` falls through (the schema enforces an explicit '*' for it).
	return { allow: true };
}
