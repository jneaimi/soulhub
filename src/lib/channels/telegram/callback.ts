/** Inline-keyboard `callback_query` handler.
 *
 *  Telegram inline-keyboard buttons fire a `callback_query` with the
 *  button's `callback_data` payload. Button families:
 *
 *  1. **Proposal** (ADR-011) — verbs `confirm` / `decline` / `web`.
 *     Resolved by re-entering the inbound dispatcher with a synthetic
 *     "yes" / "no" / "search" message so the orchestrator's proposal
 *     pipeline runs identically to a typed reply.
 *
 *  2. **YouTube follow-up** (ADR-014) — verbs `yt-save` / `yt-tx` /
 *     `yt-skip`. Resolved INLINE (no orchestrator round-trip) because
 *     the user's intent is unambiguous and we already cached the video
 *     context from the prior summary turn. Skipping the LLM saves
 *     latency + cost.
 *
 *  3. **Hygiene remediation** (ADR-042) — verbs `hyg-arc` (+ confirm
 *     `hyg-arc-y` / cancel `hyg-arc-n`), `hyg-pause`, `hyg-ig`.
 *     Triggered by keeper escalations for project-hygiene anomalies.
 *     Resolved INLINE; archive uses confirm-then-execute since the
 *     file move is destructive (reversible via git, but worth one
 *     extra tap to prevent misclicks).
 *
 *  callback_data layout: `<verb>:<short_id>` where short_id is the
 *  base64url'd SHA-1 of the conversationKey, fitting inside Telegram's
 *  64-byte cap and avoiding leaking the raw key (DM ids look like phone
 *  numbers when prefixed). short_id → payload mappings are persisted in
 *  the shared ops.db (`pending_callbacks` table) so a PM2 reload between
 *  sending a button and the operator tapping it no longer orphans the
 *  action (soul-hub-hygiene ADR-003 P6). Each surface gets its own
 *  `makePendingStore(kind, ttl)` — a Map-shaped wrapper over that table. */

import { createHash } from 'node:crypto';
import { makePendingStore } from './pending-callbacks.js';
import { answerCallbackQuery, editMessageText } from './client.js';
import { sendText } from './outbound.js';
import { dispatchInbound, conversationKeyFor } from './dispatch.js';
import { dispatchVaultSave } from '../../vault-save/index.js';
import { fetchYoutube } from '../../youtube/index.js';
import {
	archiveProject,
	reconcileDualStatus,
	scaffoldProjectIndex,
	setPauseUntil,
	setProjectStatus,
	setReviewDate,
	suppressAnomaly,
	touchProjectUpdated,
} from '../../vault-hygiene/actions.js';
import {
	archiveOrphanNote,
	dropStaleInboxItem,
	unlinkBrokenWikilink,
} from '../../vault-hygiene/link-actions.js';
import {
	archiveInboxMessage,
	draftInboxReply,
	muteInboxSender,
	saveInboxToVault,
} from '../../inbox/inline-actions.js';
import { getMessage as getInboxMessage } from '../../inbox/index.js';
import { findContactByEmail } from '../../crm/index.js';
import { getVaultEngine } from '../../vault/index.js';
import { dispatchAgent } from '../../agents/dispatch/index.js';
import {
	getBudgetApproval,
	deleteBudgetApproval,
	resumeWithRaisedBudget,
	stopBudgetApproval,
	BUDGET_BUMPS,
} from '../../agents/budget-escalation.js';
import {
	formatKeeperTask,
	parseKeeperResult,
	formatTelegramResult,
	formatBatchList,
} from '../../vault-hygiene/link-fix-payload.js';
import {
	getYoutubeCount,
	incrementYoutubeCount,
	ymdInTimezone,
} from '../whatsapp/heartbeat-state.js';
import {
	listProposed,
	getProposed,
	promoteProposal,
	rejectProposal,
	promoteAllInBatch,
	deferBatch,
	type ProposedRow,
} from '../../intent/patterns.js';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import type {
	InboundEnvelope,
	InlineKeyboardMarkup,
	TelegramChannelConfig,
	TgCallbackQuery,
} from './types.js';

type Verb = 'confirm' | 'decline' | 'web';
type YoutubeVerb = 'yt-save' | 'yt-tx' | 'yt-skip';
type IntentVerb = 'ip-review' | 'ip-all' | 'ip-skip' | 'ip-yes' | 'ip-no';
type HygieneVerb =
	| 'hyg-arc'
	| 'hyg-arc-y'
	| 'hyg-arc-n'
	| 'hyg-pause'
	| 'hyg-ig'
	// Pass 3 verbs (ADR-042)
	| 'hyg-touch' // bump updated: field (stale_active_*)
	| 'hyg-active' // status → active (no_status default)
	| 'hyg-recon' // status → maintained (stale_active_30)
	| 'hyg-scaffold' // write template index.md (missing_index)
	// Pass 4 verbs (ADR-042)
	| 'hyg-use-idx' // dual_file_disagree: copy index.md status → project.md
	| 'hyg-use-proj' // dual_file_disagree: copy project.md status → index.md
	| 'hyg-snooze' // falsifier_due_soon: push review_date +14d
	| 'hyg-reviewed'; // falsifier_due_soon: push review_date +90d (fresh cycle)

// ADR-044 — inbox-digest verbs (ibx- prefix).
// Save/Archive/Reply are direct-execute (fully reversible).
// Mute branches: direct for non-CRM senders, confirm-then-execute when
// the sender is a known CRM contact (Lead/In Conversation muting is a
// real footgun).
type InboxVerb =
	| 'ibx-save' // direct: vault save to email/<YYYY-MM>/
	| 'ibx-arc' // direct: process_status='archived'
	| 'ibx-mute' // first tap — branches on CRM hit
	| 'ibx-mute-y' // confirmed mute of a CRM contact
	| 'ibx-mute-n' // cancelled
	| 'ibx-reply'; // direct: background scribe dispatch

// ADR-006 Phase 2 — budget-approval verbs (bgt- prefix). A paused background
// run that hit its ceiling; the operator grants more (resume via claude --resume)
// or stops (keep partial). Resolved INLINE.
type BudgetVerb = 'bgt-u2' | 'bgt-u5' | 'bgt-t10' | 'bgt-stop';

// ADR-043 — vault-hygiene verbs (vh- prefix, distinct from project-hygiene hyg-)
type VaultHygieneVerb =
	| 'vh-unlink' // first tap on broken_link — swap to confirm/cancel
	| 'vh-unlink-y' // confirmed — rewrites the wikilink to its display text
	| 'vh-unlink-n' // cancelled
	| 'vh-ig' // suppress (source, raw) for 30 days
	// Pass 2 verbs
	| 'vh-orphan-arc' // first tap on orphan_note → swap to confirm/cancel
	| 'vh-orphan-arc-y' // confirmed → archiveOrphanNote()
	| 'vh-orphan-arc-n' // cancelled
	| 'vh-inbox-drop' // first tap on stale_inbox_item → swap to confirm/cancel
	| 'vh-inbox-drop-y' // confirmed → dropStaleInboxItem()
	| 'vh-inbox-drop-n' // cancelled
	// Bulk fix-broken-links — aggregate digest with one button row per batch.
	// vh-fix-all dispatches the keeper agent against the batch; the other
	// two are pure text-edits on the aggregate message.
	| 'vh-fix-all' // dispatch keeper to bulk-fix the batch
	| 'vh-fix-list' // expand the aggregate to a text-only enumeration
	| 'vh-fix-skip'; // dismiss this batch (reappears in next digest)

