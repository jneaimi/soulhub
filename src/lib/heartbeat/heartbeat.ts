/** Proactive heartbeat — periodic main-session turn that decides whether
 *  to nudge the user via WhatsApp. OpenClaw pattern (see
 *  `~/vault/projects/soul-hub-brain/adr-001-architecture.md`).
 *
 *  Lifecycle:
 *    initHeartbeat()     — call once from adapter.bootstrap(). Wires the
 *                          schedule from current settings. Idempotent;
 *                          safe to call again after `reloadConfig()`.
 *    stopHeartbeat()     — clear the schedule (used on shutdown).
 *    triggerHeartbeat()  — manual run (the `/heartbeat now` slash command).
 */

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { parseProviderRef } from '../llm/types.js';
import { getHeartbeatChannel } from './channel.js';
import { getHeartbeatConfig, type HeartbeatRuntimeConfig } from './config.js';
import { getSoulBody } from './soul-loader.js';
import { getHeartbeatChecklist, type HeartbeatTask } from './heartbeat-loader.js';
import { stripHeartbeatToken } from './heartbeat-ok.js';
import {
	appendLog,
	getDailyCount,
	getDueCommitments,
	dismissCommitment,
	markCommitmentsSurfaced,
	getTaskLastRun,
	incrementDailyCount,
	markVoiceAcked,
	setTaskLastRun,
	ymdInTimezone,
	type CommitmentRow,
	type HeartbeatStatus,
} from '../channels/whatsapp/heartbeat-state.js';
import { getEligibleVoiceItems, type VoiceQueueItem } from '../vault/voice-queue.js';
import { saveProactiveTurn } from '../vault-chat/history.js';

const MUTE_HINT = "\n\n(reply 'mute 24h' to pause)";
const VOICE_ACK_HINT = "\n(reply 'done' / 'skip' / 'later' to ack · 'more' for sources)";

/** "08:00" with a Date and IANA tz → minutes since local midnight. */
function timeStringToMinutes(time: string): number {
	const [h, m] = time.split(':').map(Number);
	return h * 60 + m;
}

function nowMinutesInTimezone(timezone: string, at = Date.now()): number {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const [hh, mm] = fmt.format(new Date(at)).split(':').map(Number);
	return hh * 60 + mm;
}

function withinActiveHours(cfg: HeartbeatRuntimeConfig, at = Date.now()): boolean {
	const start = timeStringToMinutes(cfg.activeHours.start);
	const end = timeStringToMinutes(cfg.activeHours.end);
	const now = nowMinutesInTimezone(cfg.activeHours.timezone, at);
	if (start === end) return false; // zero-width window
	if (start < end) return now >= start && now < end;
	// Wrap-around (e.g. 22:00 → 07:00).
	return now >= start || now < end;
}

function muteActive(cfg: HeartbeatRuntimeConfig): boolean {
	if (!cfg.muteUntil) return false;
	const until = Date.parse(cfg.muteUntil);
	if (Number.isNaN(until)) return false;
	return Date.now() < until;
}

export interface HeartbeatRuntimeStatus {
	enabled: boolean;
	target: string | null;
	withinActiveHours: boolean;
	muteUntil: string | null;
	muteRemainingMs: number | null;
	dailyCount: number;
	dailyCap: number;
	soulPath: string;
	checklistPath: string;
	scheduleDescription: string;
}

/** Snapshot used by the Settings UI status line. Cheap — no LLM, no DB
 *  writes, just config + one daily-counter read. Safe to poll. */
export function getHeartbeatRuntimeStatus(): HeartbeatRuntimeStatus | null {
	const rc = getHeartbeatConfig();
	if (!rc) return null;
	const ymd = ymdInTimezone(rc.activeHours.timezone);
	const dailyCount = rc.delivery.target ? getDailyCount(rc.delivery.target, ymd) : 0;
	const muteUntilMs = rc.muteUntil ? Date.parse(rc.muteUntil) : NaN;
	const muteRemainingMs =
		!Number.isNaN(muteUntilMs) && muteUntilMs > Date.now() ? muteUntilMs - Date.now() : null;
	return {
		enabled: rc.enabled,
		target: rc.delivery.target ?? null,
		withinActiveHours: withinActiveHours(rc),
		muteUntil: rc.muteUntil ?? null,
		muteRemainingMs,
		dailyCount,
		dailyCap: rc.maxPerDay,
		soulPath: rc.soulPath,
		checklistPath: rc.checklistPath,
		scheduleDescription: `within ${rc.activeHours.start}–${rc.activeHours.end} ${rc.activeHours.timezone}`,
	};
}

