/** Layer 3 Stage 4 — auto vault-routing worker.
 *
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D5.
 *
 *  Periodic loop (default 60s) that picks queued messages whose category
 *  + cached `extracted_data` match an operator-enabled per-category rule
 *  and saves them to the vault. ALL rules default OFF — the operator
 *  opts in per-category. The only Layer 3 surface that auto-acts.
 *
 *  Composition with the existing inbox machinery:
 *    - L2 filter classifies + caches → queued
 *    - L3 S2 extracts transactional data → extracted_data
 *    - L3 S3a (heartbeat) maybe-pushes anomalies → agent_actions
 *    - L3 S4 (this worker) maybe-routes to vault → agent_actions + vault note + processed
 *
 *  Deduplication: an `inbox-route-to-vault` agent_actions row whose
 *  `result.ok=1` is the load-bearing exclusion. Without it the worker
 *  would re-route on every tick. Idempotency inside routeMessageToVault
 *  (checks processStatus=='processed' before saving) is a second-line
 *  defense in case the candidate query and the action log fall out of
 *  sync.
 *
 *  Kill switches honored at every tick:
 *    INBOX_AGENT_DISABLED=1 — all Layer 3 tools off
 *    INBOX_AUTO_ROUTE_DISABLED=1 — auto-route specifically off
 *    cfg.inbox.autoRoute.enabled=false — operator master toggle
 */

import { getInboxDb, rowToMessage, markMessageProcessed, recordAgentAction } from './db.js';
import { routeMessageToVault, SHIPPING_PATTERN } from './route-to-vault.js';
import type { InboxMessage } from './types.js';
import type { TransactionalExtract } from './extractor.js';
import type { InboxAutoRouteConfig } from '../config.schema.js';

export interface ListAutoRouteCandidatesOptions {
	lookbackHours: number;
	limit: number;
}

/** Fetch rows eligible for auto-route this tick.
 *
 *  Requirements:
 *    - process_status='queued' (skip processed/skipped/new)
 *    - category in (transactional, notification) — the two surfaces with
 *      rules in v1; personal stays manual-save-only
 *    - extracted_data present for transactional (we need the kind/amount
 *      to apply rules); NULL ok for notification (rules don't read it)
 *    - within lookback window
 *    - NO prior `inbox-route-to-vault` success in agent_actions
 *
 *  Permissive query — the gate function decides routing based on current
 *  rule config, so a row that didn't match yesterday's threshold can
 *  match today's lower one. */
export function listAutoRouteCandidates(opts: ListAutoRouteCandidatesOptions): InboxMessage[] {
	const db = getInboxDb();
	const sinceMs = Date.now() - opts.lookbackHours * 3600 * 1000;
	// ORDER DESC so the worker evaluates newest-first — operator sees signal
	// on the freshest mail immediately. The LIMIT must be high enough that
	// the worker can reach matching rows even when the lookback window
	// contains hundreds of no-match candidates: route attempts on no-match
	// rows don't write to agent_actions (we don't want a rule change to be
	// blocked by historical "skipped" rows), so the candidate query returns
	// the same set every tick. Without a generous limit, the worker would
	// re-scan the same N oldest no-match rows forever and never advance.
	const rows = db
		.prepare(
			`SELECT m.* FROM messages m
			 WHERE m.process_status = 'queued'
			   AND m.category IN ('transactional', 'notification')
			   AND m.date_received > ?
			   AND NOT EXISTS (
				 SELECT 1 FROM agent_actions a
				 WHERE a.message_id = m.id
				   AND a.tool = 'inbox-route-to-vault'
				   AND json_extract(a.result, '$.ok') = 1
			   )
			 ORDER BY m.date_received DESC
			 LIMIT ?`,
		)
		.all(sinceMs, opts.limit) as Record<string, unknown>[];
	return rows.map(rowToMessage);
}