interface PendingButtonRow {
	conversationKey: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

interface PendingYoutubeRow {
	conversationKey: string;
	chatJid: string;
	senderId: string;
	messageId: number;
	videoUrl: string;
	title: string;
	summary: string;
	createdAt: number;
}

/** short_id → conversation key store. SHA-1 keeps us inside Telegram's
 *  64-byte callback_data cap; the payload is persisted in ops.db
 *  (`pending_callbacks`, kind `proposal`) per ADR-003 P6. */
const PENDING_TTL_MS = 60 * 60 * 1000; // 1h matches proposal grace
const pendingButtons = makePendingStore<PendingButtonRow>('proposal', PENDING_TTL_MS);

function shortIdFor(conversationKey: string): string {
	return createHash('sha1').update(conversationKey).digest('base64url').slice(0, 16);
}

export function buildProposalKeyboard(conversationKey: string): InlineKeyboardMarkup {
	const id = shortIdFor(conversationKey);
	return {
		inline_keyboard: [
			[
				{ text: '✅ Yes — run it', callback_data: `confirm:${id}` },
				{ text: '🌐 Web search', callback_data: `web:${id}` },
			],
			[{ text: '✗ Drop it', callback_data: `decline:${id}` }],
		],
	};
}

/** Stash the (conversationKey, chatJid, messageId) for a freshly-rendered
 *  proposal so the callback handler can resolve which conversation a
 *  button-tap belongs to. Older entries are GC'd lazily. */
export function rememberProposalButtons(
	conversationKey: string,
	chatJid: string,
	messageId: number,
): void {
	const id = shortIdFor(conversationKey);
	pendingButtons.set(id, {
		conversationKey,
		chatJid,
		messageId,
		createdAt: Date.now(),
	});
	// `.set` sweeps expired rows; no separate GC pass needed.
}

// ─── YouTube follow-up keyboard (ADR-014) ──────────────────────────────

/** Per-conversation cache of the most-recent YouTube reply that has
 *  follow-up buttons attached. Keyed by short_id (same scheme as
 *  proposal buttons) so callback_data stays compact. Only one row per
 *  conversation — a fresh YouTube turn replaces the prior cache. */
const pendingYoutubeButtons = makePendingStore<PendingYoutubeRow>('youtube', PENDING_TTL_MS);

export function buildYoutubeKeyboard(conversationKey: string): InlineKeyboardMarkup {
	const id = shortIdFor(conversationKey);
	return {
		inline_keyboard: [
			[
				{ text: '💾 Save to vault', callback_data: `yt-save:${id}` },
				{ text: '📄 Full transcript', callback_data: `yt-tx:${id}` },
			],
			[{ text: '✗ Skip', callback_data: `yt-skip:${id}` }],
		],
	};
}

export function rememberYoutubeButtons(args: {
	conversationKey: string;
	chatJid: string;
	senderId: string;
	messageId: number;
	videoUrl: string;
	title: string;
	summary: string;
}): void {
	const id = shortIdFor(args.conversationKey);
	pendingYoutubeButtons.set(id, {
		...args,
		createdAt: Date.now(),
	});
	// `.set` sweeps expired rows; no separate GC pass needed.
}

type ProposalParse = { kind: 'proposal'; verb: Verb; id: string };
type YoutubeParse = { kind: 'youtube'; verb: YoutubeVerb; id: string };
type IntentParse = { kind: 'intent'; verb: IntentVerb; id: string };
type HygieneParse = { kind: 'hygiene'; verb: HygieneVerb; id: string };
type VaultHygieneParse = { kind: 'vault-hygiene'; verb: VaultHygieneVerb; id: string };
type InboxParse = { kind: 'inbox'; verb: InboxVerb; id: string };
type BudgetParse = { kind: 'budget'; verb: BudgetVerb; id: string };
type ParsedCallback =
	| ProposalParse
	| YoutubeParse
	| IntentParse
	| HygieneParse
	| VaultHygieneParse
	| InboxParse
	| BudgetParse;

function parseCallbackData(data: string): ParsedCallback | null {
	const i = data.indexOf(':');
	if (i === -1) return null;
	const verb = data.slice(0, i);
	const id = data.slice(i + 1);
	if (!id) return null;
	if (verb === 'confirm' || verb === 'decline' || verb === 'web') {
		return { kind: 'proposal', verb, id };
	}
	if (verb === 'yt-save' || verb === 'yt-tx' || verb === 'yt-skip') {
		return { kind: 'youtube', verb, id };
	}
	if (
		verb === 'ip-review' ||
		verb === 'ip-all' ||
		verb === 'ip-skip' ||
		verb === 'ip-yes' ||
		verb === 'ip-no'
	) {
		return { kind: 'intent', verb, id };
	}
	if (
		verb === 'hyg-arc' ||
		verb === 'hyg-arc-y' ||
		verb === 'hyg-arc-n' ||
		verb === 'hyg-pause' ||
		verb === 'hyg-ig' ||
		verb === 'hyg-touch' ||
		verb === 'hyg-active' ||
		verb === 'hyg-recon' ||
		verb === 'hyg-scaffold' ||
		verb === 'hyg-use-idx' ||
		verb === 'hyg-use-proj' ||
		verb === 'hyg-snooze' ||
		verb === 'hyg-reviewed'
	) {
		return { kind: 'hygiene', verb, id };
	}
	if (
		verb === 'vh-unlink' ||
		verb === 'vh-unlink-y' ||
		verb === 'vh-unlink-n' ||
		verb === 'vh-ig' ||
		verb === 'vh-orphan-arc' ||
		verb === 'vh-orphan-arc-y' ||
		verb === 'vh-orphan-arc-n' ||
		verb === 'vh-inbox-drop' ||
		verb === 'vh-inbox-drop-y' ||
		verb === 'vh-inbox-drop-n' ||
		verb === 'vh-fix-all' ||
		verb === 'vh-fix-list' ||
		verb === 'vh-fix-skip'
	) {
		return { kind: 'vault-hygiene', verb, id };
	}
	if (
		verb === 'ibx-save' ||
		verb === 'ibx-arc' ||
		verb === 'ibx-mute' ||
		verb === 'ibx-mute-y' ||
		verb === 'ibx-mute-n' ||
		verb === 'ibx-reply'
	) {
		return { kind: 'inbox', verb, id };
	}
	if (verb === 'bgt-u2' || verb === 'bgt-u5' || verb === 'bgt-t10' || verb === 'bgt-stop') {
		return { kind: 'budget', verb, id };
	}
	return null;
}

const VERB_TO_REPLY: Record<Verb, string> = {
	confirm: 'yes',
	decline: 'no',
	web: 'search',
};

const VERB_TO_CONFIRMATION: Record<Verb, string> = {
	confirm: '✅ Running it.',
	decline: '✗ Dropped.',
	web: '🌐 Searching the web instead.',
};

/** Handle a `callback_query` Update. Routes to the proposal-button or
 *  YouTube-button handler based on the parsed verb. */
export async function handleCallbackQuery(
	query: TgCallbackQuery,
	config: TelegramChannelConfig,
	account = 'personal',
): Promise<void> {
	const data = query.data ?? '';
	const parsed = parseCallbackData(data);
	if (!parsed) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Unknown action',
		});
		return;
	}

	if (parsed.kind === 'proposal') {
		await handleProposalCallback(query, parsed, config, account);
		return;
	}
	if (parsed.kind === 'intent') {
		await handleIntentCallback(query, parsed, config);
		return;
	}
	if (parsed.kind === 'hygiene') {
		await handleHygieneCallback(query, parsed, config);
		return;
	}
	if (parsed.kind === 'vault-hygiene') {
		await handleVaultHygieneCallback(query, parsed, config);
		return;
	}
	if (parsed.kind === 'inbox') {
		await handleInboxCallback(query, parsed, config);
		return;
	}
	if (parsed.kind === 'budget') {
		await handleBudgetCallback(query, parsed);
		return;
	}
	await handleYoutubeCallback(query, parsed, config);
}

/** Proposal-button branch (ADR-011). Resolves the button to its
 *  conversation, then re-enters the inbound dispatcher with a synthetic
 *  text message ("yes" / "no" / "search") so the proposal-confirmation
 *  pathway runs identically to a typed reply. */