/** Pick the tasks whose interval has elapsed since their last run. */
function computeDueTasks(tasks: HeartbeatTask[], now = Date.now()): HeartbeatTask[] {
	return tasks.filter((t) => {
		const last = getTaskLastRun(t.name);
		if (last === undefined) return true;
		return now - last >= t.intervalMs;
	});
}

function buildUserPrompt(
	basePrompt: string,
	body: string,
	due: HeartbeatTask[],
	dueCommitments: CommitmentRow[] = [],
	voiceItems: VoiceQueueItem[] = [],
	timezone: string = 'Asia/Dubai',
): string {
	// Current-time anchor — without this the heartbeat model hallucinates
	// the day/date (live 2026-05-11 Monday tick was opened with "Today is
	// Saturday..."). Same fix pattern as the orchestrator system prompt.
	const now = new Date();
	const localNow = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(now);
	const timeAnchor = [
		'## Current time anchor',
		`- User's local time: **${localNow}** (timezone: ${timezone})`,
		`- UTC now: ${now.toISOString()}`,
		'- Use these as ground truth for "today", "this morning", "yesterday", weekday names, etc.',
		'- NEVER open with a wrong day name — if the local time above says Monday, today is Monday.',
	].join('\n');

	const parts: string[] = [timeAnchor, basePrompt];
	if (body.trim()) parts.push(body.trim());
	if (due.length > 0) {
		parts.push('\nDue tasks for this tick:\n');
		for (const t of due) {
			parts.push(`### ${t.name}\n${t.prompt}`);
		}
	}
	if (dueCommitments.length > 0) {
		const userExplicit = dueCommitments.filter((c) => c.source === 'user-explicit');
		const crmFollowups = dueCommitments.filter((c) => c.source === 'crm-followup');
		const extractorInferred = dueCommitments.filter(
			(c) => c.source !== 'user-explicit' && c.source !== 'crm-followup',
		);
		const lines: string[] = [];
		if (userExplicit.length > 0) {
			lines.push(
				'\nReminders the user explicitly set (via `scheduleReminder`):',
				'',
				'These are first-class — surface each one naturally in your message. The user is expecting them at roughly this time. Don\'t skip or paraphrase away the subject. To dismiss after surfacing, the user replies / heartbeat-ack contract is the same as below.',
				'',
			);
			for (const c of userExplicit) {
				lines.push(`[#${c.id}] ${c.suggestedText}`);
			}
			lines.push('');
		}
		if (crmFollowups.length > 0) {
			lines.push(
				'\nCRM follow-ups due now (scheduled via the pipeline):',
				'',
				'These tie to a specific contact in the user\'s CRM. Surface them naturally — by name — and treat them as first-class commitments the user is expecting. If the user replies "done" or "logged", that closes the loop; if they say "snooze 3d", reschedule. Use the same `HEARTBEAT_OK <id>` dismissal contract as the reminders block above.',
				'',
			);
			for (const c of crmFollowups) {
				lines.push(`[#${c.id}] ${c.suggestedText}`);
			}
			lines.push('');
		}
		if (extractorInferred.length > 0) {
			lines.push(
				'\nOpen commitments inferred from prior chats with this user:',
				'',
				'Decide for each whether it still warrants a check-in. If you compose a natural follow-up, weave them in — the user expects a single coherent message, not a list. If none feel relevant, reply `HEARTBEAT_OK` (with no IDs) to dismiss them all. To dismiss only specific ones while still composing about others, append the IDs: `HEARTBEAT_OK 3 7`.',
				'',
			);
			for (const c of extractorInferred) {
				lines.push(`[#${c.id}] ${c.suggestedText}`);
			}
		}
		parts.push(lines.join('\n'));
	}
	if (voiceItems.length > 0) {
		const lines: string[] = [
			'\nVoice-queue items from the vault inbox (per ADR-003 — already ranked by priority + due-date):',
			'',
			"These are nudges the system flagged as voice-eligible. Decide whether any are worth weaving into your message right now. If you compose a message, the surfaced items are auto-acked (won't re-fire). If you reply `HEARTBEAT_OK` they remain pending for the next tick. Don't list them mechanically — pick what's actionable and integrate naturally.",
			'',
		];
		for (const v of voiceItems) {
			const due = v.dueAt ? ` (due ${v.dueAt.toISOString().slice(0, 10)})` : '';
			lines.push(`- [${v.priority}]${due} ${v.summary}`);
			lines.push(`  source: ${v.notePath}`);
		}
		parts.push(lines.join('\n'));
	}
	return parts.join('\n\n');
}

