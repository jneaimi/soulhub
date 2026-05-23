/** Tool selector — given a user message, picks 1–3 vault tools to run.
 *
 *  Two paths:
 *    1. Gemini Flash with a Zod-schema-constrained response via AI SDK v6's
 *       `generateText` + `Output.object({schema})`. The schema is a
 *       discriminated union per tool name, so each variant's arg shape is
 *       enforced — Gemini can't return `byProject` with a `tags` field.
 *       Throws `NoOutputGeneratedError` only when the model can't produce
 *       a valid object at all.
 *    2. Heuristic fallback — runs when Gemini is unavailable, the call
 *       times out, or the structured-output call fails. Always emits at
 *       least a `fulltext` baseline so retrieval isn't empty.
 *
 *  We never let the selector be a hard dependency: a vault chat that
 *  can't reach Gemini still answers, just with simpler retrieval. */

import { generateText, Output, NoOutputGeneratedError } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import type { ToolCall } from './tools.js';
import { TOOL_CATALOG } from './tools.js';

// Migrated to GLM-4.6 via OpenRouter (per ADR-009 direction). Gemini Flash
// kept as the failover at the routes layer; this selector falls back to
// `heuristicSelect` if GLM is unreachable.
const SELECTOR_MODEL = 'z-ai/glm-4.6';
const SELECTOR_TIMEOUT_MS = 8000;

/** Zod schema for the selector's structured output.
 *
 *  Two design choices worth flagging:
 *
 *  1. **No discriminated union on `name`.** Gemini's "controlled generation"
 *     (the mechanism AI SDK v6's `Output.object` plugs into) rejects
 *     Zod-derived `oneOf` schemas with "response did not match schema"
 *     even when the model's output is valid. The enum on `name` still
 *     gives us the most important guarantee — Gemini can't invent a
 *     tool name. Per-tool argument shape coercion happens inside
 *     `runTool()` so a malformed `args` blob still degrades safely
 *     (the tool returns `[]` for a missing required field).
 *
 *  2. **`args` is a flat object with every possible field optional.**
 *     A generic `z.record()` makes Gemini emit `args: {}` for every
 *     call because it has no field hints. Listing the union of
 *     fields-across-tools as optional pulls them into the JSON Schema
 *     so the model knows which keys to populate per tool. The schema
 *     description still tells the model which keys go with which tool. */
const ArgsSchema = z
	.object({
		q: z.string().optional().describe('For "fulltext": focused search query, 2 to 6 keywords distilled from the user message.'),
		limit: z.number().int().min(1).max(20).optional().describe('Max results per tool, default 8.'),
		type: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe('For "byType": note type, e.g. "decision", "learning", "debugging", "pattern", "project", "research", "draft", "recipe".'),
		tags: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe('For "byTag": tag or comma-separated tags. AND logic — every tag must match.'),
		project: z.string().optional().describe('For "byProject": project slug, kebab-case (e.g. "soul-hub-whatsapp").'),
		zone: z.string().optional().describe('For "byZone": top-level vault folder name (e.g. "finance", "operations", "knowledge", "projects", "content", "inbox", "archive", "security"). May include a nested zone path ("projects/signal-forge").'),
		path: z.string().optional().describe('For "backlinks": vault-relative note path (e.g. "projects/soul-hub-whatsapp/index.md").'),
	})
	.describe('Tool arguments. Each tool only reads its own field(s).');

const SelectionSchema = z.object({
	tools: z
		.array(
			z.object({
				name: z
					.enum(['fulltext', 'recent', 'byType', 'byTag', 'byZone', 'byProject', 'backlinks'])
					.describe('Which retrieval tool to run. See the system prompt for what each does.'),
				args: ArgsSchema,
			}),
		)
		.min(1)
		.max(3)
		.describe('1 to 3 tool calls. Always include "fulltext" unless the question is purely structural.'),
});

