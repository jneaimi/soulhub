/**
 * Soul Hub Agents — schema and types.
 *
 *   - `AgentSummarySchema` is the READ shape that `GET /api/agents` serves.
 *   - `AgentDraftSchema` is the WRITE shape validated on POST/PUT.
 *
 * Storage lanes per ADR-001:
 *   - Lane A: `~/.claude/agents/<id>.md`           — Claude Code native, frontmatter + body
 *   - Lane B: `~/.soul-hub/data/agents/<id>.yaml`  — Soul Hub native, full YAML
 *
 * Discriminated union on `backend`:
 *   - `claude-pty`     → Lane A, parallel-safe via existing PTY manager
 *   - `claude-cli-flag` → Lane A, single-call (`claude -p --agent <id>`)
 *   - `ai-sdk`         → Lane B, Vercel AI SDK 6 BYOK (Anthropic/OpenAI/OpenRouter/Google/Mistral)
 */

import { z } from 'zod';

// ─── primitives ────────────────────────────────────────────────────────────

export const BackendKind = z.enum(['claude-pty', 'claude-cli-flag', 'claude-stream-json', 'ai-sdk']);
export type BackendKind = z.infer<typeof BackendKind>;

export const Lane = z.enum(['A', 'B']);
export type Lane = z.infer<typeof Lane>;

export const Provenance = z.enum(['builtin', 'user-created', 'external']);
export type Provenance = z.infer<typeof Provenance>;

/** Health is computed at read time — not stored on disk. */
export const Health = z.enum(['ready', 'unhealthy', 'unknown']);
export type Health = z.infer<typeof Health>;

export const AiSdkProvider = z.enum([
	'anthropic',
	'openai',
	'openrouter',
	'google',
	'mistral',
]);
export type AiSdkProvider = z.infer<typeof AiSdkProvider>;

// ─── shared sub-schemas ────────────────────────────────────────────────────

const BudgetSchema = z
	.object({
		max_usd: z.number().nonnegative().default(0.5),
		max_turns: z.number().int().positive().default(25),
		// 180s default raised from 60s after first real research dispatch hit
		// the wall-clock at 60.1s mid-task. Per-agent overrides (researcher,
		// lighthouse, etc.) bump higher when the workload warrants it.
		timeout_sec: z.number().int().positive().default(180),
		// ADR-006 — optional explicit hard ceilings. When unset, `resolveBudget`
		// derives them as CEILING_MULTIPLIER × the soft caps.
		ceiling_usd: z.number().nonnegative().optional(),
		ceiling_turns: z.number().int().positive().optional(),
	})
	.prefault({});

/** Read-time budget shape — partial because Lane A frontmatter and Lane B
 *  YAML may carry only the fields the user wanted to override. The runtime
 *  `resolveBudget()` falls back to PRODUCTION_DEFAULTS for missing fields. */
const ReadBudgetSchema = z
	.object({
		max_usd: z.number().nonnegative(),
		max_turns: z.number().int().positive(),
		timeout_sec: z.number().int().positive(),
		ceiling_usd: z.number().nonnegative(),
		ceiling_turns: z.number().int().positive(),
	})
	.partial()
	.optional();

// Note: in Zod 4, `.default({})` on objects requires the full output shape.
// `.prefault({})` lets partial inputs flow to inner-field defaults — see the
// `feedback_zod_v4_prefault` memory.

// ─── read shape (what the API serves) ─────────────────────────────────────

