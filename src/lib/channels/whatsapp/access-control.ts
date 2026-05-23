/** Multi-layer access control per ADR-003: DM policy → group policy →
 *  group-sender allowlist → mention gating. Decisions are pure data —
 *  inbound dispatcher applies them before any provider call so denied
 *  messages cost nothing. */

import type { AccessDecision, InboundEnvelope, WhatsAppAccessConfig } from './types.js';

export function checkAccess(
	envelope: InboundEnvelope,
	access: WhatsAppAccessConfig,
): AccessDecision {
	if (envelope.isGroup) {
		if (access.groupPolicy === 'disabled') {
			return { allow: false, reason: 'group-disabled' };
		}
		if (access.groupPolicy === 'allowlist') {
			const groupAllowed = access.groups[envelope.chatJid] ?? access.groups['*'];
			if (!groupAllowed) return { allow: false, reason: 'group-not-allowlisted' };
		}

		// Sender allowlist for groups — falls back to the DM allowlist when
		// `groupAllowFrom` is empty (typical setup: same trust circle).
		const senderList =
			access.groupAllowFrom.length > 0 ? access.groupAllowFrom : access.allowFrom;
		if (
			!senderList.includes('*') &&
			!senderList.includes(envelope.senderNumber)
		) {
			return { allow: false, reason: 'group-sender-not-allowlisted' };
		}

		const groupConfig = access.groups[envelope.chatJid] ?? access.groups['*'];
		if (groupConfig?.requireMention !== false && !envelope.botMentioned) {
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
	// `open` falls through (the schema already enforces an explicit '*' for it).
	return { allow: true };
}
