/** Per ADR-023 Phase 1.5 — Claude analyst orchestration.
 *
 *  One run does this:
 *    1. Snapshot the last N days of `intent_log` rows + matching
 *       `chat_history` user messages into a markdown corpus file.
 *    2. Dispatch the `intent-learner` agent (claude-pty) with three
 *       absolute paths in the brief: corpus, report, proposals.
 *    3. Read the JSON proposals file the agent wrote.
 *    4. Validate every proposal's citations against real `intent_log`
 *       rows (exact match; one strike out the proposal).
 *    5. Drop proposals whose signature is in the rejection history.
 *    6. Persist the survivors as `intent_patterns_proposed` rows.
 *    7. Nudge the operator on Telegram with inline-keyboard buttons.
 *
 *  Side effects (corpus dump, vault report, Telegram message) are all
 *  best-effort — a single failed step never aborts the rest of the run.
 *  The scheduler's run-record captures the counts; the operator can
 *  also inspect `intent_patterns_proposed` and `intent_log` directly. */

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getInboxDb } from '../inbox/db.js';
import { soulHubDataDir } from '../paths.js';
import { dispatchAgent } from '../agents/dispatch/index.js';
import { writeProposals, rejectedSignatures, type PatternProposal, type MatchKind } from './patterns.js';
import { pruneIntentLog } from './log.js';
import { readChannelConfig } from '../channels/telegram/adapter.js';
import { sendText as sendTelegramText } from '../channels/telegram/outbound.js';
import { config as soulHubConfig } from '../config.js';
import { registerIntentBatchButtons } from '../channels/telegram/callback.js';
import type { InlineKeyboardMarkup } from '../channels/telegram/types.js';

const VAULT_OPS_DIR = 'operations/whatsapp';
const AGENT_ID = 'intent-learner';
const CONFIDENCE_FLOOR = 0.80;
/** Hard cap on rows we hand the analyst per run. Real traffic includes
 *  one-off URLs + multi-paragraph requests that can't repeat-pattern;
 *  past this the agent burns budget reading noise. Keeps the most-recent
 *  rows because the proposed patterns need to reflect current usage. */
const MAX_CORPUS_ROWS = 150;

interface IntentLogWindowRow {
	ts: number;
	conversation_key: string;
	raw_message: string;
	normalized_signature: string;
	picked_route: string;
	source: 'regex' | 'llm' | 'pattern' | 'fallback';
	confidence: number | null;
	latency_ms: number | null;
}

interface ChatHistoryWindowRow {
	conversation_key: string;
	ts: number;
	role: 'user' | 'assistant';
	content: string;
}

export interface IntentMiningResult {
	batchId: string;
	corpusRows: number;
	conversationsCovered: number;
	rejectedSignaturesSkipped: number;
	agentStatus: 'success' | 'error' | 'skipped' | 'timeout' | 'cancelled';
	agentCostUsd: number;
	proposalsRead: number;
	proposalsAccepted: number;
	proposalsDroppedInvalidCitation: number;
	proposalsDroppedConfidence: number;
	proposalsDroppedAlreadyRejected: number;
	corpusPath: string;
	reportPath: string;
	proposalsPath: string;
	telegramNudgeSent: boolean;
	/** ADR-023 retention sweep — rows older than 90d removed from
	 *  intent_log before each run so the table can't grow unboundedly. */
	intentLogRowsPruned: number;
	durationMs: number;
	skipped: boolean;
	skipReason?: string;
}

export interface RunIntentMiningOptions {
	lookbackDays?: number;
	/** Minimum new intent_log rows since the watermark `lastRunAt` — below
	 *  this we no-op. The scheduler handler passes its own watermark in;
	 *  passing 0 disables the gate (manual smoke). */
	minNewRows?: number;
	lastRunAt?: number;
	signal?: AbortSignal;
	/** Override the Telegram nudge. Useful for tests. */
	notify?: 'telegram' | 'none';
}

function ymdInTz(ts: number, tz = 'Asia/Dubai'): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(ts));
}

