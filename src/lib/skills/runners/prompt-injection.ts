/**
 * `invocation.kind === 'prompt-injection'` runner — read SKILL.md body,
 * concatenate it with any user-supplied args, and return as the runner
 * output. The orchestrator's `invokeSkill` tool handler then prepends
 * this to the system prompt for the next agent step (or returns it as
 * the final assistant turn for skills that are pure text helpers — `arabic`,
 * `think`, `prebuild`, `draft`).
 *
 * Reuses the existing `readSkillBody()` helper so the byte budget +
 * truncation behaviour matches Lane B agent dispatch.
 */

import { readSkillBody } from '../prompt.js';
import type { SkillInvocation, SkillRunResult } from '../types.js';

const DEFAULT_MAX_BYTES = 8 * 1024;

export async function runPromptInjectionSkill(
	skillName: string,
	invocation: Extract<SkillInvocation, { kind: 'prompt-injection' }>,
	args: unknown,
): Promise<SkillRunResult> {
	const startedAt = Date.now();
	const body = readSkillBody(skillName);
	if (body.missing) {
		return {
			ok: false,
			error: `SKILL.md not found for "${skillName}"`,
			durationMs: Date.now() - startedAt,
		};
	}
	const cap = invocation.max_bytes ?? DEFAULT_MAX_BYTES;
	const trimmed =
		Buffer.byteLength(body.body, 'utf8') > cap
			? body.body.slice(0, cap) + '\n\n…[truncated]'
			: body.body;
	const argsLine = formatArgs(args);
	const output = argsLine ? `${trimmed}\n\n## Invocation args\n${argsLine}` : trimmed;
	return { ok: true, output, durationMs: Date.now() - startedAt };
}

function formatArgs(args: unknown): string {
	if (args === undefined || args === null) return '';
	if (typeof args === 'string') return args.trim() ? args.trim() : '';
	try {
		const json = JSON.stringify(args, null, 2);
		return json === '{}' || json === '[]' ? '' : json;
	} catch {
		return String(args);
	}
}
