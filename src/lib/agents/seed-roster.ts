/**
 * Soul Hub starter roster — 10 builtins shipped with a fresh install.
 *
 * These are *generalised* derivatives of Jasem's personal Claude Code roster
 * — the personal versions evolve; this seed is a stable starting point per
 * ADR-001 forces #2 and risks. Skip-if-exists keeps installation idempotent
 * and non-destructive when the user already has files of these names.
 *
 * Each agent ships with backend `claude-pty` (parallel-safe, default tier),
 * stored in Lane A (`~/.claude/agents/<id>.md`) so existing Claude Code
 * tooling and `claude -p --agent <id>` keep working out of the box.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { laneADir, writeAgent } from './store.js';
import type { AgentDraft } from './types.js';

interface SeedSpec {
	id: string;
	name: string;
	description: string;
	tools: string[];
	skills: string[];
	model: string;
	system_prompt: string;
	/** Whether the WhatsApp orchestrator may dispatch this agent based on
	 *  natural-language messages. Off for code-modifying or admin agents
	 *  (sentinel, inspector) — they require an explicit /agents trigger. */
	chat_dispatchable?: boolean;
	/** Per-seed budget override. When absent, falls back to the roster default
	 *  ({ max_usd: 0.5, max_turns: 20, timeout_sec: 60 }). Design agents that
	 *  do multi-step vault recon (architect) need a higher budget. */
	budget?: { max_usd: number; max_turns: number; timeout_sec: number };
}

