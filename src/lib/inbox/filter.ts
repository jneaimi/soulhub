/**
 * Layer 2 inbox filter — worker entry point.
 *
 * Lifecycle (mirrors src/lib/inbox/sync.ts):
 *   startFilterWorker() — auth probe → cold-start sweep → setInterval(tick, 10s)
 *   stopFilterWorker()  — clearInterval, let in-flight batch complete or timeout
 *
 * Per tick:
 *   1. Skip if inFlight or backoffUntil > now
 *   2. Fetch up to 25 rows (process_status='new' AND filtered_at IS NULL)
 *   3. Group by account; refetch headers from IMAP (BODY.PEEK[HEADER])
 *   4. For each row:
 *      a. Cache hit → applyClassification + bump cache; done
 *      b. Rule match → applyClassification + set cache; done
 *      c. Gray area → add to LLM batch
 *   5. Flush LLM batch in chunks of 8 via classifyBatch()
 *   6. Persist results + cache writes
 *
 * Concurrency: single in-flight flag — overlapping ticks are dropped.
 * Failure: each error class drives the retry/backoff/alert policy (see
 * handleLLMFailure). Rows stuck in `new` for 7d get promoted to
 * unclassified/queued by the prune sweep (see db.ts:pruneOldMessages).
 *
 * Kill switches (~/.soul-hub/.env):
 *   INBOX_FILTER_DISABLED=1         → worker skips startup entirely
 *   INBOX_FILTER_LLM_DISABLED=1     → rules-only mode, gray area stays 'new'
 *   INBOX_FILTER_COLDSTART_SKIP=1   → skip the historical sweep, forward-only
 *
 * See ADR 2026-05-11-inbox-processing-filter-layer.
 */

import {
	listMessagesForFiltering,
	listFilterRules,
	getFilterCache,
	setFilterCache,
	bumpFilterCacheHit,
	applyClassification,
	setMessageHeaderSignals,
	getAccount,
	getMessage,
	reclassifyBySignature,
	getExtractedData,
	setExtractedData,
	recordAgentAction,
} from './db.js';
import type { InboxMessage, FilterCategory } from './types.js';
import { fetchImapHeaders } from './body.js';
import { SHIPPING_PATTERN } from './route-to-vault.js';
import { findContactByEmail } from '../crm/index.js';

/** Carrier domains we trust to send delivery / shipping notifications. */
const CARRIER_DOMAINS = /\b(amazon\.(com|ae|sa)|noon\.com|aramex\.com|dhl\.com|fedex\.com|fetchr\.com|ups\.com|talabat\.com|deliveroo\.com|careem\.com)\b/i;

/** Post-classification heuristic correction.
 *
 *  The LLM (and operator-added rules) sometimes label delivery confirmations
 *  as `transactional` because the body mentions an order total. They're
 *  clearly `notification` (shipping subtype) — the L3 auto-route worker only
 *  fires the shipping rule for `category=notification`, so a mis-categorized
 *  Amazon delivery sits forever in the queue. This deterministic override
 *  catches that pattern after classification and corrects it.
 *
 *  Trigger: subject matches the shipping regex AND sender is a known carrier
 *  domain. False-positive risk is low — a real bank email about an order
 *  rarely has both signals together.
 */
function correctCategoryHeuristic(message: { fromAddress: string; subject: string }, category: FilterCategory): FilterCategory {
	if (category !== 'transactional') return category;
	const subjMatch = SHIPPING_PATTERN.test(message.subject || '');
	const senderMatch = CARRIER_DOMAINS.test(message.fromAddress || '');
	if (subjMatch && senderMatch) return 'notification';
	return category;
}

/** ADR-044.F — CRM safety rail.
 *
 *  Active CRM contacts must never be silently filtered out of the
 *  digest. If the classifier (cache / rule / LLM) lands on a
 *  skipped category (`bulk` or `promotional`) for a sender we're
 *  actively tracking, upgrade to `personal` so the mail surfaces.
 *  The closest existing "this is a human worth my attention" bucket
 *  is `personal` — no new category, no migration.
 *
 *  Active = any stage except `Lost`. `Won` contacts still count
 *  (post-sale relationships matter), and pre-`Won` stages obviously
 *  do too.
 *
 *  Cache semantics: when this corrector fires, we write the UPGRADED
 *  category to the filter cache. That makes the upgrade sticky for
 *  the sender — even if they're later removed from CRM, future mail
 *  keeps surfacing until the cache entry is evicted. Acceptable
 *  trade-off; the operator can always re-classify manually.
 *
 *  The check is one indexed PK lookup per cache-miss message. Cache
 *  hits skip this when the cached category is already not skipped.
 */
