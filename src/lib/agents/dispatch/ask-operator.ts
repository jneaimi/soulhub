/**
 * ADR-026 P2 — pure ask-operator sentinel helper.
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
 */

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