const SYSTEM_PROMPT = `You are a retrieval planner for the Soul Hub vault — a personal knowledge base indexed by lexical search over note title, path, tags, and body. The user asks a question; you pick which tools to run to gather context that will help answer it. Pick 1 to 3 tools, returned in the structured object response.

Available tools:
${TOOL_CATALOG.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
- **Focus queries — single specific note.** When the user asks about THE LATEST / THE NEWEST / THE LAST / THE MOST RECENT / MY LATEST [singular noun] (e.g. "the latest draft", "my newest decision", "review my most recent post", "analyze the latest writeup"), use ONLY "recent" with limit:1–3. **Do NOT include fulltext** — the natural-language query contains generic keywords ("draft", "post", "note") that match dozens of old notes via MiniSearch and outrank the actual latest one. This is the most common selector mistake; the focus mode in the formatter only gives the top-1 note its full body, so polluting the top-K with high-scoring-but-old fulltext hits silently breaks the response.
- **Overview queries — multiple notes.** Default to including "fulltext" with a focused 2–6 keyword query.
- Prefer "byProject" over "fulltext" when the user names a project explicitly (kebab-case like "soul-hub-whatsapp" or natural-language like "the WhatsApp project").
- **Prefer "byZone" over everything else when the user names a vault zone directly** — "my finance notes", "latest in operations", "what's in finance", "show me content drafts". The eight canonical zones: finance, inbox, knowledge, content, operations, projects, archive, security. Auto-routed notes (payments, statements in finance/) often have empty tags, so byTag misses them — byZone reads the path prefix directly. Combine with "recent" when the user asks for "latest finance notes" — byZone surfaces the candidates, recent ranks by mtime.
- **Signal Forge outputs live in "content" (NOT "projects").** Content menus, miner-daily / miner-weekly briefs, content-prep notes, strategist briefs, the "weekly pipeline" — all live in content/signal-forge/. For queries about these ("content menu", "today's signals", "what should I post", "what's worth writing", "miner brief", "weekly pipeline"), use byZone({zone:'content', limit:10}). Do NOT use byProject({project:'signal-forge'}) — that's reserved for project-tracking notes in projects/ (which signal-forge doesn't have).
- Use "recent" for time-shaped queries. Limits: 1–3 for "the latest" (singular focus); 5–10 for "what's new" (overview).
- Use "byTag" only when the user explicitly names a tag word.
- "backlinks" requires an exact note path — almost never selected on the first turn.
- Keep limits modest (5–10 for overview, 1–3 for focus). The retrieval merger picks top-K across all tools.`;

export interface SelectorOutput {
	tools: ToolCall[];
	source: 'llm' | 'heuristic';
	reason?: string;
}

/** Detect "focus" queries — user wants ONE specific note (the most recent
 *  one), not a list. For these, fulltext on natural-language phrases like
 *  "the latest draft" surfaces dozens of old notes containing those
 *  keywords and outranks the actual latest one in the merger. We strip
 *  fulltext entirely and pin recent to a small limit so the formatter's
 *  focus mode gets the full body of the top result.
 *
 *  Pattern: "the/my/this/that" + "latest/newest/most recent/last" +
 *  singular content noun ("draft", "post", "note", "decision", etc.). */
function isFocusQuery(message: string): boolean {
	const lower = message.toLowerCase();
	return /\b(?:the|my|that|this)\s+(?:latest|newest|most\s+recent|last)\s+(?:draft|post|note|decision|writeup|writup|adr|entry|capture|save|article|reference|learning|debug|debugging|research|recipe|pattern|snippet)\b/.test(
		lower,
	);
}

/** Apply the focus-query override. If the message is a focus query, drop
 *  fulltext and any byType call (they over-recall), force `recent` to be
 *  present with limit:1, and return the cleaned list. Otherwise return
 *  unchanged. Mirrors the selector prompt's "Focus queries" rule but
 *  enforces it deterministically — Gemini Flash's instruction-following
 *  is too unreliable to trust on this. */
