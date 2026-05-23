/** Personal-queue + stuck-transactional detector for the hygiene report.
 *
 *  Surfaces inbox.db rows that REQUIRE OPERATOR DECISION — the auto-route
 *  worker explicitly defers these (personal mail never auto-routes; unknown
 *  transactional kind has no rule). Without a heartbeat surface they sit in
 *  the queue until the per-account `retention_days` prune sweep (30-90d)
 *  catches them silently, and the operator never gets a chance to act.
 *
 *  Two buckets:
 *    1. PERSONAL — `category='personal' AND queued`. Real human mail
 *       (interview threads, invitations). Surface after 1 day so the
 *       operator can decide save / archive / reply / snooze before it
 *       ages out.
 *    2. STUCK-TRANSACTIONAL — `category='transactional' AND queued AND
 *       extract.kind='unknown'`. The L2 extractor couldn't classify;
 *       could be a one-off bank notice, a refund the system doesn't
 *       recognize, or anything else worth manual triage.
 *
 *  Both surfaces feed the keeper's escalation path — the same code that
 *  pushes vault hygiene issues to Telegram.
 */

import type Database from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';
import type { InboxRouteRecommendation } from './types.js';

export interface InboxDecisionItem {
	messageId: number;
	bucket: 'personal' | 'stuck-transactional';
	fromAddress: string;
	subject: string;
	ageDays: number;
	receivedAt: string;
	suggestedFix: string;
	recommendation?: InboxRouteRecommendation;
}

/** Derive a routing recommendation from subject + sender. Mirrors the
 *  deterministic overrides in `extractor.ts` so the keeper's advice stays
 *  in lockstep with what the worker would do if the extractor classified
 *  the message correctly. Returns null when no pattern fires — the
 *  operator gets a plain "manual triage" instruction. */
function recommendForStuckTransactional(subject: string, fromAddress: string): InboxRouteRecommendation | null {
	const subj = (subject || '').toLowerCase();
	const from = (fromAddress || '').toLowerCase();

	// Bank statement pattern (same as extractor.ts override)
	if (/\b(e[- ]?statement|monthly statement|account statement|year[- ]end summary|annual statement)\b/.test(subj)) {
		const domain = senderDomain(from);
		return {
			suggestedKind: 'statement',
			suggestedZone: 'finance',
			suggestedTags: domain ? ['statement', domain] : ['statement'],
			confidence: 'high',
			reasoning: 'Subject matches bank-statement pattern (eStatement / monthly statement).',
		};
	}

	// Transaction-alert pattern (same as extractor.ts override)
	if (
		/\b(transaction|purchase|payment|debit|credit)\s*(alert|notification)\b/.test(subj) ||
		/\balert\b.*\b(card|account|debit|credit)\b/.test(subj)
	) {
		const domain = senderDomain(from);
		return {
			suggestedKind: 'payment',
			suggestedZone: 'finance',
			suggestedTags: domain ? ['payment', domain] : ['payment'],
			confidence: 'high',
			reasoning: 'Subject matches bank-transaction-alert pattern.',
		};
	}

	// Mail bounce / delivery system
	if (/\b(undelivered|mail.delivery|delivery.failed|returned to sender|bounce)\b/.test(subj)) {
		return {
			suggestedKind: 'unknown',
			suggestedZone: 'inbox',
			suggestedTags: ['mail-bounce', 'system'],
			confidence: 'medium',
			reasoning: 'Mail bounce / delivery-system notice — not a real transaction; usually safe to archive after checking the original recipient.',
		};
	}

	// Document-required / KYC notice
	if (/\b(document required|verification needed|action required|kyc|update.*information)\b/.test(subj)) {
		const domain = senderDomain(from);
		return {
			suggestedKind: 'alert',
			suggestedZone: 'security',
			suggestedTags: domain ? ['security', 'action-required', domain] : ['security', 'action-required'],
			confidence: 'medium',
			reasoning: 'Subject suggests verification or document-request workflow — surface as security alert for operator action.',
		};
	}

	return null;
}

function senderDomain(from: string): string | null {
	if (!from || !from.includes('@')) return null;
	const d = from.split('@')[1]?.toLowerCase().trim().replace(/>$/, '');
	if (!d) return null;
	const ALIASES: Record<string, string> = {
		'emiratesnbd.com': 'enbd', 'mail.emiratesnbd.com': 'enbd', 'alert.emiratesnbd.com': 'enbd',
		'interactivebrokers.com': 'interactive-brokers',
	};
	if (ALIASES[d]) return ALIASES[d];
	const parts = d.split('.').filter(Boolean);
	if (parts.length < 2) return null;
	const apex = parts.at(-2);
	return apex && apex.length <= 20 ? apex : null;
}

const PERSONAL_MIN_AGE_HOURS = 24; // surface after 1 day
const STUCK_TXN_MIN_AGE_HOURS = 72; // give the extractor 3 days before escalating

export function getInboxDecisions(): InboxDecisionItem[] {
	let db: Database.Database;
	try {
		db = getInboxDb();
	} catch {
		// Inbox DB not initialized (e.g., feature disabled) — return empty.
		return [];
	}

	const now = Date.now();
	const personalCutoff = now - PERSONAL_MIN_AGE_HOURS * 3600 * 1000;
	const stuckCutoff = now - STUCK_TXN_MIN_AGE_HOURS * 3600 * 1000;

	const rows = db
		.prepare(
			`SELECT
				id, from_address, subject, date_received, category, extracted_data
			 FROM messages
			 WHERE process_status='queued'
			   AND is_flagged = 0
			   AND (
				 (category='personal' AND date_received < ?)
				 OR (category='transactional' AND date_received < ?
					 AND json_extract(extracted_data, '$.kind') = 'unknown')
			   )
			 ORDER BY date_received ASC
			 LIMIT 50`,
		)
		.all(personalCutoff, stuckCutoff) as Array<{
		id: number;
		from_address: string;
		subject: string | null;
		date_received: number;
		category: string;
		extracted_data: string | null;
	}>;

	return rows.map(r => {
		const ageMs = now - r.date_received;
		const ageDays = Math.max(1, Math.round(ageMs / 86400000));
		const bucket: 'personal' | 'stuck-transactional' =
			r.category === 'personal' ? 'personal' : 'stuck-transactional';
		const recommendation = bucket === 'stuck-transactional'
			? recommendForStuckTransactional(r.subject || '', r.from_address)
			: null;
		return {
			messageId: r.id,
			bucket,
			fromAddress: r.from_address,
			subject: (r.subject || '(no subject)').slice(0, 80),
			ageDays,
			receivedAt: new Date(r.date_received).toISOString(),
			suggestedFix: bucket === 'personal'
				? `Decide: save to vault (projects/<x>/), archive, reply, or snooze. Use inbox-mark-processed when decided.`
				: recommendation
					? `Recommended: route as kind=${recommendation.suggestedKind} → ${recommendation.suggestedZone}/ (${recommendation.confidence} confidence). Reply "yes" to accept, or advise a different routing.`
					: `Manual triage: L2 extractor returned 'unknown' and no recommendation pattern matched. Inspect the body and either correct the classification or mark processed.`,
			...(recommendation ? { recommendation } : {}),
		};
	});
}
