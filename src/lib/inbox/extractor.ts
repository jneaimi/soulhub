/** Layer 3 Stage 2 — structured extraction for transactional mail.
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D3.
 *
 *  Pulls `{kind, amount, currency, merchant, date, cardLast4,
 *  referenceNumber, anomalyHint, note}` from a queued transactional
 *  message. Lazy by default — only runs when `inbox-extract-data` asks.
 *  Result is cached on the message row so subsequent queries are free.
 *
 *  Privacy: extractor runs on `subject + body_preview` ONLY in v1
 *  (per ADR §Privacy "envelope + preview by default"). Body fetches are
 *  reserved for `inbox-read-body` and are not invoked here.
 *
 *  Failure handling: a non-parseable LLM response, schema validation
 *  failure, or LLM error caches `{kind:'unknown', note:'<reason>'}` so
 *  the calling tool returns cleanly AND a retry loop is structurally
 *  impossible — the next call sees the cached failure and short-circuits.
 *
 *  Pattern mirrors `commitments-extractor.ts`: `generateText` +
 *  `Output.object()` per the feedback_ai_sdk_v6_structured_output rule
 *  (flat enum + `.describe()` per field; no discriminated unions). */

import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

import type { InboxMessage } from './types.js';
import { getAccount } from './db.js';
import { fetchImapBody } from './body.js';

const BODY_FALLBACK_TRUNCATE_CHARS = 4000;

const TRANSACTIONAL_KINDS = [
	'payment',
	'refund',
	'receipt',
	'otp',
	'alert',
	'subscription-renewal',
	'statement',
	'unknown',
] as const;
export type TransactionalKind = (typeof TRANSACTIONAL_KINDS)[number];

export interface TransactionalExtract {
	kind: TransactionalKind;
	amount?: number;
	currency?: string;
	merchant?: string;
	/** ISO date when the transaction occurred (NOT when mail arrived). */
	date?: string;
	cardLast4?: string;
	referenceNumber?: string;
	/** Heuristic anomaly signal — LLM flags unusual / over-threshold language.
	 *  Stage 3's heartbeat anomaly push reads this to decide push-now vs
	 *  daily-batch. */
	anomalyHint?: boolean;
	/** Free-form note when the row doesn't fit the shape (e.g. failure
	 *  reason cached as `{kind:'unknown', note:'<reason>'}`). */
	note?: string;
}

const TransactionalExtractSchema = z.object({
	kind: z
		.enum(TRANSACTIONAL_KINDS)
		.describe(
			'Best-fit category for this transactional mail. "payment" = money left your account. "refund" = money returned. "receipt" = purchase confirmation. "otp" = one-time-password / verification code. "alert" = security or fraud alert. "subscription-renewal" = recurring charge confirmation. "statement" = periodic account statement (eStatement, monthly statement, year-end summary) — typically attached as PDF with no per-transaction body. "unknown" when the shape does not fit.',
		),
	amount: z
		.number()
		.describe(
			'Numeric amount of the transaction (e.g. 45.00). Use 0 if no amount is present (e.g. OTP, security alert without a charge).',
		),
	currency: z
		.string()
		.describe(
			'ISO currency code in upper-case, e.g. "AED", "USD", "EUR". Empty string when no currency is present.',
		),
	merchant: z
		.string()
		.describe(
			'The merchant, sender bank, or service that issued the transaction (e.g. "Carrefour", "Apple", "Emirates NBD"). Empty string when not identifiable.',
		),
	date: z
		.string()
		.describe(
			'ISO 8601 date (YYYY-MM-DD) when the transaction occurred — NOT when the email arrived. Empty string when no transaction date is in the message.',
		),
	cardLast4: z
		.string()
		.describe(
			'Last 4 digits of the card or account, when present. Empty string when not in the message.',
		),
	referenceNumber: z
		.string()
		.describe(
			'Bank reference, order number, OTP code, or invoice ID when present. Empty string otherwise.',
		),
	anomalyHint: z
		.boolean()
		.describe(
			'TRUE only when the message contains explicit unusual-activity language ("unusual sign-in", "exceeded limit", "fraud", "suspicious"). FALSE for routine transactions even if large.',
		),
	note: z
		.string()
		.describe(
			'A short free-form note when the message does not cleanly fit the shape — e.g. "promotional mail mis-classified" or "transaction declined". Empty string when extraction was clean.',
		),
});

