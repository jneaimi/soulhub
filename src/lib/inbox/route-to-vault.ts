/**
 * Layer 3 Stage 4 — `inbox-route-to-vault` (ADR 2026-05-11-inbox-agent-workflows-layer-3 §D5).
 *
 * Takes a queued inbox message and persists it to the vault as a markdown
 * note. Composes the note body from the cached `extracted_data` plus a
 * short body excerpt, picks tags per-category, calls `dispatchVaultSave`,
 * and on success marks the message processed.
 *
 * Worker-driven only in v1 — the periodic auto-route worker
 * (`auto-route.ts`) invokes this against rows that match the operator's
 * per-category rules. NOT exposed to the orchestrator-v2 chat surface
 * because:
 *   (a) manual "save this email" already works via vaultSearch +
 *       vaultSave composition, and
 *   (b) S4's auto-route is the only Layer 3 surface that auto-acts; it
 *       deserves the operator-toggle gate from settings.json, not an
 *       LLM-pickable tool that could fire ungated.
 *
 * Audit: every invocation writes an `agent_actions` row (Guardrail 2)
 * with `result.vaultPath` so the operator can answer "what vault note
 * did the agent create from msg N?" without a vault lookup.
 */

import type { InboxMessage } from './types.js';
import type { TransactionalExtract } from './extractor.js';
import { getMessage, markMessageProcessed, recordAgentAction } from './db.js';
import { getExtractedData } from './db.js';
import { dispatchVaultSave } from '../vault-save/index.js';
import { getVaultEngine } from '../vault/index.js';

/** Shipping subject/sender heuristic — shared between `pickZone` (where to
 *  write) and `composeNote` (what to title). Conservative keyword list; the
 *  cost of mis-labeling a service-alert as shipping is bigger than missing
 *  some shipping notes. Exported so the worker's evaluator can re-use the
 *  same definition without drift. */
export const SHIPPING_PATTERN = /\b(shipped|shipment|tracking|delivery|out for delivery|in transit|arriving|noon|amazon|aramex|dhl|fedex|fetchr)\b/i;
import type { VaultSaveType } from '../vault-save/index.js';

export interface RouteToVaultResult {
	ok: boolean;
	messageId: number;
	vaultPath?: string;
	openUrl?: string;
	noteTitle?: string;
	error?: string;
	/** Why the worker picked this message — e.g. 'transactional.receipt.over-threshold'. */
	reason?: string;
}

export interface RouteToVaultOptions {
	/** Operator who initiated. 'worker' for auto-route; reserve 'operator-direct'
	 *  for a future chat-tool variant. Mirrors the agent_actions schema. */
	actor: 'worker' | 'operator-direct';
	/** Match rule string for audit (e.g. 'receipts.amount>50'). Optional. */
	reason?: string;
	/** Override the zone that `pickZone()` would choose. Used by the
	 *  operator-driven accept/advise path so they can correct an obvious
	 *  mis-zone without editing the file after-the-fact. When omitted,
	 *  `pickZone()` runs as normal. */
	zoneOverride?: string;
	/** Additional tags merged into composeNote's defaults. Used by the
	 *  accept/advise loop so an operator can pin extra tags ("kyc",
	 *  "high-priority") at the moment of routing. */
	extraTags?: string[];
}

/** Route one message to vault. Returns success/failure; never throws.
 *  Caller (auto-route worker) iterates over candidates and aggregates. */
