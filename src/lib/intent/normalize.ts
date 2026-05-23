/** Per ADR-023 Phase 1 — produce a stable lexical signature from a raw
 *  user message so the offline pattern miner (Phase 1.5, future) can
 *  group equivalent intents.
 *
 *  Design choices:
 *  - Lowercase + strip punctuation: "What's NEW?" and "whats new" map
 *    to the same key.
 *  - Drop tiny stopwords ("a", "the", "is", etc.): "the latest draft"
 *    and "latest draft" collapse.
 *  - Keep the first 6 content tokens: long messages get truncated so
 *    "what's new in my vault about the soul hub project" still groups
 *    with "what's new" — the first few content words carry the intent.
 *  - Pure function, no I/O, no deps. Easy to test, easy to call from
 *    both runtime (per-message log writer) and the offline miner. */

const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'do',
	'does',
	'for',
	'from',
	'have',
	'i',
	'in',
	'is',
	'it',
	'me',
	'my',
	'of',
	'on',
	'or',
	'so',
	'that',
	'the',
	'this',
	'to',
	'was',
	'were',
	'with',
	'you',
	'your',
]);

const MAX_CONTENT_TOKENS = 6;

export function normalizeSignature(message: string): string {
	if (!message) return '';
	const lower = message.toLowerCase();
	// Replace anything that isn't a word character or whitespace with a
	// space — punctuation, emoji, control codes — then collapse runs.
	const cleaned = lower.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
	if (!cleaned) return '';
	const tokens = cleaned.split(' ');
	const content: string[] = [];
	for (const tok of tokens) {
		if (STOPWORDS.has(tok)) continue;
		content.push(tok);
		if (content.length >= MAX_CONTENT_TOKENS) break;
	}
	return content.join(' ');
}