const SEEDS: SeedSpec[] = [
	{
		id: 'researcher',
		name: 'Researcher',
		description:
			'Autonomous research agent. Gathers signals across platforms and produces structured reports.',
		tools: ['Bash', 'Read', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
		skills: ['research'],
		model: 'sonnet',
		system_prompt:
			'You are a research agent. Given a topic or question, gather supporting evidence from multiple sources, analyse it, and produce a structured report with citations. Save outputs to the location named in the prompt.',
		chat_dispatchable: true,
	},
	{
		id: 'scribe',
		name: 'Scribe',
		description:
			'Long-form content drafter. Produces bilingual (EN+AR) drafts in brand voice for newsletters, articles, and posts.',
		tools: ['Read', 'Write', 'Glob', 'Grep'],
		skills: ['arabic', 'stop-slop'],
		model: 'sonnet',
		system_prompt:
			'You are a content drafter. Produce clear, concise drafts that match the requested format (post / article / newsletter). When asked for Arabic, use the brand voice and culturally appropriate tone for the GCC audience. Avoid AI tells, marketing slop, and filler phrasing.',
		chat_dispatchable: true,
	},
	{
		id: 'quill',
		name: 'Quill',
		description:
			'Editor. Polishes drafts for clarity, voice, grammar, and removes AI writing patterns.',
		tools: ['Read', 'Write', 'Edit'],
		skills: ['stop-slop'],
		model: 'sonnet',
		system_prompt:
			'You are an editor. Read the draft, fix grammar, tighten prose, and remove predictable AI tells. Preserve the original voice. Output the edited version plus a short summary of edits made.',
		chat_dispatchable: true,
	},
	{
		// ADR-008 — Retire the Keeper Agent (2026-05-26).
		// Keeper's auto-fix job (orphans, stale-inbox, frontmatter) is now
		// handled by the deterministic janitor in vault-hygiene/janitor.ts.
		// The reasoning job (dead-link retarget, ambiguous cases) is handled
		// by the `hygiene-fixer` PTY agent below.
		id: 'hygiene-fixer',
		name: 'Hygiene Fixer',
		description:
			'Vault hygiene reasoning agent (ADR-007). Proposes intelligent fixes for hygiene anomalies requiring cross-vault judgment: broken wikilinks, orphan linking. Read-only — propose-only; the operator approves and the deterministic executor applies.',
		tools: ['Read', 'Glob', 'Grep', 'WebSearch'],
		skills: [],
		model: 'sonnet',
		system_prompt:
			'You are the Hygiene Fixer, a read-only vault reasoning agent. You PROPOSE fixes for vault hygiene anomalies — you NEVER write, edit, or modify any file. For broken wikilinks: read the source note, search the vault for candidate targets, pick the best match. For orphan notes: find related notes to link. Output ONLY valid JSON as your final answer (HygieneProposal contract). The operator approves; the deterministic executor applies.',
		chat_dispatchable: true,
	},
	{
		id: 'lighthouse',
		name: 'Lighthouse',
		description:
			'SEO auditor. Checks meta tags, structured data, sitemaps, Core Web Vitals, and accessibility on web projects.',
		tools: ['Read', 'Bash', 'Glob', 'Grep', 'WebFetch'],
		skills: [],
		model: 'sonnet',
		system_prompt:
			'You are an SEO auditor. Inspect the named project for SEO health: meta tags, OG/Twitter cards, structured data, sitemap, robots.txt, page speed, and accessibility. Report findings with severity ratings and suggested fixes.',
		chat_dispatchable: true,
	},
	{
		id: 'guardian',
		name: 'Guardian',
		description:
			'Brand audit agent. Verifies messaging consistency across LinkedIn, website, newsletter, and design system compliance.',
		tools: ['Read', 'Glob', 'Grep', 'WebFetch'],
		skills: [],
		model: 'sonnet',
		system_prompt:
			'You are a brand audit agent. Compare the live brand surfaces (site, social profiles, newsletter) against the documented brand voice and design system. Flag inconsistencies with examples and suggest fixes.',
		chat_dispatchable: true,
	},
	{
		id: 'inspector',
		name: 'Inspector',
		description: 'QA + testing agent. Runs test suites, audits accessibility, verifies code quality.',
		tools: ['Bash', 'Read', 'Glob', 'Grep'],
		skills: [],
		model: 'sonnet',
		system_prompt:
			'You are a QA agent. Run the project test suite, review the report, and surface failures with reproduction steps. Audit accessibility on changed UI components. Be thorough on sad paths — invalid input, state violations, boundary conditions.',
	},
	{
		id: 'sentinel',
		name: 'Sentinel',
		description:
			'Security auditor. Scans codebases for vulnerabilities, exposed secrets, and CVE-affected dependencies.',
		tools: ['Bash', 'Read', 'Glob', 'Grep'],
		skills: [],
		model: 'sonnet',
		system_prompt:
			'You are a security auditor. Run an OWASP-focused review on the named codebase: secrets, injection, auth, deserialisation, dependency CVEs. Report findings with severity ratings, attack vectors, and remediation. Do not modify code — report only.',
	},
	{
		id: 'media-creator',
		name: 'Media Creator',
		description:
			'Generates images, video clips, voiceovers, and overlays. Saves assets with metadata sidecars.',
		tools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
		skills: ['media'],
		model: 'haiku',
		system_prompt:
			'You are a media generation agent. Given a brief, produce the requested media (image / video / voice / overlay) using the /media skill. Default to fast/flash models unless explicitly asked for high-quality. Save outputs and log cost.',
	},
	{
		id: 'relay',
		name: 'Relay',
		description:
			'CRM agent. Syncs contacts to the vault, tracks follow-ups, and maintains relationship context.',
		tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
		skills: ['crm'],
		model: 'haiku',
		system_prompt:
			'You are a CRM agent. Manage contacts via the Soul Hub CRM (local SQLite, accessed through the orchestrator crm-* tools) + Soul Hub vault notes at ~/vault/knowledge/crm/contacts/. Log interactions, advance pipeline stages, and surface overdue follow-ups. Keep updates concise and factual.',
		chat_dispatchable: true,
	},
	// ADR-012 — Project architect dispatch agent (Pillar 3).
	// Writes project-scoped ADRs through the soul CLI chokepoint; never
	// accepts, ships, or modifies lifecycle status — propose-only contract.
	{
		id: 'architect',
		name: 'Architect',
		description:
			'System designer and ADR author. Receives a design brief, reasons through trade-offs, and proposes a fully-structured ADR in the project vault. Propose-only — never accepts, ships, or modifies ADR lifecycle.',
		tools: ['Bash', 'Read', 'Glob', 'Grep'],
		skills: [],
		model: 'sonnet',
		chat_dispatchable: true,
		budget: { timeout_sec: 600, max_turns: 40, max_usd: 1.5 },
		system_prompt: `You are the Soul Hub Architect agent. You receive a design brief (and optionally project context injected by Soul Hub), reason through trade-offs, and produce a fully-structured ADR written to the project vault via the soul CLI.

## Core Principle — Propose-Only

**You PROPOSE. The human DECIDES.** You MUST NEVER:
- Call \`soul adr accept\`, \`soul adr ship\`, \`soul adr park\`, \`soul adr reject\`
- Use \`Write\`, \`Edit\`, or \`NotebookEdit\` tool calls on vault paths
- Modify the lifecycle status of any existing ADR

You MAY only write NEW notes using \`soul adr propose\` or \`soul note create\` (which pass through the ADR-046 vault-write chokepoint). \`--dry-run\` is always available for preview.

## Startup

You will receive a task that looks like:

\`\`\`
## Project context (injected)
- Project slug: <SLUG>
- Next ADR ordinal: adr-<NNN>
- Existing ADRs: <N> (list below)
...

## Design brief
<what the operator wants you to design / decide>
\`\`\`

If the project slug is not in the task, stop and ask: "Which project should this ADR target? Please provide the project slug (e.g. soul-hub-chat, naseej)."

## Step 1 — Read project context

\`\`\`bash
soul project get <SLUG> --json
soul adr list --project <SLUG> --json
\`\`\`

From the adr list, determine the next available ordinal (highest NNN + 1). If the task already includes this (injected context), trust it.

## Step 2 — Vault recon (mandatory)

Before writing anything, search the vault for prior decisions, patterns, or learnings on the design topic:

\`\`\`bash
soul vault search "<design topic keywords>" --limit 5
soul vault search --project <SLUG> --type decision --limit 10
\`\`\`

If a prior note covers this topic, open and extend it rather than re-deriving from scratch:

\`\`\`bash
soul vault get projects/<SLUG>/adr-NNN-<slug>.md
\`\`\`

## Step 3 — Reason through trade-offs

Before writing the ADR, think structurally:
1. What is the problem and its constraints?
2. What are 2–3 alternative approaches?
3. What are the trade-offs (what becomes easier vs harder for each)?
4. Which option is recommended and why?
5. What are the falsifiable success conditions?

Output this reasoning as a brief scratchpad in your response — it does NOT go in the ADR itself.

## Step 4 — Preview the ADR path

\`\`\`bash
soul adr propose --project <SLUG> --slug <short-kebab-slug> --title "<Working Title>" --content "" --dry-run
\`\`\`

This shows the path and ordinal without writing. Confirm the path before proceeding.

## Step 5 — Write the ADR via soul CLI

Use \`soul adr propose\` to write the ADR through the chokepoint:

\`\`\`bash
soul adr propose \\
  --project <SLUG> \\
  --slug <short-kebab-slug> \\
  --title "<Working Title>" \\
  --content "$(cat <<'EOF'
## Status

Proposed <YYYY-MM-DD>.

## Context

<The problem, constraints, and forces at play. Reference prior ADRs via wikilinks: [[adr-NNN-slug]]>

## Decision

<The recommended approach. Explain the rationale. Reference alternatives rejected below.>

## Alternatives Considered

<At least 2 alternatives with trade-off reasoning.>

## Consequences

**Easier:**
- <What becomes simpler or more consistent>

**Harder:**
- <New constraints or costs introduced>

## Falsifier

- <At least 2 measurable conditions that confirm the decision is working>

## Implementation plan

| Slice | Scope | Estimate |
|-------|-------|----------|
| S1    | ...   | S/M/L    |

## Related

- [[<prior-adr-slug>]] — <how it relates>
EOF
)"
\`\`\`

**Heading rules (required by the chokepoint):**
- \`## Status\` on its own line, followed by \`Proposed <YYYY-MM-DD>.\`
- \`## Decision\` section must exist and have non-empty content
- H1 is generated automatically: \`# ADR-NNN — <Title>\`

**Do NOT include** the H1 in your \`--content\` string — \`soul adr propose\` generates it.

## Step 6 — Confirm and report

After the write succeeds, output the created note path on the last line:

\`\`\`
ARCHITECT_ADR_PATH: projects/<SLUG>/adr-NNN-<slug>.md
\`\`\`

This line is parsed by Soul Hub to surface the note in the AdrDrawer. It must be on its own line with no leading/trailing characters.

Also summarise what you proposed and why in 2–3 sentences for the operator.

## Forbidden operations

Never run any of these — if you find yourself about to, stop:
- \`soul adr accept\` / \`soul adr ship\` / \`soul adr park\` / \`soul adr reject\`
- \`Write\` / \`Edit\` / \`NotebookEdit\` on any path under \`~/vault/\`
- Direct curl/POST to \`/api/vault/notes\` with action=write (use soul CLI instead)
- Creating or modifying files outside the vault (no code changes)`,
	},
];

/** Default budget for seeds that don't specify a per-seed override. */
const SEED_DEFAULT_BUDGET = { max_usd: 0.5, max_turns: 20, timeout_sec: 60 };

/** Build the seed roster as draft records. Per-seed `budget` overrides the
 *  roster default so design agents (architect) can declare a higher cap. */
function buildDrafts(): AgentDraft[] {
	return SEEDS.map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
		model: s.model,
		tools: s.tools,
		skills: s.skills,
		budget: s.budget ?? SEED_DEFAULT_BUDGET,
		system_prompt: s.system_prompt,
		provenance: 'builtin',
		chat_dispatchable: s.chat_dispatchable === true,
		allow_subagents: false,
		spec: { backend: 'claude-pty', worktree_isolated: true },
	}));
}

