/**
 * project-phases ADR-008 S3 — pure helpers for the Layer B LLM grader.
 *
 * Lives in a separate file from `llm-grader.ts` so the test runner can
 * import these without pulling in `runClaudeHeadless` (which itself
 * imports from `$lib/config.js` — a SvelteKit alias that raw Node ESM
 * can't resolve; see `feedback_no_raw_node_for_sveltekit_lib_smoke`).
 *
 * All functions here are pure: deterministic, no I/O.
 */

export type LlmClaimClassification = 'verified' | 'inferred' | 'assumed';

export interface LlmClaim {
	text: string;
	classification: LlmClaimClassification;
}

/** Hard cap on transcript text we send to the LLM. */
export const MAX_INPUT_CHARS = 32_000;

export function truncateTranscript(jsonl: string): string {
	const lines = jsonl.split('\n');
	const chunks: string[] = [];
	let totalLen = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		if (totalLen > MAX_INPUT_CHARS) break;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const r = row as Record<string, unknown>;
		if (r.type !== 'assistant') continue;
		const message = r.message as Record<string, unknown> | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) continue;
		const textParts: string[] = [];
		const toolUses: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type === 'text' && typeof b.text === 'string') {
				textParts.push(b.text);
			} else if (b.type === 'tool_use' && typeof b.name === 'string') {
				toolUses.push(b.name);
			}
		}
		if (textParts.length === 0) continue;
		const turnText = textParts.join(' ').slice(0, 1500);
		const tools = toolUses.length > 0 ? ` [tools: ${toolUses.join(', ')}]` : '';
		const chunk = `ASSISTANT${tools}: ${turnText}`;
		totalLen += chunk.length + 5;
		chunks.push(chunk);
	}

	const joined = chunks.join('\n---\n');
	if (joined.length <= MAX_INPUT_CHARS) return joined;
	const half = Math.floor(MAX_INPUT_CHARS / 2);
	return (
		joined.slice(0, half) +
		`\n---\n[TRUNCATED ${joined.length - MAX_INPUT_CHARS} chars]\n---\n` +
		joined.slice(joined.length - half)
	);
}

export function computeLlmScore(claims: LlmClaim[]): number {
	if (claims.length === 0) return 0;
	let weight = 0;
	for (const c of claims) {
		if (c.classification === 'assumed') weight += 1.0;
		else if (c.classification === 'inferred') weight += 0.3;
	}
	const max = claims.length;
	return Math.min(100, Math.round((weight / max) * 100));
}

export function extractJson(raw: string): string | null {
	let text = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
	text = text.slice(firstBrace, lastBrace + 1);
	return text;
}
