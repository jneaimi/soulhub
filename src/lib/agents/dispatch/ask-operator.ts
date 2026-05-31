/**
 * ADR-026 P2 — pure ask-operator sentinel helper.
 * ADR-019 P1 — transcript-based detection to eliminate tool-use self-trigger.
 *
 * Extracted into its own module so it can be unit-tested without pulling in
 * the PTY manager or any native bindings. `claude-pty.ts` imports from here.
 *
 * An agent signals a question by emitting:
 *   <<<ASK_OPERATOR>>>{"question":"..."}<<<END_ASK_OPERATOR>>>
 *
 * The distinctive delimiters prevent prose that *mentions* the marker from
 * tripping detection. The sentinel is scanned against the ANSI-stripped
 * accumulator so chunk-straddle and cursor moves can't defeat the match.
 *
 * ADR-019 P1 adds `extractAskOperatorFromTranscript` which reads the JSONL
 * transcript and inspects only `content[].text` (assistant prose), ignoring
 * `tool_use` input payloads. This eliminates the self-trigger trap where an
 * agent writes documentation about the protocol (e.g. editing `seed-roster.ts`)
 * and the literal marker in the Edit payload fires the sentinel.
 */

import { readFileSync } from 'node:fs';

/** Regex for the ask-operator sentinel. Capture group 1 = raw JSON object. */
export const ASK_OPERATOR_RE =
	/<<<ASK_OPERATOR>>>\s*(\{[\s\S]*?\})\s*<<<END_ASK_OPERATOR>>>/;

/** Collapse whitespace so a prompt-echo comparison is robust to terminal
 *  line-wrapping (the TUI inserts newlines the source task lacks). */
function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Extract the operator question from the raw agent output.
 *  Returns the `.question` string if the sentinel is present and the JSON
 *  parses cleanly; returns `null` on any mismatch or parse error (never
 *  throws). Call with `stripAnsi(combined)` in the hot loop — the sentinel
 *  is scanned against the stripped accumulator, not per-chunk, so straddle
 *  is handled automatically.
 *
 *  ADR-026 P2 prompt-echo guard: the injected task is echoed back into the
 *  PTY, so a sentinel that lives in the *task instructions* would otherwise
 *  self-trigger (found live 2026-05-26 — a falsifier task containing the
 *  literal marker paused at turn 0). Pass `promptEcho` (the composed task):
 *  if the captured question is contained in it, this is the echo, not the
 *  agent asking, so return `null`. A genuine agent question is never a
 *  substring of its own task. */
export function parseAskOperator(text: string, promptEcho?: string): string | null {
	const m = ASK_OPERATOR_RE.exec(text);
	if (!m) return null;
	try {
		const parsed: unknown = JSON.parse(m[1]);
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'question' in parsed &&
			typeof (parsed as Record<string, unknown>).question === 'string'
		) {
			const question = (parsed as { question: string }).question;
			if (!question.trim()) return null;
			// Prompt-echo guard — ignore the sentinel when it's the echoed task.
			if (promptEcho && normalize(promptEcho).includes(normalize(question))) return null;
			return question;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * ADR-019 P1 — transcript-based ask-operator detection.
 *
 * Scans the JSONL transcript for `assistant` events and checks ONLY
 * `content[].type === 'text'` blocks (operator-facing prose output) for the
 * ASK_OPERATOR sentinel.  `tool_use` input payloads — where the marker can
 * appear literally when an agent writes documentation about the protocol (e.g.
 * editing `seed-roster.ts` that documents the ASK_OPERATOR protocol, triggering
 * the live failure described in ADR-019) — are skipped entirely.
 *
 * Scans newest-first so the most recent ask in the run wins over any stale
 * occurrence earlier in the transcript. Composes `parseAskOperator` for the
 * regex + prompt-echo guard, keeping that function as the canonical primitive.
 *
 * Returns `null` gracefully when: `jsonlPath` is null, the file is unreadable
 * (not yet written, rotated), no JSONL lines match, or the echo guard suppresses
 * all matches.  Never throws.
 *
 * @param jsonlPath   Absolute path to the session JSONL file (from `locateTranscript`).
 *                    Pass `null` when the transcript hasn't appeared yet — returns null.
 * @param taskPayload The composed task string injected into the PTY session; forwarded
 *                    to `parseAskOperator`'s prompt-echo guard.
 */
export function extractAskOperatorFromTranscript(
	jsonlPath: string | null,
	taskPayload?: string,
): string | null {
	if (!jsonlPath) return null;
	let raw: string;
	try {
		raw = readFileSync(jsonlPath, 'utf8');
	} catch {
		return null; // not yet written, inaccessible, or rotated — graceful no-op
	}

	const lines = raw.split('\n');
	// Scan newest-first: the most recent genuine ask wins over any stale
	// occurrence earlier in the run (e.g. a prior ask that was already answered).
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue; // partial / garbled line — skip
		}
		if (
			typeof event !== 'object' ||
			event === null ||
			(event as Record<string, unknown>).type !== 'assistant'
		) {
			continue;
		}

		const message = (event as Record<string, unknown>).message;
		if (!message || typeof message !== 'object') continue;

		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;

		// ── KEY INVARIANT: only inspect `type === 'text'` blocks. ──────────
		// tool_use blocks (type = 'tool_use', input = {new_string: '...'}) are
		// intentional content production — the agent writing a file.  A sentinel
		// inside them is a literal string being written, not Claude asking the
		// operator a question.  Skipping them eliminates the self-trigger trap.
		for (const block of content) {
			if (
				typeof block !== 'object' ||
				block === null ||
				(block as Record<string, unknown>).type !== 'text'
			) {
				continue; // skip tool_use, tool_result, thinking, and unknown block types
			}
			const text = (block as Record<string, unknown>).text;
			if (typeof text !== 'string') continue;
			const q = parseAskOperator(text, taskPayload);
			if (q !== null) return q;
		}
	}
	return null;
}