/** Call the configured LLM. v0 wires Gemini; CLI/OpenRouter/Anthropic
 *  surfaces a clear error so the operator knows where to extend. */
async function callModel(opts: {
	model: string;
	system: string;
	user: string;
	abortSignal?: AbortSignal;
}): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
	const { providerId, modelId } = parseProviderRef(opts.model);

	if (providerId === 'gemini') {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			throw new Error('GEMINI_API_KEY is not set — heartbeat cannot run with provider "gemini".');
		}
		const client = createGoogleGenerativeAI({ apiKey });
		const result = await generateText({
			model: client(modelId),
			system: opts.system || undefined,
			prompt: opts.user,
			maxOutputTokens: 600,
			// Disable thinking: the heartbeat is a short ack/nudge, and 2.5
			// Flash will otherwise burn the entire output budget on hidden
			// reasoning, returning a truncated reply (e.g. "HEART" instead
			// of "HEARTBEAT_OK"). See feedback_gemini_thinking_budget.
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
			abortSignal: opts.abortSignal,
		});
		return {
			text: result.text,
			tokensIn: result.usage?.inputTokens,
			tokensOut: result.usage?.outputTokens,
		};
	}

	throw new Error(
		`Heartbeat model provider "${providerId}" is not wired yet. ` +
			'Default `gemini:gemini-2.5-flash` is supported. To use claude-cli/openrouter/anthropic, ' +
			'extend src/lib/heartbeat/heartbeat.ts → callModel.',
	);
}