export const AgentSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	backend: BackendKind,
	model: z.string().optional(),
	provider: AiSdkProvider.optional(),
	tools: z.array(z.string()),
	skills: z.array(z.string()),
	provenance: Provenance,
	lane: Lane,
	health: Health,
	health_reason: z.string().optional(),
	source_path: z.string(),
	system_prompt: z.string(),
	/** Per WhatsApp ADR-005 — explicit per-agent flag controlling whether
	 *  the orchestrator may dispatch this agent from a chat surface. False
	 *  by default; user opts in via /agents wizard. Replaces the Phase 1
	 *  `tools.includes('Bash')` heuristic. */
	chat_dispatchable: z.boolean().default(false),
	/** ADR-031 — when set, the `claude-pty` dispatcher sends `/goal <condition>`
	 *  into the PTY session BEFORE the task, so the agent self-iterates until
	 *  the condition is met or `budget.timeout_sec` fires. WhatsApp-only-shaped
	 *  in v1 since `claude-cli-flag` and `ai-sdk` backends don't support
	 *  `/goal` today. Leave undefined for one-shot agents (author / scribe /
	 *  artifact-producers). Example: "all tests pass and no type-check errors". */
	goal_condition: z.string().optional(),
	/** Orchestrator opt-in. When true, the `claude-pty` dispatcher does NOT pass
	 *  `--disallowedTools Task,Agent`, so this agent may itself spawn sub-agents
	 *  inside its Claude Code session — parallel fan-out, named agents, mixed
	 *  models. Default false: agents are leaf workers (the policy that prevents
	 *  self-delegation + sidechain work-hiding). Set on orchestrator agents only;
	 *  such agents must summarise sub-agent results into their OWN final response,
	 *  since transcript extraction skips sidechains. */
	allow_subagents: z.boolean().default(false),
	/** Per-agent budget override read from frontmatter (Lane A) or YAML
	 *  (Lane B). Partial — any subset of fields. Missing fields fall through
	 *  to `PRODUCTION_DEFAULTS` in `dispatch/budget.ts` at runtime. */
	budget: ReadBudgetSchema,
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

// ─── write shape (used by POST/PUT, validated server-side) ────────────────

export const IdSlug = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9_-]*$/,
		'lowercase letters, digits, hyphens, or underscores; must start with a letter or digit',
	);

const ClaudePtyDraftSpec = z.object({
	backend: z.literal('claude-pty'),
	// Forward-looking marker — flagged by `claude-pty.ts` until ADR-001's
	// worktree mode lands. Currently the dispatcher always runs in vaultDir.
	worktree_isolated: z.boolean().default(true),
});

const ClaudeCliFlagDraftSpec = z.object({
	backend: z.literal('claude-cli-flag'),
});

const ClaudeStreamJsonDraftSpec = z.object({
	backend: z.literal('claude-stream-json'),
});

const AiSdkDraftSpec = z.object({
	backend: z.literal('ai-sdk'),
	provider: AiSdkProvider,
	model: z.string().min(1),
});

/** Write shape — what the wizard POSTs and what we validate server-side
 *  before persistence. The server computes `lane`, `source_path`, and
 *  `health` at read time, so they're not in the draft. */
export const AgentDraftSchema = z.object({
	id: IdSlug,
	name: z.string().min(1).default(''),
	description: z.string().default(''),
	model: z.string().optional(),
	tools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	budget: BudgetSchema,
	system_prompt: z.string().default(''),
	provenance: Provenance.default('user-created'),
	chat_dispatchable: z.boolean().default(false),
	/** ADR-031 — optional convergence condition for the `/goal` command on
	 *  PTY-backed agents. Empty string or omitted → one-shot dispatch (today's
	 *  behavior). Non-empty string → goal-mode. Only applied on
	 *  `claude-pty` backend; ignored on the other two with a warn log. */
	goal_condition: z.string().optional(),
	spec: z.discriminatedUnion('backend', [
		ClaudePtyDraftSpec,
		ClaudeCliFlagDraftSpec,
		ClaudeStreamJsonDraftSpec,
		AiSdkDraftSpec,
	]),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

/** Map a backend kind to its storage lane per ADR-001. */
export function laneForBackend(backend: BackendKind): Lane {
	return backend === 'ai-sdk' ? 'B' : 'A';
}