function crmProtectedCorrection(
	message: { fromAddress: string },
	category: FilterCategory,
): FilterCategory {
	if (category !== 'bulk' && category !== 'promotional') return category;
	if (!message.fromAddress) return category;
	const match = findContactByEmail(message.fromAddress);
	if (!match) return category;
	if (match.contact.stage === 'Lost') return category;
	return 'personal';
}

/** Chain shipping + CRM corrections. Returns the final category and
 *  a tag list for the reason string. Empty tag list means no override
 *  fired — caller uses the raw classifier reason. */
function correctCategory(
	message: { fromAddress: string; subject: string },
	category: FilterCategory,
): { category: FilterCategory; tags: string[] } {
	const tags: string[] = [];
	const afterShipping = correctCategoryHeuristic(message, category);
	if (afterShipping !== category) tags.push('shipping-override');
	const afterCrm = crmProtectedCorrection(message, afterShipping);
	if (afterCrm !== afterShipping) tags.push('crm-protected');
	return { category: afterCrm, tags };
}
import {
	classifyByRules,
	parseHeaderSignals,
	cacheSignature,
} from './filter-rules.js';
import {
	probeClaudeAuth,
	classifyBatch,
	type BatchEntry,
	type LLMOutcome,
} from './filter-llm.js';
import {
	markFilterFailed,
	markFilterRecovered,
} from './filter-notifications.js';
import { extractTransactional, inputFromMessage } from './extractor.js';

// ── Module state ──

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let llmAvailable = false;
let lastTickAt: number | null = null;
let lastError: string | null = null;
let backoffUntilMs = 0;
let consecutiveLLMFailures = 0;

const TICK_INTERVAL_MS = 10_000;
const TICK_BATCH_LIMIT = 25;
const COLD_START_CHUNK = 200;
const LLM_BATCH_SIZE = 8;

// Backoff schedule by error class (ms).
const BACKOFF_RATE_LIMIT = [5 * 60_000, 15 * 60_000, 30 * 60_000];
let rateLimitStage = 0;

// ── Env switches ──

function isFilterDisabled(): boolean {
	return process.env.INBOX_FILTER_DISABLED === '1';
}
function isLLMDisabled(): boolean {
	return process.env.INBOX_FILTER_LLM_DISABLED === '1';
}
function isColdStartSkipped(): boolean {
	return process.env.INBOX_FILTER_COLDSTART_SKIP === '1';
}
function isEagerExtractEnabled(): boolean {
	return process.env.INBOX_TRANSACTIONAL_EAGER_EXTRACT === '1';
}

// ── Eager extraction hook (Layer 3 Stage 2 §D3) ──

/** When eager mode is on AND the row was just classified as transactional,
 *  fire the extractor in the background so S3's anomaly push has cached
 *  `extracted_data` available without a per-tick LLM burst.
 *
 *  Fire-and-forget via setImmediate — matches commitments-extractor's
 *  pattern. Errors are caught and logged so a single bad row never
 *  blocks the worker loop. `getExtractedData` short-circuits if the
 *  row has already been extracted (e.g. orchestrator tool ran first).
 *
 *  Writes an audit row with `actor='worker'` so analysts can later
 *  distinguish eager-mode runs from tool-driven ones in agent_actions. */
function maybeQueueEagerExtraction(
	messageId: number,
	category: FilterCategory,
	msg: InboxMessage,
): void {
	if (!isEagerExtractEnabled()) return;
	if (category !== 'transactional') return;

	setImmediate(async () => {
		try {
			const existing = getExtractedData(messageId);
			if (existing) return;
			const result = await extractTransactional(inputFromMessage(msg));
			setExtractedData(messageId, result.extract);
			recordAgentAction({
				tool: 'inbox-extract-data',
				messageId,
				actor: 'worker',
				args: { mode: 'eager' },
				result: {
					ok: result.ok,
					kind: result.extract.kind,
					reason: result.reason,
					usedBodyFallback: result.usedBodyFallback,
				},
			});
		} catch (err) {
			console.warn(
				`[inbox-filter/eager-extract] message ${messageId}: ${(err as Error).message}`,
			);
		}
	});
}

// ── Public lifecycle ──

