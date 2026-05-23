/**
 * Public surface for the skills module. Other modules import from here only.
 *
 * Two layers:
 *   1. Install/management (`SkillSummary`, `listSkills`, `installSkill`, …)
 *      — backs the `/skills` page that ships, lists, and removes the
 *      `~/.claude/skills/<name>/` directories.
 *   2. Chat-invokable overlay (ADR-009 §7) — `ChatSkillEntry`,
 *      `listChatSkills`, `runSkill`, … — what the v2 orchestrator's
 *      `invokeSkill` tool reads to decide which skills are visible to
 *      the model and how to invoke them.
 */

export type {
	SkillSummary,
	SkillDetail,
	InstallSource,
	InstallRequest,
	InstallResult,
	SkillOverlay,
	SkillInvocation,
	SkillInvocationKind,
	ChatSkillEntry,
	SkillProvenance,
	SkillRunResult,
} from './types.js';
export { listSkills, getSkill, skillsDir, skillExists } from './store.js';
export { installSkill, uninstallSkill, parseRepo } from './installer.js';
export { readSkillBody } from './prompt.js';
export {
	overlayDir,
	readOverlay,
	writeOverlay,
	deleteOverlay,
	listOverlayNames,
} from './overlay.js';
export { compileArgsSchema } from './args-schema.js';
export { listChatSkills, getChatSkill, listChatInvokableNames } from './registry.js';
export { runSkill } from './runners/index.js';