export async function routeMessageToVault(
	messageId: number,
	options: RouteToVaultOptions = { actor: 'worker' },
): Promise<RouteToVaultResult> {
	const message = getMessage(messageId);
	if (!message) {
		const result: RouteToVaultResult = {
			ok: false,
			messageId,
			error: 'message not found',
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	}

	if (message.processStatus === 'processed') {
		// Idempotency — already routed by a prior tick.
		return {
			ok: true,
			messageId,
			reason: 'already-processed',
		};
	}

	const extract = parseExtractedData(message);
	const composed = composeNote(message, extract);
	// Operator overrides — zoneOverride wins outright; extraTags merge into
	// the composer's defaults (de-duped via Set semantics on join).
	const zone = options.zoneOverride ?? pickZone(message, extract);
	if (options.extraTags && options.extraTags.length > 0) {
		const merged = new Set([...composed.tags, ...options.extraTags.map(t => t.toLowerCase().replace(/^#/, '').trim()).filter(Boolean)]);
		composed.tags = [...merged];
	}

	try {
		const saveResult = await dispatchVaultSave({
			title: composed.title,
			content: composed.body,
			type: composed.type,
			tags: composed.tags,
			// Dedicated worker identity — keeps the auto-route 50-200/hr pool
			// separate from `orchestrator-v2-vaultSave` (chat-driven /save).
			// Required so a first-time replay batch doesn't starve chat saves
			// of vault writes during the same window.
			sourceAgent: 'inbox-auto-route',
			// One inbox message = one filename. Without this, 38 Emirates NBD
			// transaction alerts in a day collapse to the same slug and only
			// the first one persists — the rest hammer the worker forever
			// with "File already exists". The msg id keeps each note distinct
			// while leaving the title human-readable.
			filenameSuffix: `msg-${messageId}`,
			// Category-aware zone: receipts/payments to inbox/finance, alerts
			// to inbox/security, shipping to inbox/shipping. Keeps inbox/ root
			// for human captures so the operator can see signal at a glance
			// without 73 transactional rows drowning it out.
			zone,
		});

		if (!saveResult.ok) {
			// Content-dedup is a deliberate-success outcome for L3 S4: when 5
			// look-alike security alerts arrive (same body, different msg ids),
			// we want exactly ONE vault note, and the remaining 4 should be
			// marked processed so the worker doesn't keep re-trying them
			// against the same dedup rejection forever. Treat dedup hits as a
			// soft-success: mark processed, return ok=true with a reason.
			const isDedupHit = saveResult.error.toLowerCase().includes('duplicate content');
			if (isDedupHit) {
				try {
					markMessageProcessed(messageId);
				} catch (err) {
					console.warn(
						`[inbox-route-to-vault] markMessageProcessed(${messageId}) after dedup hit failed: ${(err as Error).message}`,
					);
				}
				const result: RouteToVaultResult = {
					ok: true,
					messageId,
					reason: 'duplicate-content-skipped',
				};
				recordAgentAction({
					tool: 'inbox-route-to-vault',
					messageId,
					actor: options.actor,
					args: { reason: options.reason },
					result,
				});
				return result;
			}
			const result: RouteToVaultResult = {
				ok: false,
				messageId,
				error: `vault save failed: ${saveResult.error}`,
				reason: options.reason,
			};
			recordAgentAction({
				tool: 'inbox-route-to-vault',
				messageId,
				actor: options.actor,
				args: { reason: options.reason },
				result,
			});
			return result;
		}

		// Mark processed only after successful vault save. If this fails,
		// the row stays queued — the next tick will retry. Idempotency
		// above prevents duplicate vault notes (the second pass returns
		// 'already-processed' before reaching the save).
		try {
			markMessageProcessed(messageId);
		} catch (err) {
			console.warn(
				`[inbox-route-to-vault] markMessageProcessed(${messageId}) failed after save: ${(err as Error).message}`,
			);
		}

		// ADR-044 Phase C — append a wikilink to the zone's index.md so
		// the new note doesn't become an orphan. Best-effort: if the
		// zone has no index.md (operator hasn't bootstrapped one) or the
		// update fails for any reason, log + carry on. The vault save
		// itself already succeeded; failing the whole route on an index
		// touch would be a regression.
		const engine = getVaultEngine();
		if (engine) {
			const indexResult = await engine.appendToZoneIndex(
				zone,
				saveResult.path,
				saveResult.title,
			);
			if (!('success' in indexResult) || !indexResult.success) {
				const err = 'error' in indexResult ? indexResult.error : 'unknown';
				// Missing-index is the common silent case (zone hasn't opted
				// in) — don't log noisily for that.
				if (!err.startsWith('Zone index not found:')) {
					console.warn(
						`[inbox-route-to-vault] appendToZoneIndex(${zone}) failed for msg ${messageId}: ${err}`,
					);
				}
			}
		}

		const result: RouteToVaultResult = {
			ok: true,
			messageId,
			vaultPath: saveResult.path,
			openUrl: saveResult.openUrl,
			noteTitle: saveResult.title,
			reason: options.reason,
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	} catch (err) {
		const result: RouteToVaultResult = {
			ok: false,
			messageId,
			error: (err as Error).message,
			reason: options.reason,
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	}
}

interface ComposedNote {
	title: string;
	body: string;
	type: VaultSaveType;
	tags: string[];
}

/** Compose the markdown body per category. Receipt/payment surface the
 *  amount + merchant + ref number in the body; shipping surfaces the
 *  carrier/tracking-adjacent metadata if we have it; service-alerts
 *  surface the from-address as the "issuer". All categories include the
 *  500-char body preview as the source text. */
function composeNote(message: InboxMessage, extract: TransactionalExtract | null): ComposedNote {
	const fromLabel = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
	const subject = message.subject || '(no subject)';
	const receivedIso = new Date(message.dateReceived).toISOString();

	const tags = new Set<string>(['inbox-auto-route']);
	if (message.category) tags.add(message.category);
	if (extract?.kind && extract.kind !== 'unknown') tags.add(extract.kind);
	// Sender-domain tag — `alert@emiratesnbd.com` → `enbd`,
	// `noreply@vercel.com` → `vercel`, etc. Surfaces "all Vercel notifications"
	// or "all ENBD activity" via the vault tag filter without a fragile
	// merchant-slug match (merchant field is empty more often than the domain).
	const domainTag = senderDomainTag(message.fromAddress);
	if (domainTag) tags.add(domainTag);

	// Cross-cut zone tags so the operator can filter by purpose, not just by
	// path. `finance` tag on every money-flow note (receipt/payment/refund/
	// renewal). `security` tag on real security alerts (transactional/alert
	// kind). `service` tag on Vercel/app/marketing notifications routed to
	// the same `security/` zone — same folder, distinct via tag.
	const FINANCE_KINDS = new Set(['receipt', 'payment', 'refund', 'subscription-renewal', 'statement']);
	if (extract && FINANCE_KINDS.has(extract.kind as string)) tags.add('finance');
	if (extract?.kind === 'statement') tags.add('statement');

	let title: string;
	let header: string[];

	if (message.category === 'transactional' && extract?.kind === 'receipt') {
		const merchant = extract.merchant || 'Unknown merchant';
		title = composeMoneyMovementTitle('Receipt', merchant, extract);
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'payment') {
		const merchant = extract.merchant || 'Unknown merchant';
		title = composeMoneyMovementTitle('Payment', merchant, extract);
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'refund') {
		const merchant = extract.merchant || 'Unknown merchant';
		title = composeMoneyMovementTitle('Refund', merchant, extract);
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'subscription-renewal') {
		const merchant = extract.merchant || 'Unknown merchant';
		title = composeMoneyMovementTitle('Renewal', merchant, extract);
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'statement') {
		const merchant = extract.merchant || 'Unknown bank';
		// Surface the subject as the title so the period (e.g. "May 2026")
		// stays human-readable. Frontmatter merchant tag is the durable
		// filter handle.
		title = `Statement — ${merchant}: ${shortenSubject(subject)}`;
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'alert') {
		title = `Security alert — ${shortenSubject(subject)}`;
		header = transactionalHeader(extract, fromLabel, receivedIso);
		tags.add('security');
	} else if (message.category === 'notification') {
		// Split shipping vs service-alert here so the title and tag match the
		// zone the worker writes into (inbox/shipping vs security/).
		// Same heuristic as pickZone() — keep them in sync.
		const looksLikeShipping = SHIPPING_PATTERN.test(message.subject)
			|| SHIPPING_PATTERN.test(message.fromAddress);
		if (looksLikeShipping) {
			title = `Shipping — ${shortenSubject(subject)}`;
			tags.add('shipping');
		} else {
			title = `Service alert — ${shortenSubject(subject)}`;
			// `service` is the cross-cut tag for filtering security/ to
			// non-security-event notifications. `service-alert` is the
			// narrower kind tag. Operator can filter security/ by tag:security
			// (real alerts) vs tag:service (Vercel/app notifs) cleanly.
			tags.add('service-alert');
			tags.add('service');
		}
		header = [
			`**From:** ${fromLabel}`,
			`**Received:** ${receivedIso}`,
			`**Subject:** ${subject}`,
		];
	} else {
		// Fallback — covers any category that slipped past the rule check.
		title = shortenSubject(subject);
		header = [
			`**From:** ${fromLabel}`,
			`**Received:** ${receivedIso}`,
			`**Subject:** ${subject}`,
		];
	}

	const preview = (message.bodyPreview || '').trim();
	const body = [
		...header,
		'',
		'---',
		'',
		'## Body preview',
		'',
		preview || '_(no preview available)_',
		'',
		`_Auto-routed from inbox msg ${message.id} on ${receivedIso}_`,
	].join('\n');

	// 'reference' fits transactional rows (these are records of past events).
	// 'draft' fits notification (more ephemeral). We use 'reference' across
	// the board for v1 — the vault zone is `inbox/` either way, and the
	// `type` only affects validators downstream.
	return {
		title,
		body,
		type: 'reference',
		tags: [...tags],
	};
}

function transactionalHeader(
	extract: TransactionalExtract,
	fromLabel: string,
	receivedIso: string,
): string[] {
	const lines = [`**From:** ${fromLabel}`, `**Received:** ${receivedIso}`];
	if (extract.merchant) lines.push(`**Merchant:** ${extract.merchant}`);
	const amountLabel = formatAmount(extract.amount, extract.currency);
	if (amountLabel) lines.push(`**Amount:** ${amountLabel}`);
	if (extract.cardLast4) lines.push(`**Card:** ••${extract.cardLast4}`);
	if (extract.date) lines.push(`**Date:** ${extract.date}`);
	if (extract.referenceNumber) lines.push(`**Reference:** \`${extract.referenceNumber}\``);
	if (extract.anomalyHint) lines.push(`**Anomaly hint:** yes`);
	return lines;
}

/** Shared title shape for receipts/payments/refunds/renewals. Distinguishes
 *  same-merchant same-amount notes by including the transaction date in the
 *  parens — fixes the 'two Vercel receipts look like duplicates' problem
 *  reported live 2026-05-14. Date falls back gracefully: explicit
 *  `extract.date` first (the bank's own field, usually a YYYY-MM-DD slice),
 *  then nothing (older format) — the trailing `, ` separator means missing
 *  dates produce `Receipt — Vercel Inc. (USD 20.00)` not `(USD 20.00, )`. */
function composeMoneyMovementTitle(
	kind: 'Receipt' | 'Payment' | 'Refund' | 'Renewal',
	merchant: string,
	extract: TransactionalExtract,
): string {
	const amountLabel = formatAmount(extract.amount, extract.currency);
	const dateLabel = extract.date && extract.date.trim() ? extract.date.trim() : null;
	if (amountLabel && dateLabel) {
		return `${kind} — ${merchant} (${amountLabel}, ${dateLabel})`;
	}
	if (amountLabel) {
		return `${kind} — ${merchant} (${amountLabel})`;
	}
	if (dateLabel) {
		return `${kind} — ${merchant} (${dateLabel})`;
	}
	return `${kind} — ${merchant}`;
}

function formatAmount(amount: number | undefined, currency: string | undefined): string | null {
	if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
	const cur = (currency || '').trim().toUpperCase();
	return cur ? `${cur} ${amount.toFixed(2)}` : amount.toFixed(2);
}

function shortenSubject(subject: string): string {
	const trimmed = subject.replace(/\s+/g, ' ').trim();
	return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '…';
}

/** Extract a short sender-domain tag from a from-address. Maps common bank +
 *  vendor domains to canonical short names; falls back to the apex-domain
 *  label for everything else. Returns `null` for unparseable addresses
 *  (don't add a garbage tag).
 *
 *  Examples:
 *    alert@emiratesnbd.com           → 'enbd'
 *    notifications@vercel.com        → 'vercel'
 *    noreply@apple.com               → 'apple'
 *    receipt@example.co.uk           → 'example'
 *    invalid-no-at                   → null
 */
function senderDomainTag(fromAddress: string): string | null {
	if (!fromAddress || !fromAddress.includes('@')) return null;
	const domain = fromAddress.split('@')[1]?.toLowerCase().trim();
	if (!domain) return null;

	// Canonical short names for high-frequency senders. Keep the list short —
	// only add aliases the operator would actually filter by. Generic apex
	// fallback handles the long tail without bloating this map.
	const ALIASES: Record<string, string> = {
		'emiratesnbd.com': 'enbd',
		'mail.emiratesnbd.com': 'enbd',
		'alert.emiratesnbd.com': 'enbd',
		'amazon.com': 'amazon',
		'amazon.ae': 'amazon',
		'noon.com': 'noon',
		'aramex.com': 'aramex',
		'dhl.com': 'dhl',
		'fedex.com': 'fedex',
	};
	if (ALIASES[domain]) return ALIASES[domain];

	// Generic apex extraction — `mail.vercel.com` → `vercel`. Strip common
	// subdomain prefixes, drop the TLD, take the last meaningful label.
	const parts = domain.split('.').filter(Boolean);
	if (parts.length < 2) return null;
	// Drop TLD (last) and any common ccTLD second-level (`co.uk`, `com.au`).
	const TWO_PART_TLDS = new Set(['co.uk', 'com.au', 'co.in', 'com.sg']);
	const lastTwo = parts.slice(-2).join('.');
	const apex = TWO_PART_TLDS.has(lastTwo)
		? parts.at(-3)
		: parts.at(-2);
	if (!apex || apex.length > 20) return null;
	return slugTag(apex);
}

function slugTag(input: string): string {
	return input
		.toLowerCase()
		.normalize('NFKD')
		// Convert common separators (`.`, `_`, `/`) to spaces BEFORE stripping
		// non-alphanumeric chars, so `amazon.ae` slugs as `amazon-ae` instead
		// of `amazonae`, and `noon.com` slugs as `noon-com` instead of `nooncom`.
		// Pre-fix produced label-collapsed slugs that were ugly in the vault
		// tag filter UI; retrieval was unaffected.
		.replace(/[._/]+/g, ' ')
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Category → vault zone. Durable records get their own top-level zones so
 *  they show up as siblings of `inbox/` in the sidebar; ephemeral pools stay
 *  nested under `inbox/`.
 *
 *  - receipts/payments → `finance` (top-level — durable ledger, sidebar zone)
 *  - security alerts   → `security` (top-level — audit trail, sidebar zone)
 *  - shipping          → `inbox/shipping` (ephemeral, nested under inbox)
 *  - service-alerts    → `inbox/service-alerts` (ephemeral, nested under inbox)
 *  - fallback          → `inbox` root — should be rare; means a rule fired
 *    for a category that doesn't have an explicit destination.
 *
 *  When adding a new top-level zone here, update these allowlists in lockstep:
 *    src/lib/vault/graph.ts:148
 *    src/lib/vault/indexer.ts (ORPHAN_EXEMPT)
 *    src/lib/system/healers/vault-healer.ts (VALID_ZONES)
 *    src/lib/system/health.ts (VALID_ZONES, EXEMPT_ZONES)
 *    src/lib/components/vault/VaultSidebar.svelte (zoneOrder, zoneColors)
 *    src/lib/components/vault/VaultSmartViews.svelte (ZONES)
 *    src/lib/components/vault/VaultBulkBar.svelte (zones, zoneColors)
 *  …and create a `CLAUDE.md` under the new zone with allowed types + naming. */
function pickZone(message: InboxMessage, extract: TransactionalExtract | null): string {
	if (message.category === 'transactional' && extract) {
		// Every money-movement kind goes to the finance ledger so the
		// operator's "this month's spend" query sees the whole picture
		// (positive: receipts/payments/renewals; negative: refunds).
		// Statements (eStatement PDFs, monthly summaries) live in finance/
		// too — same zone, distinguished via the `statement` tag.
		const FINANCE_KINDS = new Set(['receipt', 'payment', 'refund', 'subscription-renewal', 'statement']);
		if (FINANCE_KINDS.has(extract.kind as string)) return 'finance';
		if (extract.kind === 'alert') return 'security';
	}
	if (message.category === 'notification') {
		if (SHIPPING_PATTERN.test(message.subject) || SHIPPING_PATTERN.test(message.fromAddress)) {
			return 'inbox/shipping';
		}
		// Service-alerts (Vercel incidents, app installs, marketing-ish notifs)
		// share the `security/` zone with real security alerts. Operator
		// preference: fewer top-level zones, distinguish via TAG instead.
		// Filename composer adds `service-alert` tag in this branch; real
		// security alerts (account-deletion, password-reset) flow from the
		// transactional/alert branch and carry the `security` tag.
		return 'security';
	}
	return 'inbox';
}

function parseExtractedData(message: InboxMessage): TransactionalExtract | null {
	if (!message.extractedData) return null;
	try {
		const parsed = JSON.parse(message.extractedData) as TransactionalExtract;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}