export async function startFilterWorker(): Promise<void> {
	if (isFilterDisabled()) {
		console.log('[inbox-filter] Disabled via INBOX_FILTER_DISABLED=1');
		return;
	}

	// Auth probe — sets llmAvailable. Failure → rules-only mode + Telegram alert.
	const probe = await probeClaudeAuth();
	llmAvailable = probe.ok;
	if (!llmAvailable) {
		console.warn(`[inbox-filter] Auth probe failed: ${probe.message}`);
		const cls = /(binary|not found|enoent|spawn)/i.test(probe.message) ? 'binary-missing' : 'auth';
		markFilterFailed(cls, probe.message);
	} else {
		console.log('[inbox-filter] Auth probe ok — LLM available');
	}

	// Cold-start sweep (may take 5-15 minutes for a 2000+ message backlog).
	// We DON'T await this from hooks.server.ts (the start call is .then()'d
	// fire-and-forget), so SvelteKit boot is not blocked. The interval below
	// only starts after cold-start completes, so there's no race on rows.
	if (isColdStartSkipped()) {
		console.log('[inbox-filter] Cold-start skipped via INBOX_FILTER_COLDSTART_SKIP=1');
	} else {
		try {
			await runColdStart();
		} catch (err) {
			console.error('[inbox-filter] Cold-start error:', err);
			lastError = `cold-start: ${(err as Error).message}`;
		}
	}

	interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
	console.log(`[inbox-filter] Worker started (poll ${TICK_INTERVAL_MS / 1000}s)`);
}

export async function stopFilterWorker(): Promise<void> {
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
	// We don't await any in-flight batch; setInterval-driven ticks have their
	// own 30s LLM timeout. The next process boot picks up where we left off
	// via the `filtered_at IS NULL` idempotency.
	console.log('[inbox-filter] Worker stopped');
}

/** Diagnostic — feeds GET /api/inbox/filter/stats. */
export function getFilterWorkerStatus(): {
	enabled: boolean;
	llmAvailable: boolean;
	llmDisabled: boolean;
	lastTickAt: number | null;
	lastError: string | null;
	backoffUntilMs: number;
} {
	return {
		enabled: !isFilterDisabled(),
		llmAvailable,
		llmDisabled: isLLMDisabled(),
		lastTickAt,
		lastError,
		backoffUntilMs,
	};
}

// ── Cold-start sweep ──

async function runColdStart(): Promise<void> {
	const workerStartTs = Date.now();
	console.log('[inbox-filter] Cold-start sweep beginning…');
	let totalProcessed = 0;
	let totalClassified = 0;

	while (true) {
		if (Date.now() < backoffUntilMs) {
			console.warn('[inbox-filter] Cold-start paused — backoff active');
			return;
		}
		const messages = listMessagesForFiltering({
			workerStartTs,
			limit: COLD_START_CHUNK,
		});
		if (messages.length === 0) break;

		const summary = await processChunk(messages);
		totalProcessed += summary.processed;
		totalClassified += summary.cacheHits + summary.ruleHits + summary.llmHits;
		console.log(
			`[inbox-filter] cold-start chunk: processed=${summary.processed} ` +
				`cache=${summary.cacheHits} rule=${summary.ruleHits} llm=${summary.llmHits} ` +
				`gray=${summary.grayLeftover} failed=${summary.failed}`,
		);
	}

	console.log(
		`[inbox-filter] Cold-start complete. processed=${totalProcessed} classified=${totalClassified}`,
	);
}

// ── Steady-state tick ──

async function tick(): Promise<void> {
	if (inFlight) return;
	if (Date.now() < backoffUntilMs) return;
	inFlight = true;
	try {
		const messages = listMessagesForFiltering({ limit: TICK_BATCH_LIMIT });
		if (messages.length === 0) {
			lastTickAt = Date.now();
			return;
		}
		await processChunk(messages);
	} catch (err) {
		console.error('[inbox-filter] tick error:', err);
		lastError = (err as Error).message ?? String(err);
	} finally {
		lastTickAt = Date.now();
		inFlight = false;
	}
}

// ── Chunk processor (used by both cold-start and tick) ──

interface ChunkSummary {
	processed: number;
	cacheHits: number;
	ruleHits: number;
	llmHits: number;
	grayLeftover: number;
	failed: number;
}