/** Run one heartbeat tick. Pure side effects: log + maybe deliver. */
export async function runHeartbeatOnce(
	source: 'scheduled' | 'manual' = 'scheduled',
): Promise<{ status: HeartbeatStatus; text?: string }> {
	const rc = getHeartbeatConfig();
	if (!rc?.enabled) {
		return { status: 'error' };
	}
	const hb = rc;
	const channelId = hb.delivery.channel;
	const target = hb.delivery.target;
	if (!target) {
		appendLog({
			ts: Date.now(),
			target: '<unset>',
			status: 'error',
			text: 'heartbeat.delivery.target not configured',
		});
		return { status: 'error' };
	}

	// Gates — order matters. Manual runs skip active-hours/mute (the user
	// explicitly asked) but still respect the daily cap to prevent abuse.
	if (source === 'scheduled') {
		if (!withinActiveHours(hb)) {
			appendLog({ ts: Date.now(), target: target, status: 'gated_active_hours' });
			return { status: 'gated_active_hours' };
		}
		if (muteActive(hb)) {
			appendLog({ ts: Date.now(), target: target, status: 'gated_mute' });
			return { status: 'gated_mute' };
		}
	}
	const ymd = ymdInTimezone(hb.activeHours.timezone);
	if (getDailyCount(target, ymd) >= hb.maxPerDay) {
		appendLog({ ts: Date.now(), target: target, status: 'gated_cap' });
		return { status: 'gated_cap' };
	}

	// Layer 3 Stage 3a anomaly push moved to Telegram per ADR-044.H.
	// The Telegram scheduler task `inbox-anomaly-telegram` fires on the
	// same cadence as this heartbeat and produces a digest-style
	// highlight bubble WITH the 4-button inline keyboard (Save / Archive
	// / Mute / Draft). The WhatsApp anomaly rail is retired.

	const checklist = getHeartbeatChecklist(hb.checklistPath);
	const dueTasks = computeDueTasks(checklist.tasks);

	// Slice 5 — fetch due commitments for this (channel, target) pair so
	// the agent can weave them into a check-in. Cheap query (indexed on
	// channel+target+status+due_after_ts).
	//
	// ADR-025 — two-slice fetch. Extractor-inferred rows respect the
	// existing `rc.commitments.maxPerDay` per-tick slice cap and only
	// fire when the extractor is enabled. User-explicit reminders (set
	// via the `scheduleReminder` orchestrator tool) ride a separate cap
	// (`rc.reminders.maxPerDay`) and fire regardless of the extractor
	// toggle — they're set by the user, not inferred.
	const dueExtractor = rc.commitments.enabled && target
		? getDueCommitments(channelId, target, { source: 'extractor' })
				.slice(0, rc.commitments.maxPerDay)
		: [];
	const dueReminders = rc.reminders.enabled && target
		? getDueCommitments(channelId, target, { source: 'user-explicit' })
				.slice(0, rc.reminders.maxPerDay)
		: [];
	// ADR-CRM §D6 — CRM-scheduled follow-ups share the reminders cap +
	// gate. They're user-explicit-in-spirit (operator set them via the
	// CRM UI / `crm-set-followup` chat tool) and shouldn't be drowned by
	// extractor-inferred noise.
	const dueCrmFollowups = rc.reminders.enabled && target
		? getDueCommitments(channelId, target, { source: 'crm-followup' })
				.slice(0, rc.reminders.maxPerDay)
		: [];
	const dueCommitments = [...dueReminders, ...dueCrmFollowups, ...dueExtractor];

	// Phase 4 / ADR-003 — voice-queue items from the inbox. Same shape
	// of input as commitments: scoped query, capped, fed to the agent.
	// Cap at 5 to keep the prompt bounded (agents pick what's useful).
	const voiceItems = getEligibleVoiceItems({ limit: 5 });

	// Empty checklist + no commitments + no voice items → no-op, no API
	// call. We allow a tick when any of those are present so the agent
	// has something to consider even if HEARTBEAT.md is bare.
	const checklistEmpty =
		checklist.isEmpty ||
		(checklist.tasks.length > 0 && dueTasks.length === 0 && !checklist.body.trim());
	if (checklistEmpty && dueCommitments.length === 0 && voiceItems.length === 0) {
		appendLog({ ts: Date.now(), target: target, status: 'skipped_empty' });
		return { status: 'skipped_empty' };
	}

	// Compose + call.
	const system = getSoulBody(hb.soulPath);
	const user = buildUserPrompt(
		hb.basePrompt,
		checklist.body,
		dueTasks,
		dueCommitments,
		voiceItems,
		hb.activeHours.timezone,
	);

	let modelResult: { text: string; tokensIn?: number; tokensOut?: number };
	try {
		modelResult = await callModel({ model: hb.model, system, user });
	} catch (err) {
		appendLog({
			ts: Date.now(),
			target: target,
			status: 'error',
			text: (err as Error).message,
			model: hb.model,
		});
		return { status: 'error' };
	}

	const ack = stripHeartbeatToken(modelResult.text, { ackMaxChars: hb.ackMaxChars });

	// Advance task_state for every fired task whether or not we delivered —
	// the LLM has "considered" them this tick; re-running with the same
	// inputs would just produce the same ack.
	for (const t of dueTasks) {
		setTaskLastRun(t.name);
	}

	const includedCommitmentIds = dueCommitments.map((c) => c.id);

	// Apply commitment dismissals first so the per-tick "surfaced" mark
	// below doesn't include rows the agent explicitly nuked.
	for (const id of ack.dismissedIds) {
		if (includedCommitmentIds.includes(id)) {
			dismissCommitment(id);
		}
	}

	if (ack.shouldSkip) {
		// HEARTBEAT_OK without IDs → dismiss every included commitment
		// (the agent saw them all and judged none worth surfacing).
		// HEARTBEAT_OK with IDs → only those got dismissed above; the
		// rest stay pending for the next tick.
		if (ack.dismissedIds.length === 0 && includedCommitmentIds.length > 0) {
			for (const id of includedCommitmentIds) {
				dismissCommitment(id);
			}
		}
		appendLog({
			ts: Date.now(),
			target: target,
			status: 'ack',
			text: modelResult.text.trim(),
			tokensIn: modelResult.tokensIn,
			tokensOut: modelResult.tokensOut,
			model: hb.model,
		});
		return { status: 'ack' };
	}

	const voiceHint = voiceItems.length > 0 ? VOICE_ACK_HINT : '';
	const finalText = ack.cleanText + voiceHint + MUTE_HINT;
	// Deliver through the channel-neutral seam (ADR-001 P1). The heartbeat is
	// Delivery channel comes from config (ADR-001 P3 `delivery.channel`), so the
	// heartbeat can target any channel with a registered HeartbeatChannel adapter.
	const channel = getHeartbeatChannel(channelId);
	if (!channel) {
		appendLog({
			ts: Date.now(),
			target: target,
			status: 'error',
			text: `no heartbeat channel registered for "${channelId}"`,
			tokensIn: modelResult.tokensIn,
			tokensOut: modelResult.tokensOut,
			model: hb.model,
		});
		return { status: 'error' };
	}
	const delivery = await channel.deliver(target, finalText);
	if (!delivery.ok) {
		appendLog({
			ts: Date.now(),
			target: target,
			status: 'error',
			text: `delivery failed: ${delivery.error ?? 'unknown'}`,
			tokensIn: modelResult.tokensIn,
			tokensOut: modelResult.tokensOut,
			model: hb.model,
		});
		return { status: 'error' };
	}

	// Delivered → mark remaining commitments (those not explicitly
	// dismissed above) as surfaced so they don't re-fire next tick.
	const toSurface = includedCommitmentIds.filter((id) => !ack.dismissedIds.includes(id));
	if (toSurface.length > 0) {
		markCommitmentsSurfaced(toSurface);
	}

	// Phase 4 / ADR-003 auto-ack — voice items that were included in the
	// agent's prompt are marked acked once delivery succeeds (regardless
	// of whether the message text references them; the agent saw them).
	// HEARTBEAT_OK paths skip this — items remain pending in the queue
	// for another tick. Same for delivery failures.
	if (voiceItems.length > 0) {
		markVoiceAcked(
			voiceItems.map((v) => v.notePath),
			'auto',
		);
	}

	incrementDailyCount(target, ymd);
	appendLog({
		ts: Date.now(),
		target: target,
		status: 'sent',
		text: ack.cleanText,
		tokensIn: modelResult.tokensIn,
		tokensOut: modelResult.tokensOut,
		model: hb.model,
	});
	// Per ADR-021: register the heartbeat in chat_history so the user's next
	// reply ("yes do it" / "what was that?") has a topic anchor. Use the clean
	// text — the mute/voice hints below it are UI affordance, not content
	// the LLM should answer about. Conversation key matches the WhatsApp
	// inbound side: bare E.164 for DM targets.
	saveProactiveTurn(target, ack.cleanText, 'heartbeat');
	return { status: 'sent', text: ack.cleanText };
}

/** Manual trigger. Returns the run status; suitable for slash commands
 *  and HTTP wake endpoints. */
export async function triggerHeartbeat(): Promise<{ status: HeartbeatStatus; text?: string }> {
	return runHeartbeatOnce('manual');
}

// ADR-001 P3 — the engine no longer owns a private timer. Cadence is a
// scheduler `heartbeat` trigger-type (`src/lib/scheduler/handlers/heartbeat.ts`)
// firing `runHeartbeatOnce('scheduled')`; vault-hygiene runs as its own
// scheduler task. Manual runs still go through `triggerHeartbeat` above.