async function handleProposalCallback(
	query: TgCallbackQuery,
	parsed: ProposalParse,
	config: TelegramChannelConfig,
	account: string,
): Promise<void> {
	const row = pendingButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Buttons expired — send a new message to retry.',
			show_alert: false,
		});
		return;
	}

	await answerCallbackQuery({
		callback_query_id: query.id,
		text: VERB_TO_CONFIRMATION[parsed.verb],
	});

	try {
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: `${VERB_TO_CONFIRMATION[parsed.verb]}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — buttons may already be gone */
	}

	pendingButtons.delete(parsed.id);

	const synthetic: InboundEnvelope = {
		chatJid: row.chatJid,
		isGroup: row.chatJid.startsWith('-'),
		senderNumber: query.from.id ? String(query.from.id) : row.chatJid,
		botMentioned: false,
		body: VERB_TO_REPLY[parsed.verb],
		messageId: '',
		raw: {
			message_id: 0,
			chat: { id: Number(row.chatJid), type: 'private' },
			date: Math.floor(Date.now() / 1000),
			text: VERB_TO_REPLY[parsed.verb],
		},
	};

	const expected = row.conversationKey;
	const derived = conversationKeyFor(synthetic);
	if (derived !== expected) {
		await sendText(
			row.chatJid,
			"Couldn't link that button to the original conversation — please reply with `yes` / `no` / `search` instead.",
			config.delivery,
		);
		return;
	}

	await dispatchInbound(synthetic, config, account);
}

/** Budget-approval branch (ADR-006 Phase 2). A pausable background run hit its
 *  hard ceiling and paused, preserving its Claude session. A bump tap raises the
 *  ceiling and resumes via `claude --resume` (fire-and-forget — the run
 *  re-surfaces via the normal finish/escalation path); Stop keeps the partial
 *  result and flips the run terminal. Resolved INLINE — no orchestrator. */
async function handleBudgetCallback(query: TgCallbackQuery, parsed: BudgetParse): Promise<void> {
	const row = getBudgetApproval(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Budget request expired — the run was already closed out.',
			show_alert: false,
		});
		return;
	}

	if (parsed.verb === 'bgt-stop') {
		stopBudgetApproval(row);
		await answerCallbackQuery({ callback_query_id: query.id, text: '🛑 Stopped — partial kept.' });
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: `🛑 Stopped \`${row.agentId}\` at the ceiling — partial result kept.\n_(button tapped)_`,
			parse_mode: 'Markdown',
		}).catch(() => {});
		return;
	}

	// Bump verbs — narrowed to keyof BUDGET_BUMPS now that 'bgt-stop' is handled.
	const bump = BUDGET_BUMPS[parsed.verb];
	const raised = resumeWithRaisedBudget(row, bump);
	deleteBudgetApproval(parsed.id);
	const grant =
		parsed.verb === 'bgt-t10'
			? `+10 turns (ceiling ${raised.ceilingTurns})`
			: `+$${raised.ceilingUsd - row.ceilingUsd} (ceiling $${raised.ceilingUsd})`;
	await answerCallbackQuery({ callback_query_id: query.id, text: `▶️ Resuming — ${grant}` });
	await editMessageText({
		chat_id: row.chatJid,
		message_id: row.messageId,
		text: `▶️ Resuming \`${row.agentId}\` — ${grant}.\n_(button tapped)_`,
		parse_mode: 'Markdown',
	}).catch(() => {});
}

/** YouTube follow-up branch (ADR-014). Bypasses the orchestrator —
 *  the user's intent is unambiguous (they tapped a specific button) and
 *  we already cached the video context, so going through the LLM would
 *  add latency + cost without changing the outcome.
 *
 *  - yt-save: dispatch vaultSave with cached title/summary/url
 *  - yt-tx:   re-fetch via youtubeFetch with mode=transcript (consumes
 *             the per-day Gemini quota, same as the original tool path)
 *  - yt-skip: just strip buttons + ack */
async function handleYoutubeCallback(
	query: TgCallbackQuery,
	parsed: YoutubeParse,
	config: TelegramChannelConfig,
): Promise<void> {
	const row = pendingYoutubeButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Buttons expired — paste the link again to retry.',
			show_alert: false,
		});
		return;
	}

	if (parsed.verb === 'yt-skip') {
		await answerCallbackQuery({ callback_query_id: query.id, text: '✗ Dismissed.' });
		await stripYoutubeButtons(row, '✗ Dismissed.');
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	if (parsed.verb === 'yt-save') {
		// Acknowledge fast — vault writes are quick but we want the spinner
		// gone within Telegram's ~10s window.
		await answerCallbackQuery({ callback_query_id: query.id, text: '💾 Saving…' });
		const outcome = await dispatchVaultSave({
			title: row.title,
			content: buildSaveBody(row),
			type: 'reference',
			tags: ['youtube', 'video'],
			sourceUrl: row.videoUrl,
			channel: 'telegram',
		});
		if (outcome.ok) {
			await stripYoutubeButtons(row, `💾 Saved as *${row.title}* — ${outcome.openUrl}`);
		} else {
			await stripYoutubeButtons(row, `Couldn't save: ${outcome.error}`);
		}
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	// yt-tx — full transcript fetch. Re-checks the per-day Gemini quota
	// the same way the youtubeFetch tool does so a button-tap can't bypass
	// the cap.
	await answerCallbackQuery({ callback_query_id: query.id, text: '📄 Fetching transcript…' });

	const ytConfig = readYoutubeConfig();
	if (!ytConfig?.enabled) {
		await sendText(
			row.chatJid,
			'Transcript fetch is disabled in settings.',
			config.delivery,
		);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	const tz = 'Asia/Dubai';
	const today = ymdInTimezone(tz);
	const count = getYoutubeCount(row.senderId, today);
	const overCap = count >= ytConfig.maxPerDay;

	const out = await fetchYoutube(row.videoUrl, {
		mode: 'transcript',
		youtubeConfig: ytConfig,
		transcriptQuotaExceeded: overCap,
	});

	if (!out.ok) {
		await sendText(
			row.chatJid,
			`Couldn't fetch transcript: ${out.error.error}`,
			config.delivery,
		);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	if (out.result.transcriptSource === 'gemini' && !overCap) {
		incrementYoutubeCount(row.senderId, today);
	}

	const transcript = out.result.transcript;
	if (!transcript) {
		const note =
			out.result.note === 'transcript-quota-exceeded'
				? "Transcript budget for today is used up — try again tomorrow."
				: "Couldn't get a transcript for this video — Gemini may have refused or there's no usable audio.";
		await sendText(row.chatJid, note, config.delivery);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	await stripYoutubeButtons(row, '📄 Transcript sent below.');
	await sendText(
		row.chatJid,
		`*${row.title}* — full transcript:\n\n${transcript}`,
		config.delivery,
	);
	pendingYoutubeButtons.delete(parsed.id);
}

/** Build the markdown body for the saved note. Keeps the structure
 *  consistent with the LLM-composed save body — title-less (vault renderer
 *  adds the title), summary first, source link last. */
function buildSaveBody(row: PendingYoutubeRow): string {
	return [
		row.summary.trim(),
		'',
		`Source: ${row.videoUrl}`,
	].join('\n');
}

async function stripYoutubeButtons(row: PendingYoutubeRow, status: string): Promise<void> {
	try {
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: `${status}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — message may already be edited or deleted */
	}
}

/** Read the YouTube config slice the same way the inbound dispatcher
 *  does (ADR-012). Keeps the settings source-of-truth in one place. */
function readYoutubeConfig() {
	const parsed = WhatsAppChannelSchema.safeParse(soulHubConfig.channels?.whatsapp ?? {});
	if (!parsed.success) return undefined;
	const yt = parsed.data.youtube;
	return { enabled: yt.enabled, maxPerDay: yt.maxPerDay, model: yt.model };
}

// ─── Intent-pattern approval keyboard (ADR-023 P1.5) ──────────────────

/** short_id → batchId. Populated by `registerIntentBatchButtons` when the
 *  analyst run sends its nudge. Persisted in ops.db (kind `intent-batch`) per
 *  ADR-003 P6; the `/api/intent/proposed` endpoints remain a manual fallback. */
const pendingIntentBatches = makePendingStore<{ batchId: string; createdAt: number }>(
	'intent-batch',
	PENDING_TTL_MS,
);

/** short_id → proposalId. Populated when [Review] fans the batch out into
 *  one message per proposal. Persisted (kind `intent-proposal`) per ADR-003 P6. */
const pendingIntentProposals = makePendingStore<{
	proposalId: number;
	chatId: string | number;
	messageId: number;
	createdAt: number;
}>('intent-proposal', PENDING_TTL_MS);

/** Stable short_id derivation. Same scheme as the proposal+YouTube
 *  flows so callback_data stays ≤64 bytes. */
function shortIdForString(s: string): string {
	return createHash('sha1').update(s).digest('base64url').slice(0, 16);
}

/** Called by the learner when it sends the operator nudge — registers the
 *  mapping so callback_data can carry a compact short_id while the handler
 *  resolves it back to the real batchId. Lazy-GCs aged entries. */
export function registerIntentBatchButtons(batchId: string): string {
	const id = shortIdForString(batchId);
	pendingIntentBatches.set(id, { batchId, createdAt: Date.now() });
	// `.set` sweeps expired rows; no separate GC pass needed.
	return id;
}

function buildIntentProposalKeyboard(proposalId: number): InlineKeyboardMarkup {
	const id = shortIdForString(`p:${proposalId}`);
	return {
		inline_keyboard: [
			[
				{ text: '✅ Approve', callback_data: `ip-yes:${id}` },
				{ text: '✗ Reject', callback_data: `ip-no:${id}` },
			],
		],
	};
}

function formatProposalForReview(row: ProposedRow): string {
	const lines = [
		`*Pattern* \`${row.signature}\` (${row.matchKind})`,
		`→ route: \`${row.pickedRoute}\`  ·  confidence: ${row.confidence.toFixed(2)}`,
	];
	if (row.placeholderText) lines.push(`bubble: "${row.placeholderText}"`);
	if (row.conversationKey) lines.push(`scope: per-user (\`${row.conversationKey.slice(0, 32)}\`)`);
	else lines.push(`scope: global`);
	if (row.rationale) lines.push(`\n${row.rationale}`);
	lines.push('');
	lines.push('*Citations:*');
	for (const c of row.citations.slice(0, 5)) {
		lines.push(`• ${c.replace(/[*_`]/g, ' ').slice(0, 200)}`);
	}
	return lines.join('\n');
}

async function handleIntentCallback(
	query: TgCallbackQuery,
	parsed: IntentParse,
	config: TelegramChannelConfig,
): Promise<void> {
	const chatId = query.message?.chat?.id;
	const messageId = query.message?.message_id;

	if (parsed.verb === 'ip-yes' || parsed.verb === 'ip-no') {
		const row = pendingIntentProposals.get(parsed.id);
		if (!row) {
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: 'Buttons expired — open /orchestration/tools to resolve manually.',
				show_alert: false,
			});
			return;
		}
		if (parsed.verb === 'ip-yes') {
			const r = promoteProposal(row.proposalId);
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: r.ok ? '✅ Approved' : `Couldn't approve: ${r.error}`,
			});
			await stripIntentButtons(row.chatId, row.messageId, r.ok ? '✅ Approved.' : `✗ ${r.error}`);
		} else {
			const r = rejectProposal(row.proposalId, 'rejected via Telegram button');
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: r.ok ? '✗ Rejected' : `Couldn't reject: ${r.error}`,
			});
			await stripIntentButtons(row.chatId, row.messageId, r.ok ? '✗ Rejected.' : `✗ ${r.error}`);
		}
		pendingIntentProposals.delete(parsed.id);
		return;
	}

	// Batch-level verbs need a registered batchId.
	const batchEntry = pendingIntentBatches.get(parsed.id);
	if (!batchEntry) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Batch expired — open the proposals API to resolve manually.',
			show_alert: false,
		});
		return;
	}
	const { batchId } = batchEntry;

	if (parsed.verb === 'ip-all') {
		const r = promoteAllInBatch(batchId);
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `✅ ${r.promoted} approved${r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}`,
		});
		if (chatId !== undefined && messageId !== undefined) {
			await editMessageText({
				chat_id: chatId,
				message_id: messageId,
				text: `✅ All ${r.promoted} pattern${r.promoted === 1 ? '' : 's'} approved.`,
				parse_mode: 'Markdown',
			}).catch(() => {});
		}
		pendingIntentBatches.delete(parsed.id);
		return;
	}

	if (parsed.verb === 'ip-skip') {
		const r = deferBatch(batchId);
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `Skipped (${r.deferred})`,
		});
		if (chatId !== undefined && messageId !== undefined) {
			await editMessageText({
				chat_id: chatId,
				message_id: messageId,
				text: `✗ Skipped — ${r.deferred} pattern${r.deferred === 1 ? '' : 's'} deferred.`,
				parse_mode: 'Markdown',
			}).catch(() => {});
		}
		pendingIntentBatches.delete(parsed.id);
		return;
	}

	// ip-review — fan out per-proposal bubbles.
	if (parsed.verb === 'ip-review') {
		const proposals = listProposed({ batchId });
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `Sending ${proposals.length} pattern${proposals.length === 1 ? '' : 's'}…`,
		});
		if (proposals.length === 0) return;

		if (chatId === undefined) return;
		for (const p of proposals) {
			const proposalShortId = shortIdForString(`p:${p.id}`);
			const text = formatProposalForReview(p);
			const sent = await sendText(chatId, text, config.delivery, {
				replyMarkup: buildIntentProposalKeyboard(p.id),
			});
			const sentMessageId = sent.messageIds[0];
			if (sent.ok && sentMessageId !== undefined) {
				pendingIntentProposals.set(proposalShortId, {
					proposalId: p.id,
					chatId,
					messageId: sentMessageId,
					createdAt: Date.now(),
				});
			}
		}
		// `.set` sweeps expired rows; no separate GC pass needed.
	}
}

