/**
 * Chat-invokable skill registry — boot-time merge of `~/.claude/skills/`
 * (discovered) with `~/.soul-hub/data/skills/<name>.yaml` (overlay).
 *
 * `listChatSkills()` is what the v2 orchestrator's `invokeSkill` tool reads
 * to build its `skillName` enum + tool description. A skill appears here
 * only when:
 *   1. It has an overlay file at `~/.soul-hub/data/skills/<name>.yaml`, AND
 *   2. The overlay's `chat_invokable` is true.
 *
 * The discovered SKILL.md is consulted for fallback metadata
 * (description / source path) but a chat-invokable skill can exist without
 * a SKILL.md (e.g. a future skill the user is configuring before installing).
 *
 * Distinct from `listSkills()` in `store.ts` — that one returns ALL
 * discovered skills (regardless of chat-invokable status) and is used by
 * the existing `/skills` install/management UI.
 */

import { listSkills as listAllInstalledSkills } from './store.js';
import { listOverlayNames, readOverlay } from './overlay.js';
import { compileArgsSchema } from './args-schema.js';
import type { ChatSkillEntry, SkillOverlay } from './types.js';

/** Build the registry. Cheap (just file IO + Zod construction); the
 *  orchestrator can call this every turn or cache it in a module variable.
 *  Re-run after any overlay edit. */
export function listChatSkills(): ChatSkillEntry[] {
	const discovered = new Map(listAllInstalledSkills().map((s) => [s.id, s]));
	const overlayNames = listOverlayNames();
	const out: ChatSkillEntry[] = [];

	for (const name of overlayNames) {
		const overlay = readOverlay(name);
		if (!overlay) continue;
		if (!overlay.chat_invokable) continue;
		out.push(buildEntry(overlay, discovered.get(name)));
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** Single-skill lookup by name. Skips overlay disabled / missing. */
export function getChatSkill(name: string): ChatSkillEntry | undefined {
	const overlay = readOverlay(name);
	if (!overlay || !overlay.chat_invokable) return undefined;
	const discovered = listAllInstalledSkills().find((s) => s.id === name);
	return buildEntry(overlay, discovered);
}

/** Just the names of chat-invokable skills — used to build the `skillName`
 *  enum without paying the full Zod compile cost. */
export function listChatInvokableNames(): string[] {
	const out: string[] = [];
	for (const name of listOverlayNames()) {
		const overlay = readOverlay(name);
		if (overlay?.chat_invokable) out.push(name);
	}
	return out.sort();
}

function buildEntry(
	overlay: SkillOverlay,
	discovered: { description?: string; source_path?: string } | undefined,
): ChatSkillEntry {
	const argsSchema = overlay.args_schema ? compileArgsSchema(overlay.args_schema) : undefined;
	return {
		name: overlay.name,
		display_name: overlay.display_name?.trim() || overlay.name,
		chat_description: overlay.chat_description.trim(),
		invocation: overlay.invocation,
		provenance: overlay.provenance ?? 'user-created',
		examples: overlay.examples ?? [],
		discovered_description: discovered?.description ?? '',
		source_path: discovered?.source_path,
		parseArgs(input: unknown) {
			if (!argsSchema) return { ok: true, data: input };
			const result = argsSchema.safeParse(input);
			if (result.success) return { ok: true, data: result.data };
			return {
				ok: false,
				error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
			};
		},
	};
}
