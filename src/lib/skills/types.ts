/**
 * Soul Hub skills registry — types.
 *
 * Skills live at `~/.claude/skills/<name>/` with a required `SKILL.md` at the
 * root. The format is owned by Anthropic (see https://code.claude.com/docs/en/skills);
 * this module reads the frontmatter, surfaces it in the UI, and provides a
 * thin install/uninstall layer. We never modify SKILL.md content — installs
 * are atomic copy/clone, uninstalls are atomic remove.
 */

export interface SkillSummary {
	/** Directory name under `~/.claude/skills/` — also the install id. */
	id: string;
	/** Frontmatter `name` (falls back to `id` when missing). */
	name: string;
	/** Frontmatter `description` (single-line). Empty when missing/unparseable. */
	description: string;
	/** Body length in lines (post-frontmatter). Zero when SKILL.md is missing. */
	body_lines: number;
	/** True when `<dir>/scripts/` exists. */
	has_scripts: boolean;
	/** True when `<dir>/references/` exists. */
	has_references: boolean;
	/** True when the dir itself is a symlink — uninstall removes the symlink only. */
	is_symlink: boolean;
	/** When `is_symlink` is true, the resolved target path (best-effort). */
	symlink_target?: string;
	/** Absolute path to `SKILL.md`. */
	source_path: string;
	/** Mtime of SKILL.md (epoch ms) — surfaced in UI as "last modified". */
	modified_at: number;
	/** Frontmatter-level parse error, when present. Skill still listed but flagged. */
	parse_error?: string;
}

export interface SkillDetail extends SkillSummary {
	/** Full SKILL.md body (post-frontmatter). Truncated to 8 KB for the UI. */
	body_preview: string;
	/** True when body was truncated. */
	body_truncated: boolean;
	/** Raw frontmatter object — for advanced/debug surfaces. */
	frontmatter: Record<string, unknown>;
}

export type InstallSource = 'github' | 'anthropic-registry' | 'curated';

export interface InstallRequest {
	source: InstallSource;
	/** `owner/repo` or a full https URL. Required. */
	repo: string;
	/** Optional subpath inside the repo to install from. */
	subpath?: string;
	/** Optional override id. Defaults to subpath basename or repo name. */
	name?: string;
	/** Optional ref/branch/tag (defaults to repo HEAD). */
	ref?: string;
}

export interface InstallResult {
	id: string;
	source_path: string;
	frontmatter: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// ADR-009 §7 — chat-invokable skill overlay layer.
//
// The `Skill*` types above describe the install/management surface of
// `~/.claude/skills/`. The `ChatSkill*` types below describe the orchestrator-
// facing overlay at `~/.soul-hub/data/skills/<name>.yaml` that gates which
// skills the v2 orchestrator can pick via the `invokeSkill` tool.
// ───────────────────────────────────────────────────────────────────────────

export type SkillProvenance = 'user-created' | 'seed-roster' | 'discovered';

export type SkillInvocationKind = 'script' | 'prompt-injection' | 'cli-subsession';

export type SkillInvocation =
	| {
			kind: 'script';
			/** argv[0] + args — passed straight to `child_process.spawn`. The
			 *  user's runtime args (after Zod validation) are appended last. */
			cmd: string[];
			/** Working directory for the subprocess. Defaults to the skill dir. */
			cwd?: string;
			/** Hard timeout in ms; default 30s. */
			timeout_ms?: number;
	  }
	| {
			kind: 'prompt-injection';
			/** Body trimmed to this byte budget before injection. Default 8 KB
			 *  matches `prompt.ts`'s existing per-skill budget. */
			max_bytes?: number;
	  }
	| {
			kind: 'cli-subsession';
			/** Extra args after `claude -p "<rendered prompt>"`. Useful for
			 *  pinning a model or working dir. */
			extra_args?: string[];
			/** Hard timeout in ms; default 120s (subsessions are heavyweight). */
			timeout_ms?: number;
	  };

/** Shape of `~/.soul-hub/data/skills/<name>.yaml`. Mirrors ADR-009 §7. */
export interface SkillOverlay {
	/** Matches the `~/.claude/skills/<name>/` directory name. */
	name: string;
	/** When false, the skill is invisible to the orchestrator. Mirrors the
	 *  agent `chat_dispatchable` flag. */
	chat_invokable: boolean;
	/** Optional UI display name override. */
	display_name?: string;
	/** What the model sees in the `invokeSkill` tool description. */
	chat_description: string;
	invocation: SkillInvocation;
	/** JSON Schema (object) — compiled to Zod by `compileArgsSchema()`. */
	args_schema?: Record<string, unknown>;
	/** Optional examples appended to the tool description for few-shot prompting. */
	examples?: { args: string; description: string }[];
	provenance?: SkillProvenance;
}

/** A merged record produced by `listChatSkills()`: discovered skill (from
 *  `~/.claude/skills/`) + overlay (from Soul Hub data dir). The Zod schema
 *  is built lazily; consumers can call it via `argsValidator`. */
export interface ChatSkillEntry {
	name: string;
	display_name: string;
	chat_description: string;
	invocation: SkillInvocation;
	provenance: SkillProvenance;
	examples: { args: string; description: string }[];
	/** Discovery metadata pulled from SKILL.md frontmatter. Empty when the
	 *  upstream SKILL.md is missing (overlay-only / future skill). */
	discovered_description: string;
	/** Path to the upstream `SKILL.md` (best-effort — undefined when missing). */
	source_path?: string;
	/** Validator function — wraps Zod parse for ergonomic call sites. Returns
	 *  parsed data on success or an Error string on failure. The orchestrator
	 *  passes user-supplied args here before invocation. */
	parseArgs(input: unknown): { ok: true; data: unknown } | { ok: false; error: string };
}

export type SkillRunResult =
	| { ok: true; output: string; durationMs: number }
	| { ok: false; error: string; durationMs: number };