async function stripIntentButtons(
	chatId: string | number,
	messageId: number,
	status: string,
): Promise<void> {
	try {
		await editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: `${status}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — message may already be edited or deleted */
	}
}

// ─── Hygiene remediation keyboard (ADR-042) ────────────────────────────

interface PendingHygieneRow {
	slug: string;
	bucket: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
	/** Bucket-specific extras parsed from the digest bullet. Carried so
	 *  the callback handler doesn't have to re-read the digest at action
	 *  time. Pass 4 uses this for dual_file (idxStatus/projStatus) and
	 *  falsifier (reviewDate/daysLeft). */
	meta?: Record<string, string>;
}

/** id → (slug, bucket) store. Persisted in ops.db (kind `project-hygiene`)
 *  per ADR-003 P6 — the 7-day TTL means an anomaly can sit waiting for an
 *  operator decision across several days, so a PM2 reload in between must not
 *  orphan the pending action. */
const HYGIENE_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const pendingHygieneButtons = makePendingStore<PendingHygieneRow>(
	'project-hygiene',
	HYGIENE_PENDING_TTL_MS,
);

/** Deterministic id for a (slug, bucket) pair. Same anomaly → same id
 *  across restarts; if the escalation re-fires we don't accumulate
 *  stale entries. SHA-1 truncated to fit the 64-byte callback_data cap
 *  comfortably (`hyg-arc-y:` + 16 chars = 26 bytes). */
function hygieneIdFor(slug: string, bucket: string): string {
	return createHash('sha1').update(`${slug}\0${bucket}`).digest('base64url').slice(0, 16);
}

/** Standard 3-button hygiene keyboard. Used by buckets where the
 *  remediation set is `Archive | Pause | Ignore` (archive_zone_mismatch,
 *  empty_stub, template_only_index, missing_index). Buckets needing
 *  bucket-specific verbs (Distill via scribe, Fill stub, Reconcile to
 *  X) get their own builder when those flows land. */
export function buildHygieneStandardKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	// archive_zone_mismatch's button label says "Move" since the
	// project is already status=archived; empty/template buckets need
	// "Archive" because the handler flips status first.
	const archiveLabel =
		bucket === 'archive_zone_mismatch' ? '📦 Move to archive/' : '📦 Archive now';
	return {
		inline_keyboard: [
			[
				{ text: archiveLabel, callback_data: `hyg-arc:${id}` },
				{ text: '⏸ Pause 60d', callback_data: `hyg-pause:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** Legacy export — pass-1 alias retained so any existing call sites keep
 *  working. New code uses buildHygieneStandardKeyboard. */
export const buildHygieneArchiveZoneKeyboard = buildHygieneStandardKeyboard;

/** stale_active_14 / stale_active_30 — project says "active" but hasn't
 *  been touched in 14–30+ days. Operator can confirm activity (touch),
 *  back-burner (pause), reconcile down to maintained, or archive. */
export function buildHygieneStaleActiveKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	const secondAction =
		bucket === 'stale_active_30'
			? { text: '🔧 → maintained', callback_data: `hyg-recon:${id}` }
			: { text: '⏸ Pause 30d', callback_data: `hyg-pause:${id}` };
	return {
		inline_keyboard: [
			[
				{ text: '🟢 Still active (touch)', callback_data: `hyg-touch:${id}` },
				secondAction,
			],
			[{ text: '📦 Archive', callback_data: `hyg-arc:${id}` }],
		],
	};
}

/** no_status — frontmatter has no `status:` field. Default action is
 *  to mark active; rare to want anything else for a project that
 *  reached the digest. Archive + ignore remain available. */
export function buildHygieneNoStatusKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	return {
		inline_keyboard: [
			[
				{ text: '🏷 Mark active', callback_data: `hyg-active:${id}` },
				{ text: '📦 Archive', callback_data: `hyg-arc:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** missing_index — folder exists but no index.md. Scaffold a minimal
 *  stub or archive the folder. */
export function buildHygieneMissingIndexKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	return {
		inline_keyboard: [
			[
				{ text: '📝 Scaffold stub', callback_data: `hyg-scaffold:${id}` },
				{ text: '📦 Archive folder', callback_data: `hyg-arc:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** dual_file_disagree — index.md and project.md disagree on `status:`.
 *  The Python script's comment says "project.md usually wins
 *  (human-authored)" — surfaced as the left button. Operator can pick
 *  either source or ignore. */
export function buildHygieneDualFileKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	return {
		inline_keyboard: [
			[
				{ text: '📄 Use project.md', callback_data: `hyg-use-proj:${id}` },
				{ text: '📄 Use index.md', callback_data: `hyg-use-idx:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** falsifier_due_soon — `review_date:` is approaching. Snooze a couple
 *  weeks, mark as freshly reviewed (push +90d), or ignore. */
export function buildHygieneFalsifierKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	return {
		inline_keyboard: [
			[
				{ text: '📅 Snooze +14d', callback_data: `hyg-snooze:${id}` },
				{ text: '✅ Mark reviewed', callback_data: `hyg-reviewed:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** naming_violation — folder/file name fails kebab-case rules. Rename
 *  is too risky for one button (requires wikilink rewrite); surface as
 *  ignore-only and let the operator fix manually. */
export function buildHygieneNamingKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	return {
		inline_keyboard: [
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** Bucket → keyboard dispatcher. The escalator and any other inline-
 *  button emitter calls this rather than hard-coding the standard
 *  builder, so new buckets pick up their own keyboards automatically. */
export function buildHygieneKeyboardFor(slug: string, bucket: string): InlineKeyboardMarkup {
	switch (bucket) {
		case 'stale_active_14':
		case 'stale_active_30':
			return buildHygieneStaleActiveKeyboard(slug, bucket);
		case 'no_status':
			return buildHygieneNoStatusKeyboard(slug, bucket);
		case 'missing_index':
			return buildHygieneMissingIndexKeyboard(slug, bucket);
		case 'dual_file_disagree':
			return buildHygieneDualFileKeyboard(slug, bucket);
		case 'falsifier_due_soon':
			return buildHygieneFalsifierKeyboard(slug, bucket);
		case 'naming_violation':
			return buildHygieneNamingKeyboard(slug, bucket);
		// archive_zone_mismatch, empty_stub, template_only_index → standard
		default:
			return buildHygieneStandardKeyboard(slug, bucket);
	}
}

/** Stash the (slug, bucket, chatJid, messageId) so the callback handler
 *  can resolve which anomaly a tap belongs to. Older entries GC'd
 *  lazily on each insert. */
export function rememberHygieneButtons(args: {
	slug: string;
	bucket: string;
	chatJid: string;
	messageId: number;
	meta?: Record<string, string>;
}): void {
	const id = hygieneIdFor(args.slug, args.bucket);
	pendingHygieneButtons.set(id, { ...args, createdAt: Date.now() });
	// `.set` sweeps expired rows; no separate GC pass needed.
}

function isoDateAddDays(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Hygiene callback branch. Five verbs, all resolved inline:
 *   - hyg-arc:    first tap → swap keyboard to confirm/cancel
 *   - hyg-arc-y:  confirmed → archiveProject() runs git mv + commit
 *   - hyg-arc-n:  cancelled → message edits to "cancelled"
 *   - hyg-pause:  setPauseUntil(slug, +60d)
 *   - hyg-ig:     suppressAnomaly(slug, bucket, 30d) */
async function handleHygieneCallback(
	query: TgCallbackQuery,
	parsed: HygieneParse,
	_config: TelegramChannelConfig,
): Promise<void> {
	const row = pendingHygieneButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Anomaly id expired — wait for next hygiene run',
		});
		return;
	}

	const engine = getVaultEngine();
	if (!engine) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Vault engine not ready',
		});
		return;
	}
	const vaultDir = engine.vaultDir;

	let resultText: string;

	switch (parsed.verb) {
		case 'hyg-arc': {
			// First tap — swap keyboard to confirm/cancel. No destructive op yet.
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text: `Archive *${row.slug}*?\n\n\`git mv projects/${row.slug} archive/${row.slug}\``,
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `hyg-arc-y:${parsed.id}` },
								{ text: '❌ Cancel', callback_data: `hyg-arc-n:${parsed.id}` },
							],
						],
					},
				});
			} catch {
				/* edit may fail if message gone; swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}
		case 'hyg-arc-y': {
			// For empty_stub / template_only_index / missing_index, the
			// project's status is still `active`/`maintained`/etc — we need
			// to flip to `archived` first or archiveProject's status guard
			// will reject. archive_zone_mismatch already has status=archived
			// by definition; skip the flip.
			if (row.bucket !== 'archive_zone_mismatch') {
				const sR = await setProjectStatus(row.slug, 'archived', vaultDir);
				if (!sR.ok) {
					resultText = `❌ Status flip failed: ${sR.detail ?? sR.error}`;
					pendingHygieneButtons.delete(parsed.id);
					break;
				}
			}
			const r = await archiveProject(row.slug, vaultDir);
			resultText = r.ok
				? `✓ Archived \`${row.slug}\` → \`archive/${row.slug}\``
				: `❌ Archive failed: ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-arc-n': {
			resultText = `🚫 Cancelled. \`${row.slug}\` unchanged.`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-pause': {
			const date = isoDateAddDays(60);
			const r = await setPauseUntil(row.slug, date, vaultDir);
			resultText = r.ok ? `⏸ Paused \`${row.slug}\` until ${date}` : `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-ig': {
			const r = await suppressAnomaly(row.slug, row.bucket, 30);
			resultText = r.ok
				? `🔇 Ignored \`${row.slug}:${row.bucket}\` for 30 days`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-touch': {
			const r = await touchProjectUpdated(row.slug, vaultDir);
			resultText = r.ok
				? `🟢 Touched \`${row.slug}\` — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-active': {
			const r = await setProjectStatus(row.slug, 'active', vaultDir);
			resultText = r.ok
				? `🏷 Marked \`${row.slug}\` active — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-recon': {
			const r = await setProjectStatus(row.slug, 'maintained', vaultDir);
			resultText = r.ok
				? `🔧 Reconciled \`${row.slug}\` to maintained — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-scaffold': {
			const r = await scaffoldProjectIndex(row.slug, vaultDir);
			resultText = r.ok
				? `📝 Scaffolded \`${row.slug}/index.md\``
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-use-idx': {
			const r = await reconcileDualStatus(row.slug, 'index', vaultDir);
			resultText = r.ok
				? `📄 \`${row.slug}\` — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-use-proj': {
			const r = await reconcileDualStatus(row.slug, 'project', vaultDir);
			resultText = r.ok
				? `📄 \`${row.slug}\` — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-snooze': {
			// Push review_date forward by 14 days from the digest's stated
			// review_date (not from today) — preserves the original cadence
			// even if the operator is late actioning.
			const baseDateStr = row.meta?.reviewDate;
			const baseDate = baseDateStr ? new Date(baseDateStr) : new Date();
			const next = new Date(baseDate.getTime() + 14 * 86_400_000)
				.toISOString()
				.slice(0, 10);
			const r = await setReviewDate(row.slug, next, vaultDir);
			resultText = r.ok
				? `📅 Snoozed \`${row.slug}\` — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-reviewed': {
			// Fresh 90-day cycle from today — operator is signalling a
			// real review happened, so the clock restarts now.
			const next = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
			const r = await setReviewDate(row.slug, next, vaultDir);
			resultText = r.ok
				? `✅ Marked \`${row.slug}\` reviewed — ${r.detail}`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
	}

	let editOk = true;
	try {
		const editResult = await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: resultText,
			parse_mode: 'Markdown',
		});
		editOk = editResult.ok;
		if (!editOk) {
			console.warn(
				`[telegram/hygiene] editMessageText failed for ${row.slug}:${row.bucket} verb=${parsed.verb} — ${editResult.error ?? 'unknown'}`,
			);
		}
	} catch (err) {
		editOk = false;
		console.warn(
			`[telegram/hygiene] editMessageText threw for ${row.slug}:${row.bucket} verb=${parsed.verb} — ${(err as Error).message}`,
		);
	}
	// If the bubble edit failed, fall back to a toast carrying the
	// result text — strip Markdown so the alert reads cleanly. This
	// guarantees the operator gets visible feedback even when Markdown
	// parse fails on the success line.
	const toastText = editOk
		? undefined
		: resultText.replace(/[`*_]/g, '').slice(0, 200);
	await answerCallbackQuery({
		callback_query_id: query.id,
		...(toastText ? { text: toastText, show_alert: true } : {}),
	});
}

// ─── Vault-hygiene remediation (ADR-043) ───────────────────────────────

interface PendingVaultHygieneRow {
	source: string;
	raw: string;
	bucket: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

/** id → (source, raw, bucket) store for vault-hygiene escalations.
 *  Separate from `pendingHygieneButtons` (project-hygiene) so callback
 *  parsing routes cleanly and the two surfaces can evolve independently.
 *  Per ADR-043 anti-abstraction call the surfaces stay distinct — the
 *  `kind` discriminator (`vault-hygiene`) preserves that while sharing the
 *  one persisted table (ADR-003 P6). */
const VAULT_HYG_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const pendingVaultHygieneButtons = makePendingStore<PendingVaultHygieneRow>(
	'vault-hygiene',
	VAULT_HYG_PENDING_TTL_MS,
);

/** Per-batch state for the vh-fix-* aggregate flow. Keyed by a stable
 *  id derived from the batch contents; the keyboard's callback_data
 *  carries just the id so it fits inside Telegram's 64-byte cap.
 *
 *  Holds the full batch (source/raw pairs) so the callback handler
 *  can build the keeper task message without round-tripping back to
 *  the vault hygiene report (which may have shifted by the time the
 *  operator taps the button). */
interface PendingFixBatchRow {
	batch: { source: string; raw: string }[];
	digestText: string; // original aggregate body, for vh-fix-list restoration
	chatJid: string;
	messageId: number;
	createdAt: number;
}
const FIX_BATCH_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const pendingFixBatchButtons = makePendingStore<PendingFixBatchRow>(
	'fix-batch',
	FIX_BATCH_PENDING_TTL_MS,
);

/** Deterministic id for a (source, raw) wikilink anomaly. SHA-1
 *  truncated to 16 chars keeps `vh-unlink-y:<id>` comfortably inside
 *  Telegram's 64-byte callback_data cap (≈26 bytes total). */
function vaultHygieneIdFor(source: string, raw: string, bucket: string): string {
	return createHash('sha1').update(`${source}\0${raw}\0${bucket}`).digest('base64url').slice(0, 16);
}

/** Stable id for a fix-batch keyboard. Hashes the source/raw pairs
 *  in sorted order so two equivalent batches (same links, different
 *  arrival order) collide intentionally — taps on either button
 *  resolve against the same pending row. */
function fixBatchIdFor(batch: { source: string; raw: string }[]): string {
	const canonical = batch
		.map((b) => `${b.source}\0${b.raw}`)
		.sort()
		.join('\n');
	return createHash('sha1').update(canonical).digest('base64url').slice(0, 16);
}

/** Build the 3-button keyboard for an aggregate fix-batch message.
 *  Buttons: `🤖 Fix all (N)` — dispatch keeper; `📋 Show list` —
 *  expand to text; `⏭ Skip` — dismiss. */
export function buildFixBatchKeyboard(
	batch: { source: string; raw: string }[],
): InlineKeyboardMarkup {
	const id = fixBatchIdFor(batch);
	return {
		inline_keyboard: [
			[
				{ text: `🤖 Fix all (${batch.length})`, callback_data: `vh-fix-all:${id}` },
				{ text: '📋 Show list', callback_data: `vh-fix-list:${id}` },
				{ text: '⏭ Skip', callback_data: `vh-fix-skip:${id}` },
			],
		],
	};
}

/** Stash the batch context so the callback handler can resolve a tap
 *  back to the full source/raw list. Caller (the escalator) calls this
 *  immediately AFTER sending the aggregate message and learning the
 *  Telegram messageId. TTL prune is opportunistic on every store. */
export function rememberFixBatch(args: {
	batch: { source: string; raw: string }[];
	digestText: string;
	chatJid: string;
	messageId: number;
}): string {
	const id = fixBatchIdFor(args.batch);
	pendingFixBatchButtons.set(id, {
		batch: args.batch,
		digestText: args.digestText,
		chatJid: args.chatJid,
		messageId: args.messageId,
		createdAt: Date.now(),
	});
	// `.set` sweeps expired rows; no separate GC pass needed.
	return id;
}

/** Build the inline keyboard for an `unresolved` (broken_link) anomaly.
 *  Pilot bucket per ADR-043. */
export function buildVaultHygieneUnresolvedKeyboard(
	source: string,
	raw: string,
): InlineKeyboardMarkup {
	const id = vaultHygieneIdFor(source, raw, 'unresolved');
	return {
		inline_keyboard: [
			[
				{ text: '🗑 Unlink', callback_data: `vh-unlink:${id}` },
				{ text: '🔇 Ignore 30d', callback_data: `vh-ig:${id}` },
			],
		],
	};
}

/** Build the inline keyboard for an `orphan_note` anomaly. Pass 2.
 *  🔗 Link-up (operator-picked parent) is deferred — it needs a
 *  multi-step picker flow that doesn't fit single-tap. */
export function buildVaultHygieneOrphanKeyboard(notePath: string): InlineKeyboardMarkup {
	const id = vaultHygieneIdFor(notePath, '', 'orphan_note');
	return {
		inline_keyboard: [
			[
				{ text: '📦 Archive', callback_data: `vh-orphan-arc:${id}` },
				{ text: '🔇 Ignore 30d', callback_data: `vh-ig:${id}` },
			],
		],
	};
}

/** Build the inline keyboard for a `stale_inbox_item` anomaly. Pass 2.
 *  📥 Move to vault (operator-picked destination) is deferred — same
 *  multi-step reasoning as the orphan Link-up button. */
export function buildVaultHygieneStaleInboxKeyboard(notePath: string): InlineKeyboardMarkup {
	const id = vaultHygieneIdFor(notePath, '', 'stale_inbox_item');
	return {
		inline_keyboard: [
			[
				{ text: '🗑 Drop', callback_data: `vh-inbox-drop:${id}` },
				{ text: '🔇 Ignore 30d', callback_data: `vh-ig:${id}` },
			],
		],
	};
}

/** Probe: is there a still-live pending button row for this anomaly?
 *  Used by the escalator to suppress re-emission across heartbeat ticks
 *  while the operator hasn't actioned (or ignored) the previous message.
 *  Naturally clears on operator action (handlers delete the row) and on
 *  TTL expiry (7 days, see VAULT_HYG_PENDING_TTL_MS). */
export function hasPendingVaultHygiene(
	source: string,
	raw: string,
	bucket: string,
): boolean {
	const id = vaultHygieneIdFor(source, raw, bucket);
	// `.get` already drops + returns undefined for TTL-expired rows, so a
	// present row is by definition still live.
	return pendingVaultHygieneButtons.get(id) !== undefined;
}

/** Stash the (source, raw, chatJid, messageId) so the callback handler
 *  can resolve which broken-link a tap belongs to. Older entries GC'd
 *  lazily on each insert. */
export function rememberVaultHygieneButtons(args: {
	source: string;
	raw: string;
	bucket: string;
	chatJid: string;
	messageId: number;
}): void {
	const id = vaultHygieneIdFor(args.source, args.raw, args.bucket);
	pendingVaultHygieneButtons.set(id, { ...args, createdAt: Date.now() });
	// `.set` sweeps expired rows; no separate GC pass needed.
}

/** Vault-hygiene callback branch. Ten verbs, all resolved inline:
 *   Pilot (broken_link):
 *    - vh-unlink / vh-unlink-y / vh-unlink-n  → confirm-then-execute Unlink
 *   Pass 2 (orphan_note):
 *    - vh-orphan-arc / vh-orphan-arc-y / vh-orphan-arc-n → confirm-then-execute Archive
 *   Pass 2 (stale_inbox_item):
 *    - vh-inbox-drop / vh-inbox-drop-y / vh-inbox-drop-n → confirm-then-execute Drop
 *   All buckets:
 *    - vh-ig: suppressAnomaly(key, bucket, 30d) where key is `source::raw`
 *      for unresolved and just the path for orphan_note / stale_inbox_item. */
async function handleVaultHygieneCallback(
	query: TgCallbackQuery,
	parsed: VaultHygieneParse,
	_config: TelegramChannelConfig,
): Promise<void> {
	// Fast-path for the bulk fix-batch verbs — they resolve against a
	// different pending map (per-batch instead of per-link).
	if (
		parsed.verb === 'vh-fix-all' ||
		parsed.verb === 'vh-fix-list' ||
		parsed.verb === 'vh-fix-skip'
	) {
		await handleFixBatchCallback(query, parsed);
		return;
	}

	const row = pendingVaultHygieneButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Anomaly id expired — wait for next vault-hygiene tick',
		});
		return;
	}

	const engine = getVaultEngine();
	if (!engine) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Vault engine not ready',
		});
		return;
	}
	const vaultDir = engine.vaultDir;

	let resultText: string;

	switch (parsed.verb) {
		case 'vh-unlink': {
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text:
						`Unlink \`[[${row.raw}]]\` in \`${row.source}\`?\n\n` +
						`Will replace every occurrence with its display text. Reversible via git.`,
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `vh-unlink-y:${parsed.id}` },
								{ text: '❌ Cancel', callback_data: `vh-unlink-n:${parsed.id}` },
							],
						],
					},
				});
			} catch {
				/* swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}
		case 'vh-unlink-y': {
			const r = await unlinkBrokenWikilink(row.source, row.raw, vaultDir);
			resultText = r.ok
				? `✓ Unlinked — ${r.detail}`
				: `❌ Unlink failed: ${r.detail ?? r.error}`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-unlink-n': {
			resultText = `🚫 Cancelled. \`${row.source}\` unchanged.`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-ig': {
			// Suppression key shape varies by bucket — composite for
			// unresolved (per-link), just the path for orphan/stale (per-note).
			const key =
				row.bucket === 'unresolved' ? `${row.source}::${row.raw}` : row.source;
			const r = await suppressAnomaly(key, row.bucket, 30);
			if (r.ok) {
				resultText =
					row.bucket === 'unresolved'
						? `🔇 Ignored \`[[${row.raw}]]\` in \`${row.source}\` for 30 days`
						: `🔇 Ignored \`${row.source}\` for 30 days`;
			} else {
				resultText = `❌ ${r.detail ?? r.error}`;
			}
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-orphan-arc': {
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text:
						`Archive orphan \`${row.source}\`?\n\n` +
						`Will git-mv to \`archive/${row.source}\` and commit. Reversible via git.`,
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `vh-orphan-arc-y:${parsed.id}` },
								{ text: '❌ Cancel', callback_data: `vh-orphan-arc-n:${parsed.id}` },
							],
						],
					},
				});
			} catch {
				/* swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}
		case 'vh-orphan-arc-y': {
			const r = await archiveOrphanNote(row.source, vaultDir);
			resultText = r.ok
				? `✓ Archived — ${r.detail}`
				: `❌ Archive failed: ${r.detail ?? r.error}`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-orphan-arc-n': {
			resultText = `🚫 Cancelled. \`${row.source}\` unchanged.`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-inbox-drop': {
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text:
						`Drop stale inbox note \`${row.source}\`?\n\n` +
						`Will \`git rm\` and commit. Reversible via \`git checkout HEAD~1 -- ${row.source}\`.`,
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `vh-inbox-drop-y:${parsed.id}` },
								{ text: '❌ Cancel', callback_data: `vh-inbox-drop-n:${parsed.id}` },
							],
						],
					},
				});
			} catch {
				/* swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}
		case 'vh-inbox-drop-y': {
			const r = await dropStaleInboxItem(row.source, vaultDir);
			resultText = r.ok
				? `✓ Dropped — ${r.detail}`
				: `❌ Drop failed: ${r.detail ?? r.error}`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
		case 'vh-inbox-drop-n': {
			resultText = `🚫 Cancelled. \`${row.source}\` unchanged.`;
			pendingVaultHygieneButtons.delete(parsed.id);
			break;
		}
	}

	// Same diagnostic + toast-fallback pattern as the project-hygiene
	// handler (Pass 4 lesson): editMessageText silent-fails on Markdown
	// parse errors, log + fall back to answerCallbackQuery alert so the
	// operator always gets visible feedback.
	let editOk = true;
	try {
		const editResult = await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: resultText,
			parse_mode: 'Markdown',
		});
		editOk = editResult.ok;
		if (!editOk) {
			console.warn(
				`[telegram/vault-hygiene] editMessageText failed for ${row.source}:${row.bucket} verb=${parsed.verb} — ${editResult.error ?? 'unknown'}`,
			);
		}
	} catch (err) {
		editOk = false;
		console.warn(
			`[telegram/vault-hygiene] editMessageText threw for ${row.source}:${row.bucket} verb=${parsed.verb} — ${(err as Error).message}`,
		);
	}
	const toastText = editOk
		? undefined
		: resultText.replace(/[`*_]/g, '').slice(0, 200);
	await answerCallbackQuery({
		callback_query_id: query.id,
		...(toastText ? { text: toastText, show_alert: true } : {}),
	});
}

// ─── Inbox-digest remediation (ADR-044) ────────────────────────────────

/** 4-button keyboard for an inbox digest highlight. The numeric inbox
 *  messageId rides directly in callback_data — Telegram's 64-byte cap
 *  has plenty of room (`ibx-save:34510` is 14 bytes). No short_id, no
 *  in-memory rendezvous map: the click handler reconstructs chat +
 *  Telegram message id from `query.message` on the callback payload,
 *  so buttons survive PM2 reloads, deploys, and crashes. */
export function buildInboxDigestKeyboard(messageId: number): InlineKeyboardMarkup {
	const id = String(messageId);
	return {
		inline_keyboard: [
			[
				{ text: '📥 Save to vault', callback_data: `ibx-save:${id}` },
				{ text: '📁 Archive', callback_data: `ibx-arc:${id}` },
			],
			[
				{ text: '🔇 Mute sender', callback_data: `ibx-mute:${id}` },
				{ text: '↩️ Draft reply', callback_data: `ibx-reply:${id}` },
			],
		],
	};
}

/** Bulk fix-batch callback branch. Three verbs share the per-batch
 *  pending map:
 *   - vh-fix-all : edit message to "running…", spawn keeper dispatch
 *                  async, on completion edit to the result summary
 *   - vh-fix-list: edit message body to a text-only enumeration of
 *                  the batch (no agent dispatch)
 *   - vh-fix-skip: edit message to "skipped — reappears next digest"
 *
 *  The dispatch is fire-and-forget — the callback handler answers
 *  Telegram within a few seconds (well inside the callback_query
 *  timeout) while the keeper runs in the background. */
async function handleFixBatchCallback(
	query: TgCallbackQuery,
	parsed: VaultHygieneParse,
): Promise<void> {
	const row = pendingFixBatchButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Fix-batch id expired — wait for next vault-hygiene tick',
		});
		return;
	}

	switch (parsed.verb) {
		case 'vh-fix-list': {
			// Pure text-edit. Show the full enumerated list; keyboard
			// stays so the operator can still tap Fix all / Skip.
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text: formatBatchList(row.batch),
					parse_mode: 'Markdown',
					reply_markup: buildFixBatchKeyboard(row.batch),
				});
			} catch {
				/* swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}

		case 'vh-fix-skip': {
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text:
						`⏭ Skipped — ${row.batch.length} broken wikilink${row.batch.length === 1 ? '' : 's'} ` +
						`will reappear in the next vault-hygiene tick.`,
					parse_mode: 'Markdown',
				});
			} catch {
				/* swallow */
			}
			pendingFixBatchButtons.delete(parsed.id);
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}

		case 'vh-fix-all': {
			// 1. Immediately edit the message to a "running" state so the
			//    operator gets feedback within seconds. Drop the keyboard
			//    so they can't double-fire while keeper is mid-flight.
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text:
						`🔄 Dispatching keeper to bulk-fix ${row.batch.length} broken ` +
						`wikilink${row.batch.length === 1 ? '' : 's'}…\n\n` +
						`Typically takes 1–3 minutes. This message will update when done.`,
					parse_mode: 'Markdown',
				});
			} catch {
				/* swallow */
			}
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: '🤖 Keeper dispatched',
			});

			// 2. Fire-and-forget background dispatch. Wrapped in an async
			//    IIFE so errors are logged but don't crash the channel
			//    handler.
			void (async () => {
				try {
					const task = formatKeeperTask(row.batch);
					const generator = dispatchAgent('keeper', task, {
						mode: 'production',
					});
					// Manual drain — TReturn carries the DispatchResult per
					// `feedback_asyncgenerator_return_value_loop`.
					let final: Awaited<ReturnType<typeof generator.next>> | null = null;
					while (true) {
						const next = await generator.next();
						if (next.done) {
							final = next;
							break;
						}
					}
					const result = final?.value;
					if (!result || result.status === 'error') {
						await editMessageText({
							chat_id: row.chatJid,
							message_id: row.messageId,
							text:
								`❌ Keeper dispatch failed — ${result?.error ?? 'unknown error'}\n\n` +
								`Batch unchanged. Tap the digest button again or use \`/api/hygiene/vault-escalate-buttons\` to resurface.`,
							parse_mode: 'Markdown',
						});
						return;
					}
					const parsedResult = parseKeeperResult(result.output);
					if (!parsedResult) {
						await editMessageText({
							chat_id: row.chatJid,
							message_id: row.messageId,
							text:
								`❌ Keeper output unparseable — no JSON result block found.\n\n` +
								`First 800 chars:\n\`\`\`\n${result.output.slice(0, 800)}\n\`\`\``,
							parse_mode: 'Markdown',
						});
						return;
					}
					await editMessageText({
						chat_id: row.chatJid,
						message_id: row.messageId,
						text: formatTelegramResult(parsedResult, row.batch.length),
						parse_mode: 'Markdown',
					});
					pendingFixBatchButtons.delete(parsed.id);
				} catch (err) {
					try {
						await editMessageText({
							chat_id: row.chatJid,
							message_id: row.messageId,
							text: `❌ Keeper crashed: ${(err as Error).message}`,
							parse_mode: 'Markdown',
						});
					} catch {
						/* swallow */
					}
				}
			})();
			return;
		}
	}
}

