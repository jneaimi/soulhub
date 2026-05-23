/** Heartbeat meta-commands — `/heartbeat now`, `/heartbeat status`,
 *  `/mute [duration]`, `/resume`. Routed before the standard intent map
 *  (mirroring the `/reset` precedent in `dispatch.ts`) because they
 *  control the channel itself, not chat content. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { soulHubSettingsPath } from '../../paths.js';
import { config as soulHubConfig, reloadConfig, type SoulHubConfig } from '../../config.js';
import { parseDurationMs } from '../../heartbeat/heartbeat-loader.js';
import { triggerHeartbeat } from '../../heartbeat/heartbeat.js';
import {
	recentLog,
	getDailyCount,
	ymdInTimezone,
	dismissCommitment,
	listCommitmentsForTarget,
	applyReplyAck,
	type CommitmentRow,
	type ReplyAckMethod,
} from './heartbeat-state.js';

type HeartbeatCfg = SoulHubConfig['heartbeat'];

export function isHeartbeatMetaCommand(body: string): boolean {
	const trimmed = body.trim().toLowerCase();
	if (!trimmed) return false;
	const first = trimmed.split(/\s+/, 1)[0];
	return first === '/heartbeat' || first === '/mute' || first === '/resume';
}

/** Patch only the top-level `heartbeat.<…>` block in settings.json and
 *  reload (ADR-001 P3 — lifted off `channels.whatsapp.heartbeat`). Atomic-ish:
 *  read → merge → write. Concurrent edits are not expected for a personal
 *  Soul Hub. */
async function mutateHeartbeat(patch: Record<string, unknown>): Promise<void> {
	const path = soulHubSettingsPath();
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		/* start fresh */
	}

	const heartbeat = (existing.heartbeat as Record<string, unknown> | undefined) ?? {};

	const merged = {
		...existing,
		heartbeat: { ...heartbeat, ...patch },
	};

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
	reloadConfig();
	// No reschedule needed (ADR-001 P3): the scheduler `heartbeat` task owns
	// cadence, and mute/enabled changes are read fresh on the next tick.
}

function fmtCount(hb: HeartbeatCfg): string {
	if (!hb.delivery.target) return 'no target set';
	const ymd = ymdInTimezone(hb.activeHours.timezone);
	const used = getDailyCount(hb.delivery.target, ymd);
	return `${used}/${hb.maxPerDay} delivered today`;
}

function fmtMuteState(hb: HeartbeatCfg): string {
	const until = hb.muteUntil;
	if (!until) return 'not muted';
	const ms = Date.parse(until);
	if (Number.isNaN(ms) || ms <= Date.now()) return 'mute expired';
	const remaining = ms - Date.now();
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	return `muted for ${hours > 0 ? `${hours}h ` : ''}${minutes}m more`;
}

async function handleHeartbeat(rest: string): Promise<string> {
	const sub = rest.trim().toLowerCase();
	const hb = soulHubConfig.heartbeat;
	if (!hb) return 'Heartbeat config missing — check settings.json.';

	if (sub === '' || sub === 'status') {
		const lines = [
			`enabled: ${hb.enabled}`,
			`target: ${hb.delivery.target ?? '<unset>'} (channel: ${hb.delivery.channel})`,
			`active hours: ${hb.activeHours.start}–${hb.activeHours.end} (${hb.activeHours.timezone})`,
			`cap: ${fmtCount(hb)}`,
			`mute: ${fmtMuteState(hb)}`,
			`model: ${hb.model}`,
		];
		const log = recentLog(3);
		if (log.length > 0) {
			lines.push('', 'recent:');
			for (const e of log) {
				const when = new Date(e.ts).toISOString().slice(11, 16);
				lines.push(`  ${when} · ${e.status}${e.taskName ? ` · ${e.taskName}` : ''}`);
			}
		}
		return lines.join('\n');
	}

	if (sub === 'now') {
		const result = await triggerHeartbeat();
		return `heartbeat triggered → ${result.status}${result.text ? `\n\n${result.text}` : ''}`;
	}

	return `Unknown subcommand "${sub}". Try /heartbeat status or /heartbeat now.`;
}

async function handleMute(rest: string): Promise<string> {
	const arg = rest.trim();
	const ms = parseDurationMs(arg || '24h') ?? 24 * 3_600_000;
	const until = new Date(Date.now() + ms).toISOString();
	await mutateHeartbeat({ muteUntil: until });
	const hours = Math.round(ms / 3_600_000);
	return `Heartbeat muted for ~${hours}h (until ${until.slice(0, 16)}Z). Reply /resume to lift.`;
}

async function handleResume(): Promise<string> {
	await mutateHeartbeat({ muteUntil: null });
	return 'Heartbeat resumed.';
}

/** Resolve and execute a heartbeat meta-command. Returns the reply text
 *  (may be multi-line). Caller is responsible for `sendText`. */