function readWindow(
	startTs: number,
): { intentRows: IntentLogWindowRow[]; chatRows: ChatHistoryWindowRow[] } {
	const db = getInboxDb();
	const intentRows = db
		.prepare<[number]>(
			`SELECT ts, conversation_key, raw_message, normalized_signature,
			        picked_route, source, confidence, latency_ms
			 FROM intent_log
			 WHERE ts >= ?
			 ORDER BY ts ASC`,
		)
		.all(startTs) as IntentLogWindowRow[];

	// Pull chat_history rows in the same window so the analyst can read the
	// assistant turn that followed each intent decision. Bounded — if the
	// operator has been heavy on a single conversation we still ship all of
	// it; this is offline, not chat-path.
	const chatRows = db
		.prepare<[number]>(
			`SELECT conversation_key, ts, role, content
			 FROM chat_history
			 WHERE ts >= ?
			 ORDER BY conversation_key ASC, ts ASC`,
		)
		.all(startTs) as ChatHistoryWindowRow[];

	return { intentRows, chatRows };
}

function countNewIntentRows(sinceTs: number): number {
	const db = getInboxDb();
	const row = db
		.prepare<[number]>(`SELECT COUNT(*) AS n FROM intent_log WHERE ts >= ?`)
		.get(sinceTs) as { n: number };
	return row.n;
}

function buildCorpusMarkdown(
	batchId: string,
	intentRows: IntentLogWindowRow[],
	chatRows: ChatHistoryWindowRow[],
	rejected: Set<string>,
	windowDays: number,
): string {
	const rejectedList = Array.from(rejected).slice(0, 50);
	const chatByConv = new Map<string, ChatHistoryWindowRow[]>();
	for (const row of chatRows) {
		const arr = chatByConv.get(row.conversation_key) ?? [];
		arr.push(row);
		chatByConv.set(row.conversation_key, arr);
	}

	const conversationKeys = Array.from(
		new Set(intentRows.map((r) => r.conversation_key)),
	).sort();

	const lines: string[] = [];
	lines.push(`# Intent corpus — ${batchId}`);
	lines.push('');
	lines.push(`> Window: last ${windowDays} days. Rows: ${intentRows.length}. Conversations: ${conversationKeys.length}.`);
	lines.push('');
	lines.push('## Rejected signatures (do NOT re-propose)');
	lines.push('');
	if (rejectedList.length === 0) {
		lines.push('_(none yet)_');
	} else {
		for (const s of rejectedList) lines.push(`- \`${s}\``);
	}
	lines.push('');
	lines.push('## Routing-source distribution');
	lines.push('');
	const sourceCounts = new Map<string, number>();
	const routeCounts = new Map<string, number>();
	for (const r of intentRows) {
		sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
		routeCounts.set(r.picked_route, (routeCounts.get(r.picked_route) ?? 0) + 1);
	}
	lines.push('| source | count |');
	lines.push('|---|---|');
	for (const [src, n] of Array.from(sourceCounts.entries()).sort((a, b) => b[1] - a[1])) {
		lines.push(`| ${src} | ${n} |`);
	}
	lines.push('');
	lines.push('| picked_route | count |');
	lines.push('|---|---|');
	for (const [r, n] of Array.from(routeCounts.entries()).sort((a, b) => b[1] - a[1])) {
		lines.push(`| ${r} | ${n} |`);
	}
	lines.push('');
	lines.push('## Per-conversation timeline');
	lines.push('');

	for (const key of conversationKeys) {
		const myIntent = intentRows.filter((r) => r.conversation_key === key);
		const myChat = chatByConv.get(key) ?? [];
		lines.push(`### conversation_key: \`${key}\``);
		lines.push('');
		lines.push(`Intent rows: ${myIntent.length} · Chat turns: ${myChat.length}`);
		lines.push('');

		// Build a merged time-ordered view: each intent row, then any chat
		// turns that happened between it and the next intent row.
		const sortedChat = [...myChat].sort((a, b) => a.ts - b.ts);
		let chatIdx = 0;
		for (let i = 0; i < myIntent.length; i++) {
			const row = myIntent[i];
			lines.push(
				`- **[intent ${ymdInTz(row.ts)} src=${row.source} → ${row.picked_route}]** \`${row.raw_message.replace(/`/g, "'")}\``,
			);
			lines.push(`  - normalized_signature: \`${row.normalized_signature}\``);

			const nextIntentTs = myIntent[i + 1]?.ts ?? Number.MAX_SAFE_INTEGER;
			while (chatIdx < sortedChat.length && sortedChat[chatIdx].ts < nextIntentTs) {
				const c = sortedChat[chatIdx];
				if (c.role === 'assistant') {
					const oneLine = c.content.replace(/\s+/g, ' ').trim().slice(0, 200);
					lines.push(`  - assistant: ${oneLine}`);
				}
				chatIdx += 1;
			}
		}
		lines.push('');
	}

	return lines.join('\n');
}