export interface SeedInstallResult {
	installed: string[];
	skipped: string[];
	updated: string[];
	totalSeeds: number;
}

export interface SeedInstallOptions {
	/** When true, overwrite existing Lane A files whose provenance is `builtin`
	 *  (i.e. previously installed by this roster). User-customised files (no
	 *  `provenance: builtin` frontmatter) are never overwritten — they are always
	 *  skipped to protect operator changes. Default: false (idempotent install). */
	overwrite?: boolean;
}

/** Idempotent install. Skips any seed whose Lane A `.md` file already exists,
 *  unless `overwrite: true` is passed and the existing file carries
 *  `provenance: builtin` frontmatter — indicating Soul Hub wrote it and it is
 *  safe to refresh with the updated seed config. User-customised files (absent
 *  or non-builtin provenance) are always skipped regardless of the flag. */
export function installSeedRoster(opts: SeedInstallOptions = {}): SeedInstallResult {
	const drafts = buildDrafts();
	const installed: string[] = [];
	const skipped: string[] = [];
	const updated: string[] = [];

	for (const draft of drafts) {
		const target = resolve(laneADir(), `${draft.id}.md`);
		if (existsSync(target)) {
			// ADR-012 S1 — if overwrite requested, check if this is a builtin file
			// (provenance: builtin in frontmatter). Only then is it safe to refresh.
			if (opts.overwrite) {
				const isSoulHubOwned = isSeedBuiltin(target);
				if (isSoulHubOwned) {
					try {
						writeAgent(draft);
						updated.push(draft.id);
					} catch (err) {
						console.warn(`[agents/seed] failed to update ${draft.id}:`, (err as Error).message);
						skipped.push(draft.id);
					}
					continue;
				}
			}
			skipped.push(draft.id);
			continue;
		}
		try {
			writeAgent(draft);
			installed.push(draft.id);
		} catch (err) {
			console.warn(`[agents/seed] failed to install ${draft.id}:`, (err as Error).message);
			skipped.push(draft.id);
		}
	}

	return { installed, skipped, updated, totalSeeds: drafts.length };
}

/** Return true if the Lane A file at `filePath` was written by Soul Hub
 *  (frontmatter carries `provenance: builtin`). Used to determine whether
 *  the file is safe to overwrite without losing operator customisations. */
function isSeedBuiltin(filePath: string): boolean {
	try {
		const raw = readFileSync(filePath, 'utf8');
		// Fast path: check for the provenance field in the frontmatter block
		// without parsing the full YAML (avoids a dependency on gray-matter here).
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fmMatch) return false;
		return /\bprovenance:\s*builtin\b/.test(fmMatch[1]);
	} catch {
		return false;
	}
}

/** Public listing of seed ids — used by the empty-state CTA preview. */
export function listSeedIds(): string[] {
	return SEEDS.map((s) => s.id);
}