const SYSTEM_PROMPT = `You read a single transactional email (subject + content excerpt) and extract a structured JSON record.

Rules:
- Output strictly matches the schema. Use empty strings for missing string fields and 0 for missing amounts — do not invent values.
- Pick exactly one \`kind\`. Use "unknown" when no category fits.
- ISO date format only (YYYY-MM-DD). Parse "12 May 2026", "May 12", "2026-05-12" — but skip ambiguous "5/12" without a year.
- \`anomalyHint\` is strict: set TRUE only when the email itself flags unusual activity ("unusual sign-in", "exceeded", "fraud", "suspicious", "verify it was you"). A large but routine transaction is NOT anomalous.
- The excerpt may be truncated. If a field is genuinely missing, leave it empty — do not guess.`;

export interface ExtractInput {
	subject: string;
	preview: string;
	/** Optional body-fetch fallback — invoked ONLY when the preview pass
	 *  returns `kind='unknown'`. Should resolve to the readable text of
	 *  the full message body, or null if unavailable. Returning null
	 *  causes the extractor to keep the preview-pass result.
	 *
	 *  Per ADR §Privacy: bodies are pulled live, used once, not cached.
	 *  This is the single privacy-sensitive escape hatch — the caller
	 *  owns the policy (e.g. wire it for transactional, skip for other
	 *  categories). */
	fetchBody?: () => Promise<string | null>;
}

export interface ExtractResult {
	ok: boolean;
	extract: TransactionalExtract;
	/** When `ok=false`, the reason is also written into `extract.note`. */
	reason?: string;
	/** TRUE when the preview pass returned `unknown` and the body-fetch
	 *  fallback was invoked. Recorded into agent_actions for cost
	 *  accounting and to measure preview-only ceiling vs body coverage. */
	usedBodyFallback?: boolean;
}

/** Internal: one Gemini pass against a single subject + content excerpt.
 *  Returns a normalised result. Used by `extractTransactional` for both
 *  the preview pass and (optionally) the body-fetch fallback pass. */