interface AgentProposalRaw {
	signature?: unknown;
	match_kind?: unknown;
	picked_route?: unknown;
	placeholder_text?: unknown;
	confidence?: unknown;
	conversation_key?: unknown;
	citations?: unknown;
	rationale?: unknown;
}

interface ProposalsFile {
	batchId?: unknown;
	generatedAt?: unknown;
	windowDays?: unknown;
	corpusRows?: unknown;
	proposals?: unknown;
}

function asString(x: unknown): string | null {
	return typeof x === 'string' && x.length > 0 ? x : null;
}

function asNumber(x: unknown): number | null {
	return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function isMatchKind(x: unknown): x is MatchKind {
	return x === 'exact' || x === 'prefix' || x === 'contains' || x === 'regex';
}

interface ValidatedProposal {
	proposal: PatternProposal;
	allCitationsResolved: boolean;
	unresolvedCitations: string[];
}

function validateAndBuildProposal(
	raw: AgentProposalRaw,
	batchId: string,
	intentRawMessages: Set<string>,
): ValidatedProposal | null {
	const signature = asString(raw.signature);
	const matchKind = raw.match_kind;
	const pickedRoute = asString(raw.picked_route);
	const confidence = asNumber(raw.confidence);
	if (!signature || !isMatchKind(matchKind) || !pickedRoute || confidence === null) {
		return null;
	}
	if (matchKind === 'regex') return null; // disallowed in v1 per the agent prompt
	const citationsArr = Array.isArray(raw.citations) ? raw.citations.filter((c): c is string => typeof c === 'string') : [];
	if (citationsArr.length < 3) return null;

	const unresolved = citationsArr.filter((c) => !intentRawMessages.has(c));
	const allResolved = unresolved.length === 0;

	const conversationKeyRaw = raw.conversation_key;
	const conversationKey =
		typeof conversationKeyRaw === 'string' && conversationKeyRaw.length > 0
			? conversationKeyRaw
			: null;

	const proposal: PatternProposal = {
		batchId,
		signature,
		matchKind,
		pickedRoute,
		placeholderText: asString(raw.placeholder_text),
		confidence,
		conversationKey,
		citations: citationsArr,
		rationale: asString(raw.rationale),
	};
	return { proposal, allCitationsResolved: allResolved, unresolvedCitations: unresolved };
}

function shortBatchId(batchId: string): string {
	return createHash('sha1').update(batchId).digest('base64url').slice(0, 16);
}

function buildIntentBatchKeyboard(batchId: string): InlineKeyboardMarkup {
	const id = shortBatchId(batchId);
	return {
		inline_keyboard: [
			[
				{ text: '👀 Review', callback_data: `ip-review:${id}` },
				{ text: '✅ Approve all', callback_data: `ip-all:${id}` },
			],
			[{ text: '✗ Skip', callback_data: `ip-skip:${id}` }],
		],
	};
}

async function dispatchAndCollect(
	task: string,
	signal?: AbortSignal,
): Promise<{ status: IntentMiningResult['agentStatus']; output: string; costUsd: number }> {
	const events = dispatchAgent(AGENT_ID, task, { signal });
	let output = '';
	let next = await events.next();
	while (!next.done) {
		const evt = next.value;
		// Stream events: 'output' carries text, 'error' carries failure detail.
		if (evt.type === 'output') {
			const chunk = (evt as { text?: string }).text;
			if (typeof chunk === 'string') output += chunk;
		}
		next = await events.next();
	}
	const result = next.value;
	return {
		status: result.status as IntentMiningResult['agentStatus'],
		output: output || result.output || '',
		costUsd: result.cost_usd,
	};
}

async function sendOperatorNudge(
	batchId: string,
	acceptedCount: number,
	reportPath: string,
): Promise<boolean> {
	try {
		const cfg = readChannelConfig();
		if (!cfg?.enabled) return false;
		// Resolve the default chat the same way `send()` does, but we want to
		// attach a keyboard so we go through outbound.ts directly. Inline copy
		// of the resolution rules from telegram/adapter.ts.
		const dm = cfg.access.allowFrom.find((v) => v !== '*');
		const chatId =
			dm ??
			cfg.access.groupAllowFrom[0] ??
			(process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID : null);
		if (!chatId) return false;

		registerIntentBatchButtons(batchId);
		const text =
			`🧠 *Intent analyst* — batch \`${batchId.slice(0, 8)}\`\n\n` +
			`${acceptedCount} new pattern${acceptedCount === 1 ? '' : 's'} proposed.\n` +
			`Report: \`${reportPath.replace(homedir(), '~')}\`\n\n` +
			`Review, approve everything, or skip until next run.`;

		const result = await sendTelegramText(chatId, text, cfg.delivery, {
			replyMarkup: buildIntentBatchKeyboard(batchId),
		});
		return result.ok;
	} catch (err) {
		console.warn(`[intent-learner] telegram nudge failed: ${(err as Error).message}`);
		return false;
	}
}

export async function runIntentMining(
	opts: RunIntentMiningOptions = {},
): Promise<IntentMiningResult> {
	const startMs = Date.now();
	const lookbackDays = Math.max(1, opts.lookbackDays ?? 7);
	const minNewRows = Math.max(0, opts.minNewRows ?? 10);
	const batchId = randomUUID();
	const today = ymdInTz(Date.now());
	const vaultDir = resolve((soulHubConfig.paths?.vaultDir ?? '~/vault').replace(/^~/, homedir()));

	const corpusPath = resolve(soulHubDataDir(), `intent-corpus-${batchId}.md`);
	const proposalsPath = resolve(soulHubDataDir(), `intent-proposals-${batchId}.json`);
	const reportPath = resolve(vaultDir, VAULT_OPS_DIR, `intent-patterns-${today}.md`);

	// ADR-023 retention sweep — runs before the analyst so the corpus
	// never includes rows the analyst would skip anyway. Best-effort, never
	// throws back to the caller (pruneIntentLog's internal try/catch).
	let intentLogRowsPruned = 0;
	try {
		intentLogRowsPruned = pruneIntentLog();
	} catch (err) {
		console.warn(`[intent-learner] prune failed: ${(err as Error).message}`);
	}

	const baseResult: IntentMiningResult = {
		batchId,
		corpusRows: 0,
		conversationsCovered: 0,
		rejectedSignaturesSkipped: 0,
		agentStatus: 'skipped',
		agentCostUsd: 0,
		proposalsRead: 0,
		proposalsAccepted: 0,
		proposalsDroppedInvalidCitation: 0,
		proposalsDroppedConfidence: 0,
		proposalsDroppedAlreadyRejected: 0,
		corpusPath,
		reportPath,
		proposalsPath,
		telegramNudgeSent: false,
		intentLogRowsPruned,
		durationMs: 0,
		skipped: false,
	};

	// minNewRows gate — count rows since the watermark and bail if too few.
	const watermark = opts.lastRunAt ?? 0;
	if (minNewRows > 0 && watermark > 0) {
		const newRows = countNewIntentRows(watermark);
		if (newRows < minNewRows) {
			return {
				...baseResult,
				skipped: true,
				skipReason: `only ${newRows} new intent_log rows since last run (min ${minNewRows})`,
				durationMs: Date.now() - startMs,
			};
		}
	}

	const windowStart = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
	const { intentRows: allIntentRows, chatRows } = readWindow(windowStart);
	if (allIntentRows.length === 0) {
		return {
			...baseResult,
			skipped: true,
			skipReason: `intent_log empty in last ${lookbackDays} days`,
			durationMs: Date.now() - startMs,
		};
	}

	// Cap to most-recent N rows. readWindow returns ASC; slice from the tail.
	const intentRows =
		allIntentRows.length > MAX_CORPUS_ROWS
			? allIntentRows.slice(allIntentRows.length - MAX_CORPUS_ROWS)
			: allIntentRows;

	const rejected = rejectedSignatures();
	const corpusMd = buildCorpusMarkdown(batchId, intentRows, chatRows, rejected, lookbackDays);

	await mkdir(dirname(corpusPath), { recursive: true });
	await writeFile(corpusPath, corpusMd, 'utf-8');
	await mkdir(dirname(reportPath), { recursive: true });
	// Pre-create an empty proposals file so the agent's Write step is replace, not create-in-missing-parent.
	await writeFile(proposalsPath, '{"proposals":[]}', 'utf-8');

	const task =
		`# Intent learning run — batch ${batchId}\n\n` +
		`Read CORPUS_PATH, propose deterministic routing patterns per your operating manual, ` +
		`write the markdown report, write the JSON proposals, emit the done trailer.\n\n` +
		`CORPUS_PATH: ${corpusPath}\n` +
		`REPORT_PATH: ${reportPath}\n` +
		`PROPOSALS_PATH: ${proposalsPath}\n` +
		`BATCH_ID: ${batchId}\n\n` +
		`Stop when the trailer is printed. Do not modify any other files.`;

	let agentStatus: IntentMiningResult['agentStatus'] = 'error';
	let agentCostUsd = 0;
	try {
		const r = await dispatchAndCollect(task, opts.signal);
		agentStatus = r.status;
		agentCostUsd = r.costUsd;
	} catch (err) {
		console.error(`[intent-learner] dispatch failed: ${(err as Error).message}`);
		return {
			...baseResult,
			corpusRows: intentRows.length,
			conversationsCovered: new Set(intentRows.map((r) => r.conversation_key)).size,
			agentStatus: 'error',
			durationMs: Date.now() - startMs,
		};
	}

	if (agentStatus !== 'success') {
		return {
			...baseResult,
			corpusRows: intentRows.length,
			conversationsCovered: new Set(intentRows.map((r) => r.conversation_key)).size,
			agentStatus,
			agentCostUsd,
			durationMs: Date.now() - startMs,
		};
	}

	// Parse the proposals file. Citation validation runs against a set of
	// every raw_message string in the window — exact match only.
	const intentRawMessages = new Set(intentRows.map((r) => r.raw_message));

	let proposalsFile: ProposalsFile;
	try {
		const text = await readFile(proposalsPath, 'utf-8');
		proposalsFile = JSON.parse(text) as ProposalsFile;
	} catch (err) {
		console.error(`[intent-learner] could not parse proposals file: ${(err as Error).message}`);
		return {
			...baseResult,
			corpusRows: intentRows.length,
			conversationsCovered: new Set(intentRows.map((r) => r.conversation_key)).size,
			agentStatus,
			agentCostUsd,
			durationMs: Date.now() - startMs,
		};
	}

	const rawProposals: AgentProposalRaw[] = Array.isArray(proposalsFile.proposals)
		? (proposalsFile.proposals as AgentProposalRaw[])
		: [];

	let droppedInvalidCitation = 0;
	let droppedConfidence = 0;
	let droppedAlreadyRejected = 0;
	const validProposals: PatternProposal[] = [];

	for (const raw of rawProposals) {
		const built = validateAndBuildProposal(raw, batchId, intentRawMessages);
		if (!built) {
			droppedInvalidCitation += 1;
			continue;
		}
		if (!built.allCitationsResolved) {
			console.warn(
				`[intent-learner] proposal "${built.proposal.signature}" dropped — unresolved citations: ${built.unresolvedCitations.join(' | ')}`,
			);
			droppedInvalidCitation += 1;
			continue;
		}
		if (built.proposal.confidence < CONFIDENCE_FLOOR) {
			droppedConfidence += 1;
			continue;
		}
		if (rejected.has(built.proposal.signature.toLowerCase())) {
			droppedAlreadyRejected += 1;
			continue;
		}
		validProposals.push(built.proposal);
	}

	const accepted = writeProposals(validProposals);

	const nudgeWanted = opts.notify !== 'none' && accepted > 0;
	const telegramNudgeSent = nudgeWanted ? await sendOperatorNudge(batchId, accepted, reportPath) : false;

	return {
		batchId,
		corpusRows: intentRows.length,
		conversationsCovered: new Set(intentRows.map((r) => r.conversation_key)).size,
		rejectedSignaturesSkipped: droppedAlreadyRejected,
		agentStatus,
		agentCostUsd,
		proposalsRead: rawProposals.length,
		proposalsAccepted: accepted,
		proposalsDroppedInvalidCitation: droppedInvalidCitation,
		proposalsDroppedConfidence: droppedConfidence,
		proposalsDroppedAlreadyRejected: droppedAlreadyRejected,
		corpusPath,
		reportPath,
		proposalsPath,
		telegramNudgeSent,
		intentLogRowsPruned,
		durationMs: Date.now() - startMs,
		skipped: false,
	};
}