async function processChunk(messages: InboxMessage[]): Promise<ChunkSummary> {
	const summary: ChunkSummary = {
		processed: messages.length,
		cacheHits: 0,
		ruleHits: 0,
		llmHits: 0,
		grayLeftover: 0,
		failed: 0,
	};

	const rules = listFilterRules({ enabledOnly: true });

	// Group by account so we open at most one IMAP connection per account
	// per chunk for header refetch.
	const byAccount = new Map<string, InboxMessage[]>();
	for (const m of messages) {
		const list = byAccount.get(m.accountId) ?? [];
		list.push(m);
		byAccount.set(m.accountId, list);
	}

	const grayArea: BatchEntry[] = [];
	const grayMessages = new Map<number, InboxMessage>();

	for (const [accountId, msgs] of byAccount) {
		const account = getAccount(accountId);
		if (!account) {
			console.warn(`[inbox-filter] Skipping ${msgs.length} messages — account ${accountId} not found`);
			continue;
		}

		// 1. Cache pass — handle anything we've seen before WITHOUT needing
		// header refetch. Cuts IMAP traffic significantly post-cold-start.
		const remaining: InboxMessage[] = [];
		for (const msg of msgs) {
			const sig = cacheSignature(msg);
			const cached = getFilterCache(sig);
			if (cached) {
				const { category: correctedCategory, tags } = correctCategory(msg, cached.category);
				const reason = tags.length === 0 ? 'cache:hit' : `cache:hit+${tags.join('+')}`;
				applyClassification(msg.id, {
					category: correctedCategory,
					reason,
				});
				bumpFilterCacheHit(sig);
				summary.cacheHits++;
				maybeQueueEagerExtraction(msg.id, correctedCategory, msg);
				continue;
			}
			remaining.push(msg);
		}

		if (remaining.length === 0) continue;

		// 2. Header refetch — one IMAP call per account for the cache-miss UIDs.
		let headersMap: Map<number, string>;
		try {
			headersMap = await fetchImapHeaders(account, remaining.map((m) => m.uid));
		} catch (err) {
			console.warn(
				`[inbox-filter] Header refetch failed for ${account.email}: ${(err as Error).message}. ` +
					`Falling back to envelope-only rules for this chunk.`,
			);
			headersMap = new Map();
			summary.failed += remaining.length;
			// Don't abort — rules still match on envelope.
		}

		// 3. Rule pass per remaining message.
		for (const msg of remaining) {
			const rawHeaders = headersMap.get(msg.uid) ?? null;
			const signals = parseHeaderSignals(rawHeaders ?? '');
			const signalsJson = JSON.stringify(signals);

			const sig = cacheSignature(msg);
			const result = classifyByRules(rules, msg, rawHeaders);
			if (result) {
				const { category: correctedCategory, tags } = correctCategory(msg, result.category);
				const correctedReason = tags.length === 0 ? result.reason : `${result.reason}+${tags.join('+')}`;
				applyClassification(msg.id, {
					category: correctedCategory,
					reason: correctedReason,
					headerSignalsJson: signalsJson,
				});
				setFilterCache({
					signature: sig,
					category: correctedCategory,
					reason: correctedReason,
				});
				summary.ruleHits++;
				maybeQueueEagerExtraction(msg.id, correctedCategory, msg);
				continue;
			}

			// 4. Gray area — persist parsed signals + queue for LLM.
			setMessageHeaderSignals(msg.id, signalsJson);
			grayArea.push({
				id: msg.id,
				fromAddress: msg.fromAddress,
				subject: msg.subject,
				bodyPreview: msg.bodyPreview,
			});
			grayMessages.set(msg.id, msg);
		}
	}

	// 5. LLM batch — flush gray area in chunks of LLM_BATCH_SIZE.
	if (grayArea.length > 0 && llmAvailable && !isLLMDisabled()) {
		for (let i = 0; i < grayArea.length; i += LLM_BATCH_SIZE) {
			const chunk = grayArea.slice(i, i + LLM_BATCH_SIZE);
			const outcome = await classifyBatch(chunk);
			if (!outcome.ok) {
				handleLLMFailure(outcome);
				summary.grayLeftover += chunk.length;
				// Stop the loop — backoff is set, rows stay 'new' for retry.
				break;
			}
			for (const r of outcome.results) {
				const original = grayMessages.get(r.id);
				if (!original) continue;
				const { category: correctedCategory, tags } = correctCategory(original, r.category);
				const correctedReason = tags.length === 0 ? `llm:${r.category}` : `llm:${r.category}+${tags.join('+')}`;
				applyClassification(r.id, {
					category: correctedCategory,
					reason: correctedReason,
				});
				setFilterCache({
					signature: cacheSignature(original),
					category: correctedCategory,
					reason: correctedReason,
				});
				summary.llmHits++;
				maybeQueueEagerExtraction(r.id, correctedCategory, original);
			}
			// Track results that did not parse — those rows stay 'new' for retry.
			const classifiedIds = new Set(outcome.results.map((r) => r.id));
			summary.grayLeftover += chunk.filter((b) => !classifiedIds.has(b.id)).length;

			// Successful classification clears prior alerts AND the stale
			// `lastError` diagnostic (so /api/inbox/filter/stats reflects
			// current state, not the last-seen error from minutes ago).
			if (outcome.results.length > 0) {
				consecutiveLLMFailures = 0;
				rateLimitStage = 0;
				lastError = null;
				markFilterRecovered();
			}
		}
	} else if (grayArea.length > 0) {
		summary.grayLeftover += grayArea.length;
	}

	return summary;
}

