/**
 * Skill runner dispatch — picks the right runner based on `invocation.kind`.
 *
 * The orchestrator's `invokeSkill` tool calls `runSkill(name, args)` with the
 * already-parsed args (Zod-validated by the registry's `parseArgs`); this
 * module looks up the registry entry and routes to one of three runners.
 *
 * Returns `SkillRunResult` so the orchestrator can decide what to send back
 * to the user (text from `output`, or a friendly "couldn't run that skill"
 * message from `error`).
 */

import { getChatSkill } from '../registry.js';
import { runScriptSkill } from './script.js';
import { runPromptInjectionSkill } from './prompt-injection.js';
import { runCliSubsessionSkill } from './cli-subsession.js';
import type { SkillRunResult } from '../types.js';

/** Run a chat-invokable skill by name. The skill MUST have an overlay with
 *  `chat_invokable: true`, otherwise we refuse to invoke (security: a
 *  hallucinated skill name shouldn't fall through to the filesystem). */
export async function runSkill(name: string, args: unknown): Promise<SkillRunResult> {
	const startedAt = Date.now();
	const entry = getChatSkill(name);
	if (!entry) {
		return {
			ok: false,
			error: `skill "${name}" is not chat-invokable (no overlay or chat_invokable: false)`,
			durationMs: Date.now() - startedAt,
		};
	}

	const validated = entry.parseArgs(args);
	if (!validated.ok) {
		return {
			ok: false,
			error: `args validation failed: ${validated.error}`,
			durationMs: Date.now() - startedAt,
		};
	}

	const inv = entry.invocation;
	switch (inv.kind) {
		case 'script':
			return runScriptSkill(name, inv, validated.data);
		case 'prompt-injection':
			return runPromptInjectionSkill(name, inv, validated.data);
		case 'cli-subsession':
			return runCliSubsessionSkill(name, inv, validated.data);
		default:
			return {
				ok: false,
				error: `unknown invocation.kind in overlay`,
				durationMs: Date.now() - startedAt,
			};
	}
}