export async function handleHeartbeatMetaCommand(body: string): Promise<string> {
	const trimmed = body.trim();
	const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
	const rest = trimmed.slice(first?.length ?? 0).trim();

	if (first === '/heartbeat') return handleHeartbeat(rest);
	if (first === '/mute') return handleMute(rest);
	if (first === '/resume') return handleResume();
	return `Unknown command "${first}".`;
}

// ─── Commitments (Slice 5) ─────────────────────────────────────────────

export function isCommitmentsMetaCommand(body: string): boolean {
	const trimmed = body.trim().toLowerCase();
	if (!trimmed) return false;
	return trimmed.split(/\s+/, 1)[0] === '/commitments';
}

function fmtCommitmentLine(c: CommitmentRow): string {
	const status = c.status === 'pending' ? '⏳' : c.status === 'surfaced' ? '✓' : '✕';
	const due = new Date(c.dueAfterTs).toLocaleString('en-GB', {
		day: '2-digit',
		month: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	return `[#${c.id}] ${status} due ${due} — ${c.suggestedText}`;
}

/** Handle `/commitments` (list) and `/commitments dismiss <id>`. Scoped
 *  to the sender's (channel, target) so users only ever see their own
 *  commitments — a leak between numbers would be a privacy bug. */
export async function handleCommitmentsMetaCommand(
	body: string,
	channel: string,
	senderNumber: string,
): Promise<string> {
	const trimmed = body.trim();
	const parts = trimmed.split(/\s+/);
	const sub = (parts[1] ?? 'list').toLowerCase();

	if (sub === 'list' || sub === '') {
		const rows = listCommitmentsForTarget(channel, senderNumber, 20);
		if (rows.length === 0) return 'No open commitments.';
		const lines = ['Open commitments:', ...rows.map(fmtCommitmentLine)];
		lines.push('', 'Dismiss with `/commitments dismiss <id>`.');
		return lines.join('\n');
	}

	if (sub === 'dismiss') {
		const idStr = parts[2];
		if (!idStr) return 'Usage: `/commitments dismiss <id>`.';
		const id = Number(idStr);
		if (!Number.isFinite(id) || id <= 0) return `"${idStr}" is not a valid commitment id.`;
		// Scope check — only dismiss when the row actually belongs to this
		// sender. Without this, anyone allowlisted could nuke another user's
		// commitments by guessing IDs.
		const owned = listCommitmentsForTarget(channel, senderNumber, 1000).some((c) => c.id === id);
		if (!owned) return `Commitment #${id} not found for your number.`;
		const ok = dismissCommitment(id);
		return ok ? `Dismissed commitment #${id}.` : `Commitment #${id} was already dismissed.`;
	}

	return `Unknown subcommand "${sub}". Try \`/commitments list\` or \`/commitments dismiss <id>\`.`;
}

// ─── Unified inbound dispatch (ADR-001 P1 S3) ──────────────────────────
//
// Single channel-neutral entrypoint for the heartbeat's inbound replies so a
// channel route forwards (channel, target, text) instead of importing each
// handler + the voice-ack primitive directly. Returns { handled: false } for
// non-heartbeat messages — and for a bare done/skip/later when no voice
// surface is pending — so the caller falls through to normal routing.
//
// NOTE: the meta-commands read/write the top-level `heartbeat` config (lifted
// off `channels.whatsapp.heartbeat` in ADR-001 P3). This module stays under
// channels/whatsapp/ as the WhatsApp adapter's slash-command surface (the
// inbound replies arrive over WhatsApp), but it no longer touches channel config.
export async function handleHeartbeatInbound(opts: {
	channel: string;
	target: string;
	text: string;
}): Promise<{ handled: boolean; reply?: string }> {
	const { channel, target, text } = opts;

	if (isHeartbeatMetaCommand(text)) {
		try {
			return { handled: true, reply: await handleHeartbeatMetaCommand(text) };
		} catch (err) {
			return { handled: true, reply: `Heartbeat command failed: ${(err as Error).message}` };
		}
	}

	if (isCommitmentsMetaCommand(text)) {
		try {
			return { handled: true, reply: await handleCommitmentsMetaCommand(text, channel, target) };
		} catch (err) {
			return { handled: true, reply: `Commitments command failed: ${(err as Error).message}` };
		}
	}

	// Voice-queue reply-ack: a bare done/skip/later updates the most-recent
	// auto-acked rows within the 4h window. No recent surface → not handled
	// (the caller treats the word as conversational and falls through).
	const lower = text.trim().toLowerCase();
	if (lower === 'done' || lower === 'skip' || lower === 'later') {
		const method = `reply-${lower}` as ReplyAckMethod;
		const updated = applyReplyAck(method);
		if (updated > 0) {
			const verb =
				method === 'reply-done'
					? 'Marked as done'
					: method === 'reply-skip'
						? 'Skipped'
						: 'Snoozed for 4 hours';
			const noun = updated === 1 ? 'voice-queue item' : `${updated} voice-queue items`;
			return { handled: true, reply: `${verb}: ${noun}.` };
		}
	}

	return { handled: false };
}