function applyFocusOverride(tools: ToolCall[], userMessage: string): ToolCall[] {
	if (!isFocusQuery(userMessage)) return tools;
	const filtered = tools.filter((t) => t.name !== 'fulltext' && t.name !== 'byType');
	const hasRecent = filtered.some((t) => t.name === 'recent');
	if (!hasRecent) {
		filtered.unshift({ name: 'recent', args: { limit: 1 } });
	} else {
		// Pin limit to 1 so the merger doesn't have multiple candidates to
		// rerank — focus mode wants the single most-recently-modified note.
		filtered.forEach((t) => {
			if (t.name === 'recent') t.args = { ...t.args, limit: 1 };
		});
	}
	return filtered;
}

/** Detect queries that target Signal Forge pipeline outputs. These live in
 *  the `content/` zone, NOT `projects/`. The LLM selector routinely
 *  mis-routes them to `byProject({project:'signal-forge'})` which returns
 *  zero — there's no `projects/signal-forge/` zone — and the fulltext
 *  fallback then surfaces stale dates (whichever 'content menu' note has
 *  the highest MiniSearch score, often a months-old report). */
function isSignalForgePipelineQuery(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		/\bcontent[\s-]?menu\b/.test(lower) ||
		/\bminer[\s-](?:daily|weekly|brief)\b/.test(lower) ||
		/\bsignal[\s-]?forge\b/.test(lower) ||
		/\bcontent[\s-]?prep\b/.test(lower) ||
		/\bstrategist[\s-](?:weekly|brief)\b/.test(lower) ||
		/\b(?:today's|this week's|today|current)\s+(?:signals?|content|menu|brief)\b/.test(lower) ||
		/\bweekly\s+pipeline\b/.test(lower) ||
		/\bwhat(?:'s| is)?\s+worth\s+(?:writing|posting|sharing)\b/.test(lower) ||
		/\bsomething\s+(?:to\s+)?(?:write|post|share)\b/.test(lower)
	);
}

/** Apply the signal-forge override. Forces byZone({zone:'content', limit:10})
 *  to be present and strips byProject({project:'signal-forge'}) (which
 *  always returns nothing). Keeps fulltext for topical narrowing. Mirrors
 *  the system-prompt rule but enforces it deterministically — the LLM
 *  selector still hallucinates byProject roughly 60% of the time on these
 *  queries even with the rule. */
function applySignalForgeOverride(tools: ToolCall[], userMessage: string): ToolCall[] {
	if (!isSignalForgePipelineQuery(userMessage)) return tools;
	// Drop the wrong-zone byProject that the LLM keeps picking.
	const filtered = tools.filter(
		(t) => !(t.name === 'byProject' && (t.args as { project?: string })?.project === 'signal-forge'),
	);
	// Ensure byZone({zone:'content', limit:10}) is present at the front so
	// the merger sees the recency-sorted candidates first.
	const hasContentZone = filtered.some(
		(t) => t.name === 'byZone' && (t.args as { zone?: string })?.zone === 'content',
	);
	if (!hasContentZone) {
		filtered.unshift({ name: 'byZone', args: { zone: 'content', limit: 10 } });
	}
	return filtered;
}

/** Heuristic fallback — pattern-matches the message text. Conservative on
 *  purpose: misses are fine, the fulltext call always runs. */
