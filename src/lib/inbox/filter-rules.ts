/**
 * Layer 2 filter — pure rule matcher.
 *
 * Stateless functions that take a message + (optionally) raw RFC822 headers
 * and return a classification, OR null if no rule matched. The classifier
 * orchestrates I/O (DB reads, IMAP refetch, LLM call); this module owns
 * the deterministic decision logic.
 *
 * The rules themselves live in the `filter_rules` SQL table — see
 * migration #6 in db.ts for the schema + seeded defaults. Adding a new
 * rule type means extending both this matcher AND the table's match_type
 * CHECK constraint.
 *
 * See ADR 2026-05-11-inbox-processing-filter-layer §D2 + §D4.
 */

import { createHash } from 'node:crypto';
import type {
	FilterCategory,
	FilterRule,
	HeaderSignals,
} from './types.js';

// ── Header parsing ──

/**
 * Parse an RFC822 header block into the subset of fields that drive
 * Layer 2 rules. Handles header folding (continuation lines start with
 * whitespace) and case-insensitive lookup.
 *
 * Persisted onto messages.header_signals as JSON so subsequent rule
 * evaluation (e.g. after a correction) doesn't need to re-fetch.
 */
export function parseHeaderSignals(rawHeaders: string): HeaderSignals {
	const headers = unfoldHeaders(rawHeaders);
	const listUnsubscribePresent = 'list-unsubscribe' in headers;
	const listIdValue = headers['list-id'];
	const precedence = headers['precedence']?.toLowerCase().trim();
	const autoSubmitted = headers['auto-submitted']?.toLowerCase().trim();

	const authResults = headers['authentication-results']?.toLowerCase() ?? '';
	const dmarcPass = /\bdmarc=pass\b/.test(authResults);

	return {
		listUnsubscribe: listUnsubscribePresent || undefined,
		listId: listIdValue,
		precedence,
		autoSubmitted,
		dmarcPass: dmarcPass || undefined,
	};
}

function unfoldHeaders(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = raw.split(/\r?\n/);
	let name: string | null = null;
	let value = '';

	const flush = () => {
		if (name) out[name] = value.trim();
		name = null;
		value = '';
	};

	for (const line of lines) {
		if (line === '') {
			// Blank line — end of headers. Flush + stop.
			flush();
			return out;
		}
		if (/^[ \t]/.test(line)) {
			// Folded continuation.
			if (name) value += ' ' + line.trim();
			continue;
		}
		// New header.
		flush();
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		name = line.slice(0, idx).toLowerCase().trim();
		value = line.slice(idx + 1);
	}
	flush();
	return out;
}

// ── Rule matching ──

interface RuleContext {
	fromAddress: string;
	subject: string;
	signals: HeaderSignals;
	rawHeaders: string;
}

/**
 * Match a single rule against a message context. Pure — no I/O.
 *
 * Match types:
 *   - header_present: match_value = header name; matches if present in raw headers
 *   - header_value:   match_value = "HeaderName:value"; matches if header present + equals value
 *   - sender_domain:  match_value = "example.com"; matches if from-domain == or endsWith ".example.com"
 *   - sender_pattern: match_value = glob (e.g. "noreply@*"); matches against fromAddress
 *   - subject_pattern: match_value = glob; matches against subject
 *
 * Glob semantics: `*` = `.*`, `?` = `.`, anchored. Case-insensitive.
 */
export function matchRule(rule: FilterRule, ctx: RuleContext): boolean {
	const mv = rule.matchValue;

	switch (rule.matchType) {
		case 'header_present': {
			const name = mv.toLowerCase().trim();
			if (name === 'list-unsubscribe') return ctx.signals.listUnsubscribe === true;
			if (name === 'list-id') return !!ctx.signals.listId;
			if (name === 'precedence') return !!ctx.signals.precedence;
			if (name === 'auto-submitted') return !!ctx.signals.autoSubmitted;
			// Fallback for arbitrary header names — scan raw headers.
			if (!ctx.rawHeaders) return false;
			const re = new RegExp(`^${escapeRegex(name)}\\s*:`, 'im');
			return re.test(ctx.rawHeaders);
		}
		case 'header_value': {
			const colon = mv.indexOf(':');
			if (colon < 0) return false;
			const headerName = mv.slice(0, colon).toLowerCase().trim();
			const want = mv.slice(colon + 1).toLowerCase().trim();
			if (headerName === 'precedence') return ctx.signals.precedence === want;
			if (headerName === 'auto-submitted') return ctx.signals.autoSubmitted === want;
			if (!ctx.rawHeaders) return false;
			const re = new RegExp(
				`^${escapeRegex(headerName)}\\s*:\\s*${escapeRegex(want)}\\b`,
				'im',
			);
			return re.test(ctx.rawHeaders);
		}
		case 'sender_domain': {
			const domain = mv.toLowerCase().trim();
			const at = ctx.fromAddress.toLowerCase().lastIndexOf('@');
			if (at < 0) return false;
			const senderDomain = ctx.fromAddress.slice(at + 1).toLowerCase();
			return senderDomain === domain || senderDomain.endsWith('.' + domain);
		}
		case 'sender_pattern': {
			return globToRegex(mv).test(ctx.fromAddress.toLowerCase());
		}
		case 'subject_pattern': {
			return globToRegex(mv).test(ctx.subject.toLowerCase());
		}
		default:
			return false;
	}
}

/**
 * Walk the rule list (already sorted by precedence ASC, created_at ASC by
 * `listFilterRules`) and return the first match. Returns null when no rule
 * fires — the caller hands off to the LLM batch.
 */
export function classifyByRules(
	rules: FilterRule[],
	message: { fromAddress: string; subject: string },
	rawHeaders: string | null,
): {
	category: FilterCategory;
	reason: string;
	ruleId: number;
	signals: HeaderSignals;
} | null {
	const signals = rawHeaders ? parseHeaderSignals(rawHeaders) : {};
	const ctx: RuleContext = {
		fromAddress: message.fromAddress,
		subject: message.subject,
		signals,
		rawHeaders: rawHeaders ?? '',
	};
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (matchRule(rule, ctx)) {
			return {
				category: rule.actionCategory,
				reason: `rule:${rule.matchType}:${rule.matchValue}`,
				ruleId: rule.id,
				signals,
			};
		}
	}
	return null;
}

// ── Cache signature (used by both filter + correction loop) ──

/**
 * Compute the cache signature for a message — sha1(lowercase sender |
 * first 4 normalized subject tokens). Normalization strips digits,
 * punctuation, and non-Latin characters so transactional sender mail
 * with a per-message identifier ("Transaction 5419" / "Transaction 7281")
 * collapses to the same signature.
 *
 * Known limitation: subjects in non-Latin scripts (Arabic, CJK) reduce
 * to empty after `[^a-z\s]` strip → signature = sha1(from + "|"). All
 * empty-subject mail from same sender also collides. Acceptable for v1.
 *
 * See ADR §D4.
 */
export function cacheSignature(msg: { fromAddress: string; subject: string }): string {
	const normalizedSubject = (msg.subject || '')
		.toLowerCase()
		.replace(/[#@$€£¥₹]/g, ' ')
		.replace(/\d+/g, ' ')
		.replace(/[^a-z\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4)
		.join(' ');
	const from = (msg.fromAddress || '').toLowerCase();
	return createHash('sha1').update(from + '|' + normalizedSubject).digest('hex');
}

// ── Internal helpers ──

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob: string): RegExp {
	const escaped = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const re = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp('^' + re + '$');
}