export type AutoRouteReason =
	| 'receipt.over-threshold'
	| 'payment.over-threshold'
	| 'refund.over-threshold'
	| 'subscription-renewal.over-threshold'
	| 'statement.always'
	| 'alert.anomaly'
	| 'shipping.always'
	| 'service-alert.anomaly'
	| 'otp.auto-delete'
	| 'no-match';

/** Worker decision per candidate row. `route` writes a vault note; `delete`
 *  marks the message processed and skips the vault write — used for short-
 *  lived categories where a vault note is noise (OTPs). `no-match` leaves
 *  the row queued for the next prune sweep. */
export interface AutoRouteDecision {
	action: 'route' | 'delete' | 'skip';
	reason: AutoRouteReason;
}

/** Apply the per-category rules. Returns {route, reason} so the worker
 *  records the reason in agent_actions for tuning later. */
export function evaluateAutoRouteRule(
	message: InboxMessage,
	extract: TransactionalExtract | null,
	cfg: InboxAutoRouteConfig,
): AutoRouteDecision {
	if (message.category === 'transactional') {
		if (!extract) return { action: 'skip', reason: 'no-match' };

		// OTPs come FIRST — they're auto-deleted regardless of amount.
		// Saving a one-time password to the vault is noise; it expires
		// within minutes of arrival.
		if (extract.kind === 'otp' && cfg.otps.enabled) {
			return { action: 'delete', reason: 'otp.auto-delete' };
		}
		if (extract.kind === 'receipt' && cfg.receipts.enabled) {
			if (matchesAmount(extract, cfg.receipts.minAmount, cfg.receipts.currency)) {
				return { action: 'route', reason: 'receipt.over-threshold' };
			}
		}
		if (extract.kind === 'payment' && cfg.payments.enabled) {
			if (matchesAmount(extract, cfg.payments.minAmount, cfg.payments.currency)) {
				return { action: 'route', reason: 'payment.over-threshold' };
			}
		}
		if (extract.kind === 'refund' && cfg.refunds.enabled) {
			if (matchesAmount(extract, cfg.refunds.minAmount, cfg.refunds.currency)) {
				return { action: 'route', reason: 'refund.over-threshold' };
			}
		}
		if (extract.kind === 'subscription-renewal' && cfg.subscriptionRenewals.enabled) {
			if (matchesAmount(extract, cfg.subscriptionRenewals.minAmount, cfg.subscriptionRenewals.currency)) {
				return { action: 'route', reason: 'subscription-renewal.over-threshold' };
			}
		}
		if (extract.kind === 'statement' && cfg.statements.enabled) {
			// Statements always route — there's no amount to threshold; the
			// file itself IS the record (bank PDF attached). Operator can
			// disable the rule entirely if they don't want statements in
			// the vault.
			return { action: 'route', reason: 'statement.always' };
		}
		if (extract.kind === 'alert' && cfg.alerts.enabled) {
			if (!cfg.alerts.anomalyOnly || extract.anomalyHint === true) {
				return { action: 'route', reason: 'alert.anomaly' };
			}
		}
		// Unknown — defer (operator may want to manually classify).
		return { action: 'skip', reason: 'no-match' };
	}

	if (message.category === 'notification') {
		// Shipping is the always-on slot; we use a subject heuristic to
		// distinguish it from generic service-alerts. The extractor doesn't
		// run on notifications today, so we lean on the from-address /
		// subject for the split.
		const looksLikeShipping = SHIPPING_PATTERN.test(message.subject)
			|| SHIPPING_PATTERN.test(message.fromAddress);
		if (looksLikeShipping && cfg.shipping.enabled) {
			return { action: 'route', reason: 'shipping.always' };
		}
		if (!looksLikeShipping && cfg.serviceAlerts.enabled) {
			// service-alerts can require anomaly-only when the extractor
			// has populated data for the row (rare for notification today
			// but the gate stays consistent if S2 expands to notifications).
			if (!cfg.serviceAlerts.anomalyOnly || extract?.anomalyHint === true) {
				return { action: 'route', reason: 'service-alert.anomaly' };
			}
		}
		return { action: 'skip', reason: 'no-match' };
	}

	return { action: 'skip', reason: 'no-match' };
}