export function heuristicSelect(userMessage: string): SelectorOutput {
	const calls: ToolCall[] = [];
	const lower = userMessage.toLowerCase();

	// Recency markers
	if (/\b(recent|latest|newest|today|this week|yesterday|so far)\b/.test(lower)) {
		calls.push({ name: 'recent', args: { limit: 8 } });
	}

	// Zone markers — direct mentions of canonical top-level folders.
	// Caught before type/project because zones often co-occur with recency
	// markers ("latest finance notes") and byZone is the more specific
	// signal. Word-boundary anchored so "financial" doesn't false-match.
	const zoneMatch = lower.match(
		/\b(finance|operations|knowledge|content|projects|inbox|archive|security)\b/,
	);
	if (zoneMatch) {
		// Skip "inbox" — overwhelmingly refers to email (the WhatsApp inbox
		// tooling), not the vault `inbox/` folder for quick captures. If the
		// user actually wants vault inbox captures they'll be specific.
		if (zoneMatch[1] !== 'inbox') {
			calls.push({ name: 'byZone', args: { zone: zoneMatch[1], limit: 10 } });
		}
	}

	// Type markers
	const typeMatch = lower.match(
		/\b(decisions?|learnings?|debugging|patterns?|adrs?|drafts?|research|recipes?)\b/,
	);
	if (typeMatch) {
		const raw = typeMatch[1];
		const type = raw.startsWith('adr')
			? 'decision'
			: raw.replace(/s$/, ''); // crude singularisation
		calls.push({ name: 'byType', args: { type, limit: 8 } });
	}

	// Project markers — match kebab-case slugs that look like project ids
	const projectMatch = userMessage.match(/\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,4})\b/);
	if (projectMatch) {
		calls.push({ name: 'byProject', args: { project: projectMatch[1], limit: 8 } });
	}

	// Tag markers
	const tagMatch = userMessage.match(/#([a-zA-Z][\w-]+)/);
	if (tagMatch) {
		calls.push({ name: 'byTag', args: { tags: tagMatch[1], limit: 8 } });
	}

	// Fulltext is the baseline — always include it with the user's message
	// (trimmed). MiniSearch handles the rest.
	const q = userMessage.trim().slice(0, 200);
	calls.push({ name: 'fulltext', args: { q, limit: 8 } });

	return { tools: calls, source: 'heuristic' };
}

export async function selectTools(userMessage: string): Promise<SelectorOutput> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) return heuristicSelect(userMessage);

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), SELECTOR_TIMEOUT_MS);

	try {
		const openrouter = createOpenRouter({ apiKey });
		const result = await generateText({
			// ADR-028 Phase 4d — `sort: 'latency'` asks OpenRouter to route the
			// request to whichever upstream provider currently has the lowest
			// measured TTFT for this model. Cuts tail latency when one provider
			// is degraded (200-500ms typical; 2-3s on a bad day). Free win.
			model: openrouter(SELECTOR_MODEL, { provider: { sort: 'latency' } }),
			output: Output.object({ schema: SelectionSchema }),
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: userMessage }],
			maxOutputTokens: 400,
			abortSignal: ctrl.signal,
		});
		clearTimeout(timer);

		// Name is enum-validated by the schema; args is a generic record.
		// `runTool()` performs the per-tool arg shape coercion and falls
		// back to `[]` if a required field is missing — see tools.ts.
		let tools: ToolCall[] = result.output.tools.map((t) => ({
			name: t.name,
			args: t.args,
		}));

		// Focus override — applied BEFORE fulltext auto-fill so we don't
		// re-introduce the very call we just stripped. See applyFocusOverride
		// for the rationale.
		tools = applyFocusOverride(tools, userMessage);

		// Signal-Forge override — corrects the LLM's persistent habit of
		// routing content-menu/miner-brief queries to byProject(signal-forge),
		// which returns nothing because signal-forge lives in `content/`.
		tools = applySignalForgeOverride(tools, userMessage);

		// Default-overview path: guarantee a fulltext baseline so structural-
		// only selections still have topical retrieval. Skipped for focus
		// queries (intentionally — fulltext is what dilutes them).
		if (!isFocusQuery(userMessage) && !tools.some((t) => t.name === 'fulltext')) {
			tools.push({
				name: 'fulltext',
				args: { q: userMessage.trim().slice(0, 200), limit: 6 },
			});
		}

		return { tools, source: 'llm' };
	} catch (err) {
		clearTimeout(timer);
		// Graceful fallback for any failure path: AbortController timeout,
		// NoOutputGeneratedError (model couldn't produce a valid object),
		// network blip. Missing key is handled above.
		const reason =
			err instanceof NoOutputGeneratedError
				? 'selector could not produce a valid object'
				: err instanceof Error
					? `selector failed: ${err.message}`
					: 'selector failed: unknown error';
		const fallback = heuristicSelect(userMessage);
		return {
			...fallback,
			tools: applySignalForgeOverride(applyFocusOverride(fallback.tools, userMessage), userMessage),
			reason,
		};
	}
}