/** Inbox callback branch. Four verbs:
 *   - ibx-save:  dispatchVaultSave with envelope + preview
 *   - ibx-arc:   process_status='archived'
 *   - ibx-mute:  insert sender_pattern → bulk filter rule
 *   - ibx-reply: ack toast → background scribe → draft as new message */
async function handleInboxCallback(
	query: TgCallbackQuery,
	parsed: InboxParse,
	config: TelegramChannelConfig,
): Promise<void> {
	// Stateless dispatch — `parsed.id` is the numeric inbox messageId
	// (encoded directly in callback_data, no map), and Telegram includes
	// the original bubble's chat + message_id on every callback_query.
	// This means buttons survive PM2 reloads, deploys, and process
	// restarts: previously a 24h in-memory `pendingInboxButtons` map
	// would silently die on any restart and clicks returned "expired."
	const messageId = Number(parsed.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Invalid inbox row id',
		});
		return;
	}
	if (!query.message) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Inbox row context missing — open /inbox in the web UI',
		});
		return;
	}
	const chatJid = String(query.message.chat.id);
	const tgMessageId = query.message.message_id;

	// Draft reply: long-running agent dispatch. Ack the callback within
	// Telegram's window, edit bubble to "drafting…", then run mailwright
	// in the background and deliver the draft via in-place edit.
	if (parsed.verb === 'ibx-reply') {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: '🤖 Drafting…',
		});
		try {
			await editMessageText({
				chat_id: chatJid,
				message_id: tgMessageId,
				text: `🤖 *Drafting reply* for inbox msg ${messageId}…\n\n_(scribe is composing — 30–60s; reply will arrive as a new message below)_`,
				parse_mode: 'Markdown',
			});
		} catch {
			/* swallow */
		}

		void draftInboxReply(messageId)
			.then(async (result) => {
				if (!result.ok) {
					await editMessageText({
						chat_id: chatJid,
						message_id: tgMessageId,
						text: `❌ Draft failed: ${result.detail ?? result.error}`,
						parse_mode: 'Markdown',
					}).catch(() => {});
					return;
				}
				// Surface the vault path as a clickable link. The bubble
				// stays tight; the operator opens the note to view, edit,
				// and copy. Permanent draft history in the vault.
				const linkPart = result.openUrl
					? `[\`${result.vaultPath}\`](${result.openUrl})`
					: `\`${result.vaultPath ?? '(no path)'}\``;
				await editMessageText({
					chat_id: chatJid,
					message_id: tgMessageId,
					text:
						`↩️ *Draft saved* → ${linkPart}\n\n` +
						`_${result.detail}_\n\n` +
						`Open the note to read, edit, and copy. Send manually from your mail client (outbound isn't wired yet).`,
					parse_mode: 'Markdown',
				}).catch(() => {});
			})
			.catch(async (err) => {
				await editMessageText({
					chat_id: chatJid,
					message_id: tgMessageId,
					text: `❌ Draft threw: ${(err as Error).message}`,
					parse_mode: 'Markdown',
				}).catch(() => {});
			});
		return;
	}

	let resultText: string;

	switch (parsed.verb) {
		case 'ibx-arc': {
			const r = await archiveInboxMessage(messageId);
			resultText = r.ok
				? `📁 Archived msg ${messageId} — ${r.detail}`
				: `❌ Archive failed: ${r.detail ?? r.error}`;
			break;
		}
		case 'ibx-save': {
			const r = await saveInboxToVault(messageId);
			resultText = r.ok
				? `📥 Saved msg ${messageId} — ${r.detail}`
				: `❌ Save failed: ${r.detail ?? r.error}`;
			break;
		}
		case 'ibx-mute': {
			const msg = getInboxMessage(messageId);
			const sender = msg?.fromAddress;
			if (!sender) {
				resultText = `❌ Mute failed: no sender on msg ${messageId}`;
				break;
			}
			// ADR-044.C — branch on CRM hit. Muting a CRM contact is a
			// real footgun (you'd silently drop a Lead's mail from future
			// digests); require an explicit confirm with the contact's
			// stage shown. Non-CRM senders mute directly. CRM lookup is
			// wrapped — a DB hiccup here shouldn't break Mute entirely.
			let crmMatch: Awaited<ReturnType<typeof findContactByEmail>> | null = null;
			try {
				crmMatch = findContactByEmail(sender);
			} catch (err) {
				console.warn(
					`[telegram/inbox] CRM lookup failed for ${sender}: ${(err as Error).message}`,
				);
			}
			if (crmMatch) {
				const c = crmMatch.contact;
				const stagePart = c.stage ? `*${c.stage}*` : '_no stage_';
				try {
					await editMessageText({
						chat_id: chatJid,
						message_id: tgMessageId,
						text:
							`⚠️ *Mute CRM contact?*\n\n` +
							`\`${sender}\` is *${c.displayName}* — ${stagePart}` +
							(c.company ? ` at ${c.company}` : '') +
							`.\n\nMuting will drop future mail from this sender into the bulk category — they'll skip the digest. ` +
							`Reversible via the filter-rules UI, but easy to forget.`,
						parse_mode: 'Markdown',
						reply_markup: {
							inline_keyboard: [
								[
									{ text: '✅ Confirm mute', callback_data: `ibx-mute-y:${parsed.id}` },
									{ text: '❌ Cancel', callback_data: `ibx-mute-n:${parsed.id}` },
								],
							],
						},
					});
				} catch {
					/* swallow */
				}
				await answerCallbackQuery({ callback_query_id: query.id });
				return;
			}
			const r = await muteInboxSender(sender, messageId);
			resultText = r.ok
				? `🔇 Muted \`${sender}\` — ${r.detail}`
				: `❌ Mute failed: ${r.detail ?? r.error}`;
			break;
		}
		case 'ibx-mute-y': {
			const msg = getInboxMessage(messageId);
			const sender = msg?.fromAddress;
			if (!sender) {
				resultText = `❌ Mute failed: no sender on msg ${messageId}`;
				break;
			}
			const r = await muteInboxSender(sender, messageId);
			resultText = r.ok
				? `🔇 Muted \`${sender}\` (CRM contact) — ${r.detail}`
				: `❌ Mute failed: ${r.detail ?? r.error}`;
			break;
		}
		case 'ibx-mute-n': {
			resultText = `🚫 Cancelled. CRM contact not muted.`;
			break;
		}
		default: {
			resultText = `❌ Unknown inbox verb: ${(parsed as { verb: string }).verb}`;
		}
	}

	let editOk = true;
	try {
		const editResult = await editMessageText({
			chat_id: chatJid,
			message_id: tgMessageId,
			text: resultText,
			parse_mode: 'Markdown',
		});
		editOk = editResult.ok;
		if (!editOk) {
			console.warn(
				`[telegram/inbox] editMessageText failed for msg ${messageId} verb=${parsed.verb} — ${editResult.error ?? 'unknown'}`,
			);
		}
	} catch (err) {
		editOk = false;
		console.warn(
			`[telegram/inbox] editMessageText threw for msg ${messageId} verb=${parsed.verb} — ${(err as Error).message}`,
		);
	}
	const toastText = editOk ? undefined : resultText.replace(/[`*_]/g, '').slice(0, 200);
	await answerCallbackQuery({
		callback_query_id: query.id,
		...(toastText ? { text: toastText, show_alert: true } : {}),
	});
}