function matchesAmount(extract: TransactionalExtract, minAmount: number, currency: string): boolean {
	const expectedCur = currency.trim().toUpperCase();
	const actualCur = (extract.currency || '').trim().toUpperCase();

	// "Route everything" mode: when the operator zeroed the threshold, the
	// kind already qualified the message (it IS a receipt/payment/refund —
	// the L2 extractor said so). Currency/amount become advisory. Route
	// regardless so the operator gets the full ledger; sub-AED Microsoft
	// invoices or USD top-ups still land in finance/ where they belong.
	if (minAmount <= 0) return true;

	// Threshold-mode: amount + currency must BOTH be present and match.
	if (typeof extract.amount !== 'number' || !Number.isFinite(extract.amount)) return false;
	if (extract.amount < minAmount) return false;
	// Empty actual currency = unknown — can't compare a threshold without
	// units. Defer. Empty config currency = wildcard (rare; means "any
	// currency at or above this number").
	if (!actualCur) return false;
	if (expectedCur && expectedCur !== actualCur) return false;
	return true;
}

export interface AutoRouteTickResult {
	considered: number;
	routed: number;
	deleted: number;
	skipped: number;
	errors: number;
	stopReason?: 'kill-switch' | 'master-disabled' | 'empty';
}

let tickInProgress = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Run one auto-route tick. Returns counts for telemetry. */
export async function runAutoRouteTick(cfg: InboxAutoRouteConfig): Promise<AutoRouteTickResult> {
	if (killSwitchActive()) {
		return { considered: 0, routed: 0, deleted: 0, skipped: 0, errors: 0, stopReason: 'kill-switch' };
	}
	if (!cfg.enabled) {
		return { considered: 0, routed: 0, deleted: 0, skipped: 0, errors: 0, stopReason: 'master-disabled' };
	}

	const candidates = listAutoRouteCandidates({
		lookbackHours: cfg.lookbackHours,
		// Hard ceiling of 500 — bounds the SQL cost while still covering the
		// realistic backlog (497 candidates over 30 days in the operator's
		// inbox at ship time). The perTickCap cuts off routing AFTER matches
		// are found, so even with 500 evaluated rows, only `perTickCap`
		// vault writes happen per tick.
		limit: 500,
	});
	if (candidates.length === 0) {
		return { considered: 0, routed: 0, deleted: 0, skipped: 0, errors: 0, stopReason: 'empty' };
	}

	let routed = 0;
	let deleted = 0;
	let skipped = 0;
	let errors = 0;

	for (const msg of candidates) {
		// `routed + deleted` together gate the per-tick cap so a flood of
		// OTPs can't starve real vault routes (and vice versa). Both are
		// "actions taken" from the operator's perspective.
		if (routed + deleted >= cfg.perTickCap) break;
		const extract = parseExtractedData(msg);
		const decision = evaluateAutoRouteRule(msg, extract, cfg);
		if (decision.action === 'skip') {
			skipped += 1;
			continue;
		}
		if (decision.action === 'delete') {
			try {
				const result = deleteMessageFromInbox(msg.id, decision.reason);
				if (result.ok) deleted += 1;
				else errors += 1;
			} catch (err) {
				console.warn(
					`[inbox-auto-route] delete threw for msg ${msg.id}: ${(err as Error).message}`,
				);
				errors += 1;
			}
			continue;
		}
		// decision.action === 'route'
		try {
			const result = await routeMessageToVault(msg.id, {
				actor: 'worker',
				reason: decision.reason,
			});
			if (result.ok) routed += 1;
			else errors += 1;
		} catch (err) {
			console.warn(
				`[inbox-auto-route] route-to-vault threw for msg ${msg.id}: ${(err as Error).message}`,
			);
			errors += 1;
		}
	}

	return { considered: candidates.length, routed, deleted, skipped, errors };
}