async function runExtraction(
	subject: string,
	content: string,
): Promise<{ ok: true; extract: TransactionalExtract } | { ok: false; reason: string }> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) return { ok: false, reason: 'GEMINI_API_KEY not set' };

	if (!subject.trim() && !content.trim()) {
		return { ok: false, reason: 'empty subject and content' };
	}

	const client = createGoogleGenerativeAI({ apiKey });
	const modelId = process.env.INBOX_EXTRACT_MODEL || 'gemini-2.5-flash';

	let raw: z.infer<typeof TransactionalExtractSchema>;
	try {
		const result = await generateText({
			model: client(modelId),
			system: SYSTEM_PROMPT,
			output: Output.object({ schema: TransactionalExtractSchema }),
			prompt: `Subject: ${subject}\n\nContent: ${content}`,
			maxOutputTokens: 400,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		raw = result.output;
	} catch (err) {
		return { ok: false, reason: `extractor LLM error: ${(err as Error).message}` };
	}

	// Normalise the flat-string output into the optional-field
	// TransactionalExtract shape — drop empties so cached JSON stays tight.
	const extract: TransactionalExtract = { kind: raw.kind };
	if (raw.amount > 0) extract.amount = raw.amount;
	if (raw.currency.trim()) extract.currency = raw.currency.trim().toUpperCase();
	if (raw.merchant.trim()) extract.merchant = raw.merchant.trim();
	if (raw.date.trim()) extract.date = raw.date.trim();
	if (raw.cardLast4.trim()) extract.cardLast4 = raw.cardLast4.trim();
	if (raw.referenceNumber.trim()) extract.referenceNumber = raw.referenceNumber.trim();
	if (raw.anomalyHint) extract.anomalyHint = true;
	if (raw.note.trim()) extract.note = raw.note.trim();

	// Deterministic override: "Transaction Alert" / "Purchase Alert" are
	// bank payment-confirmation subject conventions (Emirates NBD style),
	// NOT security alerts. The LLM consistently mis-labels these as
	// `kind='alert'` because the word "alert" is salient. If the message
	// has a card or merchant attached, it's a transaction — route to
	// finance, not security.
	const subjectLc = subject.toLowerCase();
	const looksLikeTxnAlert =
		/\b(transaction|purchase|payment|debit|credit)\s*(alert|notification)\b/.test(subjectLc) ||
		/\balert\b.*\b(card|account|debit|credit)\b/.test(subjectLc);
	const hasFinanceSignals = !!(extract.cardLast4 || extract.merchant || (extract.amount && extract.amount > 0));
	if (extract.kind === 'alert' && looksLikeTxnAlert && hasFinanceSignals) {
		extract.kind = 'payment';
		// Drop anomalyHint — these are routine notifications, not fraud alerts.
		delete extract.anomalyHint;
	}

	// Deterministic override: bank statement subjects (eStatement, monthly
	// statement, account statement) typically have the txn data in an
	// attached PDF — no body, so the LLM returns `kind='unknown'`. Catch
	// the subject pattern + merchant signal explicitly so they route to
	// `finance/` with `statement` tag instead of rotting in the queue.
	const looksLikeStatement =
		/\b(e[- ]?statement|monthly statement|account statement|year[- ]end summary|annual statement)\b/.test(subjectLc);
	if (looksLikeStatement && (extract.merchant || hasFinanceSignals)) {
		extract.kind = 'statement';
	}

	return { ok: true, extract };
}

/** Run the extractor on a single transactional message. Always returns —
 *  failures resolve to `{ok:false, extract:{kind:'unknown',note:<reason>}}`
 *  so the caller can cache the result and short-circuit retries.
 *
 *  Two-stage flow when `input.fetchBody` is provided:
 *    1. Preview pass — subject + 500-char body_preview.
 *    2. If pass 1 returned `kind='unknown'`, invoke `fetchBody()` and
 *       run a second pass against the full body (truncated to 4KB).
 *       Used to recover HTML-template emails whose transactional payload
 *       sits below the preview window (bank statements, invoice mailers).
 *
 *  Persistence is the caller's job — the same function is exercised in
 *  tests/scripts without touching the DB. */
export async function extractTransactional(input: ExtractInput): Promise<ExtractResult> {
	const subject = (input.subject || '').slice(0, 200);
	const preview = (input.preview || '').slice(0, 500);

	const pass1 = await runExtraction(subject, preview);
	if (!pass1.ok) {
		return { ok: false, reason: pass1.reason, extract: { kind: 'unknown', note: pass1.reason } };
	}

	// Preview pass returned a definite category — done.
	if (pass1.extract.kind !== 'unknown' || !input.fetchBody) {
		return { ok: true, extract: pass1.extract };
	}

	// Pass 2 — body-fetch fallback for unknowns.
	let body: string | null;
	try {
		body = await input.fetchBody();
	} catch (err) {
		// Body fetch failed (IMAP down, etc.) — keep pass-1 unknown rather
		// than reporting a different error. The audit row still records
		// that fallback was attempted.
		return { ok: true, extract: pass1.extract, usedBodyFallback: true };
	}

	if (!body || !body.trim()) {
		return { ok: true, extract: pass1.extract, usedBodyFallback: true };
	}

	const truncated = body.slice(0, BODY_FALLBACK_TRUNCATE_CHARS);
	const pass2 = await runExtraction(subject, truncated);
	if (!pass2.ok) {
		// Second-pass LLM error — fall back to pass-1 result so the row
		// gets a `kind='unknown'` cache and doesn't retry on every poll.
		return { ok: true, extract: pass1.extract, usedBodyFallback: true };
	}
	return { ok: true, extract: pass2.extract, usedBodyFallback: true };
}

/** Helper for the orchestrator tool — given an `InboxMessage`, returns
 *  the inputs the extractor needs INCLUDING a wired `fetchBody` callback.
 *  The fallback only fires if the preview pass returns `kind='unknown'`,
 *  so the cost is bounded — most rows extract from preview alone.
 *
 *  Body-fetch errors are caught and logged; the extractor degrades to
 *  the preview-pass result rather than propagating IMAP failures. */
export function inputFromMessage(msg: InboxMessage): ExtractInput {
	return {
		subject: msg.subject,
		preview: msg.bodyPreview,
		fetchBody: async () => {
			const account = getAccount(msg.accountId);
			if (!account) return null;
			try {
				const body = await fetchImapBody(account, msg);
				return body.text ?? null;
			} catch (err) {
				console.warn(
					`[inbox-extract/body-fallback] msg ${msg.id}: ${(err as Error).message}`,
				);
				return null;
			}
		},
	};
}