// ── Failure handling ──

function handleLLMFailure(outcome: Extract<LLMOutcome, { ok: false }>): void {
	consecutiveLLMFailures++;
	lastError = `llm:${outcome.errorClass}: ${outcome.message.slice(0, 160)}`;

	switch (outcome.errorClass) {
		case 'auth': {
			llmAvailable = false;
			backoffUntilMs = Date.now() + 60 * 60_000; // 1 hour cool-off
			markFilterFailed('auth', outcome.message);
			break;
		}
		case 'spawn': {
			llmAvailable = false;
			backoffUntilMs = Date.now() + 60 * 60_000;
			markFilterFailed('binary-missing', outcome.message);
			break;
		}
		case 'rate-limit': {
			const stage = Math.min(rateLimitStage, BACKOFF_RATE_LIMIT.length - 1);
			const wait = BACKOFF_RATE_LIMIT[stage];
			backoffUntilMs = Date.now() + wait;
			rateLimitStage++;
			if (wait >= 15 * 60_000) {
				markFilterFailed('rate-limit', `Backing off for ${Math.round(wait / 60_000)} min`);
			}
			break;
		}
		case 'timeout':
		case 'network':
		case 'unknown':
		case 'parse':
		default: {
			// Soft retry — next tick will pick up the same rows.
			// 3+ consecutive failures of the same class → escalate as 'persistent'.
			if (consecutiveLLMFailures >= 3) {
				backoffUntilMs = Date.now() + 5 * 60_000;
				markFilterFailed('persistent', `${outcome.errorClass}: ${outcome.message}`);
			}
			break;
		}
	}
}

// ── Correction loop (called from API + agent tool) ──

/**
 * Apply a user/agent correction. Updates the cache and (if scope='pattern')
 * re-classifies all sibling messages in 'new' or 'skipped' state. Returns
 * the number of sibling rows that were updated (does not count the row that
 * was the source of the correction unless its state changed too).
 */
export function correctClassification(
	messageId: number,
	input: {
		category: FilterCategory;
		scope?: 'this' | 'pattern';
		reason?: string;
	},
): { ok: boolean; siblingsUpdated: number; reason?: string } {
	const msg = getMessage(messageId);
	if (!msg) return { ok: false, siblingsUpdated: 0, reason: 'not_found' };

	const scope = input.scope ?? 'pattern';
	const reason = input.reason ?? `user-corrected:${input.category}`;
	const sig = cacheSignature(msg);

	// 1. Always update this row. preserveProcessed=true keeps agent-handled
	// rows in the `processed` state even when the operator reclassifies them
	// — the agent's work doesn't get re-queued.
	applyClassification(messageId, {
		category: input.category,
		reason,
		preserveProcessed: true,
	});
	maybeQueueEagerExtraction(messageId, input.category, msg);

	// 2. Update cache (user-corrected).
	setFilterCache({
		signature: sig,
		category: input.category,
		reason,
		userCorrected: true,
	});

	// 3. Sibling pass. Exclude the source row so the returned count is the
	// true number of OTHER rows reclassified (no off-by-one to back out).
	let siblingsUpdated = 0;
	if (scope === 'pattern') {
		siblingsUpdated = reclassifyBySignature(
			sig,
			input.category,
			reason,
			cacheSignature,
			messageId,
		);
	}

	return { ok: true, siblingsUpdated };
}