/** Mark a queued message processed without writing a vault note. Used for
 *  OTPs and similar short-lived categories where a vault note is noise. The
 *  message stays in inbox.db (with `process_status='processed'`) and is
 *  pruned out by `pruneOldMessages` at the 365-day audit retention — the
 *  trail "this was an OTP, auto-deleted" survives long enough that the
 *  operator can audit the policy without retaining the OTP body. */
function deleteMessageFromInbox(messageId: number, reason: AutoRouteReason): { ok: boolean; error?: string } {
	try {
		markMessageProcessed(messageId);
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: 'worker',
			args: { reason, action: 'delete' },
			result: { ok: true, messageId, reason, action: 'delete' },
		});
		return { ok: true };
	} catch (err) {
		const msg = (err as Error).message;
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: 'worker',
			args: { reason, action: 'delete' },
			result: { ok: false, messageId, error: msg, action: 'delete' },
		});
		return { ok: false, error: msg };
	}
}

function parseExtractedData(message: InboxMessage): TransactionalExtract | null {
	if (!message.extractedData) return null;
	try {
		return JSON.parse(message.extractedData) as TransactionalExtract;
	} catch {
		return null;
	}
}

function killSwitchActive(): boolean {
	if (process.env.INBOX_AGENT_DISABLED === '1') return true;
	if (process.env.INBOX_AUTO_ROUTE_DISABLED === '1') return true;
	return false;
}

/** Boot hook. Spins up the periodic tick. Idempotent — calling twice is
 *  a no-op (start is guarded by `intervalHandle`). The caller (hooks.server.ts)
 *  passes a thunk that loads the latest config on each tick so config edits
 *  via settings.json take effect without a worker restart. */
export function startAutoRouteWorker(getConfig: () => InboxAutoRouteConfig): void {
	if (intervalHandle) return;
	const initial = safeGetConfig(getConfig);
	if (!initial) {
		console.warn('[inbox-auto-route] startup skipped — config not loadable');
		return;
	}
	if (killSwitchActive()) {
		console.log(
			'[inbox-auto-route] startup skipped — kill switch (INBOX_AGENT_DISABLED or INBOX_AUTO_ROUTE_DISABLED) is set',
		);
		return;
	}

	const tickInterval = initial.intervalMs;
	const tick = async () => {
		if (tickInProgress) return;
		tickInProgress = true;
		try {
			const cfg = safeGetConfig(getConfig);
			if (!cfg) return;
			const result = await runAutoRouteTick(cfg);
			// Always log a tick line. The earlier "silent when idle" behavior
			// made the worker look dead during long stretches of no-match
			// candidates — the operator couldn't tell the difference between
			// "worker crashed" and "all 422 candidates correctly skipped."
			// Verbose IDLE lines for stop-reasons keep the dashboard honest.
			if (result.stopReason) {
				console.log(`[inbox-auto-route] tick: idle (${result.stopReason})`);
			} else {
				console.log(
					`[inbox-auto-route] tick: considered=${result.considered} routed=${result.routed} deleted=${result.deleted} skipped=${result.skipped} errors=${result.errors}`,
				);
			}
		} catch (err) {
			console.error(`[inbox-auto-route] tick threw: ${(err as Error).message}`);
		} finally {
			tickInProgress = false;
		}
	};

	intervalHandle = setInterval(() => void tick(), tickInterval);
	console.log(`[inbox-auto-route] worker started (poll ${Math.round(tickInterval / 1000)}s)`);
}

/** Shutdown hook for graceful PM2 reload. */
export function stopAutoRouteWorker(): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
		console.log('[inbox-auto-route] worker stopped');
	}
}

function safeGetConfig(getConfig: () => InboxAutoRouteConfig): InboxAutoRouteConfig | null {
	try {
		return getConfig();
	} catch (err) {
		console.warn(`[inbox-auto-route] failed to load config: ${(err as Error).message}`);
		return null;
	}
}
