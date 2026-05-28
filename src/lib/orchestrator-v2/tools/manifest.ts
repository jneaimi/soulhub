/**
 * Tools manifest — first-class registry of orchestrator-v2 tools (ADR-015).
 *
 * Tools live as closures inside `buildOrchestratorTools()` for runtime
 * (the AI SDK needs the live `tool()` objects with bound deps). This
 * manifest is the parallel, user-facing description of the same set —
 * what powers `/orchestrator/tools` and `GET /api/orchestrator/tools`.
 *
 * Drift policy: `llm_description` here MUST match the description string
 * passed to the `tool()` call in `index.ts`. `assertManifestParity()`
 * runs on first orchestrator dispatch and warns on mismatch. We accept
 * the duplication for V1 because extracting strings as exported consts
 * fragments the tool definition site (the description sits next to its
 * schema today, which is more readable). If drift becomes a recurring
 * problem, refactor to a shared-const layout.
 */

export type ToolCategory =
	| 'reply'
	| 'read' // webSearch, vaultSearch, youtubeFetch
	| 'write' // generateImage (writes a file), vaultSave (writes a note)
	| 'agent' // dispatchAgent (heavy specialist)
	| 'skill'; // invokeSkill (scoped utility)

/**
 * ADR-014 Tier 1 — logical toolset a tool belongs to.
 *
 * | Toolset       | Default exposure                                        |
 * |---------------|----------------------------------------------------------|
 * | core          | Every turn, every channel                               |
 * | vault         | vault/project scope or vault intent                     |
 * | project-adr   | project scope or project/ADR intent (writes web-only)   |
 * | inbox         | inbox scope or inbox intent                             |
 * | crm           | crm scope or contact intent                             |
 * | external-fetch| URL present in message                                  |
 * | navigation    | web channel only (navigateTo / describeCurrentPage)     |
 * | actions       | matching intent (image / reminder / skill)              |
 *
 * Note: listPages is in the navigation toolset but available on all channels;
 * the gating layer never adds it to WEB_ONLY_TOOLS.
 */
export type ToolsetName =
	| 'core'
	| 'vault'
	| 'project-adr'
	| 'inbox'
	| 'crm'
	| 'external-fetch'
	| 'navigation'
	| 'actions';

export interface ToolConfigPointer {
	/** Settings JSON path the user can edit, e.g. `channels.whatsapp.youtube`. */
	settingsKey: string;
	/** Short label for the UI link, e.g. "WhatsApp → YouTube settings". */
	label: string;
}

export interface ToolExample {
	/** When the user might say something like... */
	user: string;
	/** ...the model picks this tool with these args. */
	toolArgs: string;
}

/** ADR-030 — latency class for the orchestrator-v2 tool catalog.
 *
 *  `fast`  p95 ≤ 5s. Runs synchronously inside the orchestrator turn.
 *          The presence bubble + typing tick keep the chat alive.
 *          Default — `latencyClass` absent === `fast`.
 *  `slow`  p95 > 5s. The tool's execute() short-circuits to background
 *          dispatch (`runSkillInBackground`); the chat bubble gets an
 *          immediate ack and the formatted result lands as an edit when
 *          the background worker completes. Reuses the agent-dispatch
 *          message-id holding pattern. v2 supports WhatsApp + Telegram.
 *  `auto`  Unclassified. Routes inline (same as `fast`) but the rolling
 *          latency buffer surfaces a suggestion on /orchestration/tools
 *          once ≥20 samples land. Operator approves the manifest flip
 *          manually — the auto signal is informational, never applied.
 *          See [[adr-030-fast-vs-slow-skill-dispatch-budget]].
 */
export type LatencyClass = 'fast' | 'slow' | 'auto';

export interface ToolManifest {
	/** Tool name as registered in `buildOrchestratorTools()`. Matches the
	 *  key the AI SDK will report in step.toolCalls. */
	name: string;
	category: ToolCategory;
	/** ADR-014 Tier 1 — logical toolset this tool belongs to. Used by the
	 *  assembly-time gating policy (`selectToolsets` + `applyGatingFilter`)
	 *  to decide which tools to include on each turn. Every tool MUST have
	 *  exactly one toolset; `assertToolsetCoverage()` warns on gaps. */
	toolset: ToolsetName;
	/** What the LLM sees in the tool description. MUST match the string
	 *  passed to `tool({ description, ... })` in index.ts. */
	llm_description: string;
	/** Short, user-facing one-liner for the /orchestrator/tools page list.
	 *  Plain language, no model-prompt-engineering. */
	ui_description: string;
	/** ADR-030 — latency class. Omit for fast tools (the default). Set
	 *  `'slow'` when the tool's p95 exceeds 5s under normal conditions
	 *  (Gemini summary, full transcript, Veo video, etc.) — the
	 *  orchestrator will dispatch it via `runSkillInBackground` instead
	 *  of awaiting inline. */
	latencyClass?: LatencyClass;
	/** Pointer to a settings panel for tools whose behavior the user can
	 *  tune (e.g. youtube cap). Undefined when the tool has no knobs. */
	has_config?: ToolConfigPointer;
	/** Optional usage examples — surfaced in the row's expanded view. */
	examples?: ToolExample[];
}

/** Lookup the static latency class for a tool. Returns `'fast'` by default
 *  (preserving the v1 routing contract — absent === fast). The dispatcher
 *  treats `'auto'` as `'fast'` for routing; the auto state only affects
 *  the UI badge and the suggestion column. */
export function getLatencyClass(toolName: string): LatencyClass {
	const entry = TOOL_MANIFESTS.find((t) => t.name === toolName);
	return entry?.latencyClass ?? 'fast';
}

export const TOOL_MANIFESTS: ToolManifest[] = [
	{
		name: 'reply',
		category: 'reply',
		toolset: 'core',
		llm_description:
			'Reply to the user with a chat message. Use for greetings, conversation, quick known facts, follow-up summaries, or asking a clarification. NOT for unknown facts (use webSearch) or vault lookups (use vaultSearch).',
		ui_description:
			'Send a chat message back. The default conversation tool — picked for greetings, clarifications, and known-fact replies.',
	},
	{
		name: 'webSearch',
		category: 'read',
		toolset: 'core',
		llm_description:
			"Quick Gemini-grounded Google Search for current real-world facts (weather, news, today's score, single lookups). Returns chat-formatted answer with one source URL. When the user names a specific source (e.g. \"Khaleej Times\", \"The National\", \"Reuters\"), shape the query as `site:<domain> <topic>` — e.g. `site:khaleejtimes.com today's UAE headlines` — so grounding pulls from that source instead of a broad mix.",
		ui_description:
			'Quick web search via Gemini-grounded Google Search. Used for current facts (weather, news, scores) with a citation URL.',
		examples: [
			{ user: '"weather in Dubai today"', toolArgs: '{ query: "weather in Dubai today" }' },
			{
				user: '"latest from Khaleej Times"',
				toolArgs: '{ query: "site:khaleejtimes.com latest UAE news" }',
			},
		],
	},
	{
		// ADR-010 S1 — extended with zone/project/type/tag/limit filter params.
		// ADR-013 S3 — trimmed from ~15 lines to ~6; routing discriminators preserved.
		name: 'vaultSearch',
		category: 'read',
		toolset: 'core',
		llm_description:
			'CALL FIRST (ADR-053) for knowledge / entity / continuity questions — "do we have notes on X", "what did we decide about Y", "find research on Z". ' +
			'Searches ~/vault/ (prior research, decisions, CRM, learnings). A hit is CONTEXT to build on, not authoritative for current facts. ' +
			'Filters: zone, project, type, tag, limit. ' +
			'Do NOT use for: current events / news / weather / live scores (→ webSearch). ' +
			'Do NOT use for inbox/email — "what\'s in my inbox", "any new emails", "msg N", bare 4-6 digit id after a digest → `inbox-list-queued` (lists) or `inbox-drill-down` (single id). ' +
			'The vault has an unrelated inbox/ folder for note captures — ignore the name; "inbox" without "note/vault" qualifier = EMAIL.',
		ui_description:
			'Search the Soul Hub vault notes (lexical / MiniSearch). Optional filters: zone, project, type, tag, limit. Used for "do we have notes on..." style questions.',
		examples: [
			{ user: '"what did we save about hydroponics"', toolArgs: '{ query: "hydroponics" }' },
			{ user: '"show me all decisions in soul-hub"', toolArgs: '{ project: "soul-hub", type: "decision" }' },
		],
	},
	{
		name: 'generateImage',
		category: 'write',
		toolset: 'actions',
		latencyClass: 'slow',
		llm_description:
			'Generate a single text-to-image via Gemini Nano Banana. Use ONLY for "make me a picture of X" with NO text overlay, NO video, NO voiceover, NO carousel, NO Arabic text. If the user wants any of those, use dispatchAgent with agentId="media-generator".',
		ui_description:
			'Generate one text-to-image via Gemini Nano Banana. No text overlay, no video, no Arabic text — those go to media-generator agent.',
		has_config: {
			settingsKey: 'channels.whatsapp.img',
			label: 'WhatsApp → Image generation settings',
		},
		examples: [
			{
				user: '"make me a picture of a sunset over Abu Dhabi"',
				toolArgs: '{ prompt: "a sunset over Abu Dhabi" }',
			},
		],
	},
	{
		name: 'dispatchAgent',
		category: 'agent',
		toolset: 'core',
		latencyClass: 'slow',
		llm_description:
			'Dispatch a heavy specialist agent (runs minutes). OMIT confirmed (or set false) to PROPOSE the dispatch — the user replies "yes" to run it. Set confirmed=true ONLY when the user explicitly confirmed a prior proposal OR used an unambiguous command verb ("research X for me", "draft Y about Z", "review this code", "audit Q").',
		ui_description:
			'Dispatch a specialist agent (researcher, media-creator, etc.) — runs for minutes. Confirms with the user before firing unless the verb is unambiguous ("research X", "draft Y").',
	},
	{
		name: 'youtubeFetch',
		category: 'read',
		toolset: 'external-fetch',
		latencyClass: 'slow',
		llm_description:
			'Fetch a YouTube video — title, channel, duration, thumbnail, and (when needed) transcript or summary. ' +
			'Use whenever the user shares a YouTube URL (youtube.com, youtu.be, share.google/...) — ' +
			'whether they want to save it, review it, summarize it, quote it, or ask a question about its content. ' +
			'Modes: "metadata" = title/channel/thumbnail only (instant, free, for save-shaped intents); ' +
			'"summary" = adds a 2-3 paragraph summary via Gemini (~10-25s, costs cents — for review/summarize/quote intents); ' +
			'"transcript" = adds the full transcript text (~25s, costs cents — for "what does he say about X" intents); ' +
			'"full" = metadata + summary + transcript in one call. ' +
			'After the tool returns, compose your reply from the structured fields. ' +
			'If the result has note="transcript-quota-exceeded" or note="gemini-failed", tell the user we have the title and thumbnail but couldn\'t analyze the video this turn.',
		ui_description:
			'Fetch a YouTube video: oEmbed for metadata + Gemini multimodal for transcript/summary. Capped per day to bound cost.',
		has_config: {
			settingsKey: 'channels.whatsapp.youtube',
			label: 'WhatsApp → YouTube fetch settings',
		},
		examples: [
			{ user: '"summarize this video <yt url>"', toolArgs: '{ url: "...", mode: "summary" }' },
			{
				user: '"save this for me <yt url>"',
				toolArgs: '{ url: "...", mode: "metadata" }',
			},
		],
	},
	{
		name: 'tiktokFetch',
		category: 'read',
		toolset: 'external-fetch',
		latencyClass: 'slow',
		llm_description:
			'Fetch a TikTok video — author, caption, engagement, duration, and (when needed) speech transcript or summary. ' +
			'Use whenever the user shares a TikTok URL (tiktok.com, vm.tiktok.com, vt.tiktok.com, tiktok.com/t/...) — ' +
			'whether they want to save it, review it, summarize it, quote it, translate it, or ask a question about its content. ' +
			'Modes: "metadata" = author/caption/engagement only (instant, free, for save-shaped intents); ' +
			'"transcript" = adds the full speech transcript via local whisper.cpp (~7-15s, free — for "what does this say" / quote / search intents); ' +
			'"summary" = adds a 2-3 paragraph summary via Gemini (~12-25s, costs cents — for review/summarize intents); ' +
			'"full" = metadata + transcript + summary in one combined call. ' +
			'CALL ONCE per video — pick the most-informative mode you need on the first call ("full" if uncertain). ' +
			'Do NOT re-call this tool with a different mode for the same URL on failure — escalating modes just punches TikTok\'s anti-bot harder. ' +
			'Successive calls within ~10 minutes are served from cache (note="cache-hit") so they\'re cheap, but still avoid repeating yourself. ' +
			'After the tool returns, compose your reply from the structured fields. ' +
			'If the result has note="summary-quota-exceeded" or note="gemini-failed", tell the user we have the transcript/metadata but couldn\'t summarize this turn. ' +
			'If note="tiktok-rate-limited", TikTok\'s anti-bot is currently blocking us. The result MAY have only the author handle (when caption is empty and durationSec is 0) — in that case say "TikTok is rate-limiting us right now — I can see this is from @<authorHandle> but couldn\'t pull the details. Try sharing the link again in a minute or two." If caption is populated, you have the metadata from a prior attempt — share what you have and tell the user the transcript/summary couldn\'t run this turn. Do NOT immediately re-call the tool. ' +
			'If note="photo-post-no-audio", the URL is a photo carousel with no spoken content — only the caption is meaningful. ' +
			'If note="duration-cap-exceeded", the clip is too long to transcribe; only the caption is available.',
		ui_description:
			'Fetch a TikTok video: yt-dlp metadata + local whisper.cpp transcript + optional Gemini summary. Tool is dropped from the registry on hosts missing yt-dlp/ffmpeg/whisper-cli — install via `npm run setup -- --with-tiktok`.',
		has_config: {
			settingsKey: 'channels.whatsapp.tiktok',
			label: 'WhatsApp → TikTok fetch settings',
		},
		examples: [
			{ user: '"what does this TikTok say <url>"', toolArgs: '{ url: "...", mode: "transcript" }' },
			{
				user: '"save this TikTok <url>"',
				toolArgs: '{ url: "...", mode: "metadata" }',
			},
			{
				user: '"summarize this TikTok <url>"',
				toolArgs: '{ url: "...", mode: "summary" }',
			},
		],
	},
	{
		name: 'fetchPage',
		category: 'read',
		toolset: 'external-fetch',
		llm_description:
			'Fetch the readable text of a web page (curl + Readability). ' +
			'Use `youtubeFetch` for YouTube URLs and `tiktokFetch` for TikTok URLs FIRST — those return richer structured data. ' +
			'Use this for any other URL: blog posts, documentation, Google Docs share links, static transcript pages, news articles, etc. ' +
			'Returns title + extracted plain text (capped at 12k chars). ' +
			'Honest failures via `failureClass`: ' +
			'`js-required` (page is JavaScript-hydrated — tell the user to paste the text), ' +
			'`auth-required` (sign-in needed), `bot-blocked` (Cloudflare/etc), ' +
			'`unsupported-mime` (PDF/image/video — not extractable today), ' +
			'`unsafe-url` (private/internal hosts blocked). ' +
			'Chains naturally into `vaultSave` for saving the extracted text and `crm-attach-note` (when shipped) for linking to a contact.',
		ui_description:
			'Fetch a URL\'s readable text via curl + Readability. Yields to youtubeFetch / tiktokFetch for those domains; surfaces honest failure classes (js-required, auth-required, etc.) for the rest.',
		examples: [
			{
				user: '"summarize https://en.wikipedia.org/wiki/SQLite"',
				toolArgs: '{ url: "https://en.wikipedia.org/wiki/SQLite" }',
			},
			{
				user: '"what does the doc at https://docs.google.com/document/d/X/edit say"',
				toolArgs: '{ url: "https://docs.google.com/document/d/X/edit" }',
			},
		],
	},
	{
		// ADR-010 S4 — extended with optional `zone` param.
		// ADR-013 S3 — trimmed.
		name: 'vaultSave',
		category: 'write',
		toolset: 'vault',
		llm_description:
			"Save composed content to ~/vault/ as a markdown note. " +
			'ONLY when user explicitly asks to save / capture / remember / write down / store. NEVER for discussion-only. ' +
			'Multi-step: call upstream tool first (e.g. youtubeFetch), synthesize, then vaultSave. ' +
			'Optional `zone` (inbox/projects/knowledge/content/operations/archive); omit to auto-classify. Include openUrl in reply.',
		ui_description:
			'Save a composed note to the vault. Optional zone param targets a specific zone (inbox, knowledge, etc.). Triggered only by explicit save phrasings.',
		examples: [
			{
				user: '"save this idea: bilingual newsletter MVP"',
				toolArgs:
					'{ title: "Bilingual newsletter MVP", content: "...", type: "idea", tags: ["mvp"] }',
			},
			{
				user: '"save this to knowledge"',
				toolArgs:
					'{ title: "SQLite WAL mode notes", content: "...", type: "learning", zone: "knowledge" }',
			},
		],
	},
	{
		// ADR-010 S2 — fetch a note by vault-relative path.
		name: 'vaultGet',
		category: 'read',
		toolset: 'vault',
		llm_description:
			'Fetch a single vault note by its exact vault-relative path (e.g. "projects/soul-hub/adr-010-foo.md"). ' +
			'Use when you already know the path from a prior vaultSearch result, projectGet listing, or the user typed it explicitly. ' +
			'PROVENANCE: `path` MUST be a real vault path from a prior tool result or the user\'s own text — NEVER fabricate paths. ' +
			'Do NOT use for broad searches (use vaultSearch instead). Returns the full note body + frontmatter.',
		ui_description:
			'Fetch a single vault note by its vault-relative path. Use after vaultSearch returns a path you need to read in full.',
		examples: [
			{
				user: '"show me the full content of that ADR"',
				toolArgs: '{ path: "projects/soul-hub/adr-010-cli-aligned-vault-project-tool-surface.md" }',
			},
		],
	},
	{
		// ADR-010 S3 — list recently modified vault notes.
		name: 'vaultRecent',
		category: 'read',
		toolset: 'vault',
		llm_description:
			'List the most recently modified vault notes, sorted newest-first. ' +
			'Use for "what did we recently add / update", "what\'s new in the vault", "latest notes" queries. ' +
			'Optional `limit` param (default 10, max 50). ' +
			'Do NOT use for targeted searches — use vaultSearch with a query/filter instead.',
		ui_description:
			'List the most recently modified vault notes. Sorted newest-first. Mirrors `soul vault recent`.',
		examples: [
			{ user: '"what did we recently add to the vault"', toolArgs: '{ limit: 10 }' },
		],
	},
	{
		// ADR-010 S5 — update an existing note's content and/or metadata.
		name: 'vaultNoteUpdate',
		category: 'write',
		toolset: 'vault',
		llm_description:
			'Update an existing vault note\'s content and/or frontmatter metadata. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the edit — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed a prior proposal in this turn. ' +
			'Provide `content` to replace the note body, `metaJson` (JSON string) to patch frontmatter fields, or both. ' +
			'PROVENANCE: `path` MUST be a real vault path from a prior vaultSearch/vaultGet result. NEVER fabricate paths. ' +
			'NEVER use this to update an ADR\'s status frontmatter — use adrAccept/adrShip/adrPark/adrReject for lifecycle transitions. ' +
			'Mirrors `soul note update PATH`.',
		ui_description:
			'Update an existing vault note\'s content and/or frontmatter metadata. Confirmation-gated. Mirrors `soul note update`.',
		examples: [
			{
				user: '"update the hydro note with these new findings"',
				toolArgs: '{ path: "knowledge/hydroponics-notes.md", content: "# Updated content...", confirmed: false }',
			},
		],
	},
	{
		// ADR-010 S6 — move a note to a different zone (web-only, confirmation gate).
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'vaultNoteMove',
		category: 'write',
		toolset: 'vault',
		llm_description:
			'Move a vault note to a different zone and/or rename its filename. WEB CHANNEL ONLY. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the move — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed. ' +
			'Provide `targetZone` to relocate (inbox/projects/knowledge/content/operations/archive) and/or `newFilename` to rename. Must provide at least one. ' +
			'The move is link-safe — inbound wikilinks from other notes are rewritten to the new path. ' +
			'PROVENANCE: `src` MUST be a real vault path from a prior vaultSearch/vaultGet result. NEVER fabricate. ' +
			'Mirrors `soul note move SRC DST-ZONE`.',
		ui_description:
			'Move a vault note to a different zone (link-safe). Web only, confirmation-gated. Mirrors `soul note move`.',
		examples: [
			{
				user: '"move the hydroponics note from inbox to knowledge"',
				toolArgs: '{ src: "inbox/2026-05-01-hydro.md", targetZone: "knowledge", confirmed: false }',
			},
		],
	},
	{
		// ADR-010 S7 — get project summary + ADR list.
		// ADR-013 S1 — routing guard: explicit "Do NOT use" clause against page-description overlap.
		name: 'projectGet',
		category: 'read',
		toolset: 'project-adr',
		llm_description:
			'Get a project\'s summary, ADR list, and status counts by slug. ' +
			'Use for "what\'s the status of project X", "show me soul-hub ADRs", "what\'s open in project Y", "how is the [project] project". ' +
			'Do NOT use for "what page am I on?", "what can I do here?", "describe this screen" — use `describeCurrentPage` for those (page-description questions). ' +
			'PROVENANCE: `slug` MUST be a real project slug from a prior projectList result or the user\'s explicit text. NEVER fabricate. ' +
			'Mirrors `soul project get SLUG`.',
		ui_description:
			'Get a project\'s index + ADR list with status counts. Mirrors `soul project get SLUG`.',
		examples: [
			{ user: '"what are the ADRs in soul-hub"', toolArgs: '{ slug: "soul-hub" }' },
			{ user: '"show me the status of project naseej"', toolArgs: '{ slug: "naseej" }' },
		],
	},
	{
		// ADR-010 S8 — list all active projects.
		// ADR-013 S1 — routing guard: explicit "Do NOT use" for health/page overlap.
		name: 'projectList',
		category: 'read',
		toolset: 'project-adr',
		llm_description:
			'List all active projects (scans projects/*/index.md). Returns project slugs, titles, open ADR counts, and status. ' +
			'Use for "what projects do we have", "list all projects", "show me the project list". ' +
			'Do NOT use for system health / server status / "is everything ok" / "are services up" questions — use `systemHealth` for those. ' +
			'Mirrors `soul project list`.',
		ui_description:
			'List all active projects with open ADR counts. Mirrors `soul project list`.',
		examples: [
			{ user: '"what projects are there"', toolArgs: '{ limit: 20 }' },
		],
	},
	{
		// ADR-010 S9 — ADR lifecycle: proposed → accepted.
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'adrAccept',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Transition an ADR from `proposed` → `accepted`. WEB CHANNEL ONLY — ADR status changes are available in the browser chat only. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the action — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed. ' +
			'PROVENANCE: `path` MUST be a real vault-relative ADR path from a prior vaultSearch/projectGet/vaultGet result. NEVER fabricate paths. ' +
			'Mirrors `soul adr accept PATH`.',
		ui_description:
			'Transition an ADR proposed → accepted. Web only, confirmation-gated. Mirrors `soul adr accept`.',
		examples: [
			{
				user: '"accept the ADR-010 for soul-hub"',
				toolArgs: '{ path: "projects/soul-hub/adr-010-cli-aligned-vault-project-tool-surface.md", confirmed: false }',
			},
		],
	},
	{
		// ADR-010 S9 — ADR lifecycle: accepted → shipped.
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'adrShip',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Transition an ADR from `accepted` → `shipped`. WEB CHANNEL ONLY — ADR status changes are available in the browser chat only. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the action — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed. ' +
			'PROVENANCE: `path` MUST be a real vault-relative ADR path. NEVER fabricate. ' +
			'Mirrors `soul adr ship PATH`.',
		ui_description:
			'Transition an ADR accepted → shipped. Web only, confirmation-gated. Mirrors `soul adr ship`.',
		examples: [
			{
				user: '"mark ADR-010 as shipped"',
				toolArgs: '{ path: "projects/soul-hub/adr-010-cli-aligned-vault-project-tool-surface.md", confirmed: false }',
			},
		],
	},
	{
		// ADR-010 S9 — ADR lifecycle: proposed → parked.
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'adrPark',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Transition an ADR from `proposed` → `parked`. WEB CHANNEL ONLY — ADR status changes are available in the browser chat only. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the action — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed. ' +
			'Mirrors `soul adr park PATH`.',
		ui_description:
			'Transition an ADR proposed → parked. Web only, confirmation-gated. Mirrors `soul adr park`.',
		examples: [
			{
				user: '"park ADR-010 until next month"',
				toolArgs: '{ path: "projects/soul-hub/adr-010-cli-aligned-vault-project-tool-surface.md", reviewAfter: "2026-07-01", confirmed: false }',
			},
		],
	},
	{
		// ADR-010 S9 — ADR lifecycle: proposed → rejected.
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'adrReject',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Transition an ADR from `proposed` → `rejected`. WEB CHANNEL ONLY — ADR status changes are available in the browser chat only. ' +
			'CONFIRMATION GATE: OMIT `confirmed` (or set false) to PROPOSE the action — the user replies "yes" to confirm. Set `confirmed=true` ONLY when the user explicitly confirmed. ' +
			'`reason` is REQUIRED for rejection. ' +
			'Mirrors `soul adr reject PATH`.',
		ui_description:
			'Transition an ADR proposed → rejected (reason required). Web only, confirmation-gated. Mirrors `soul adr reject`.',
		examples: [
			{
				user: '"reject ADR-010, we are going a different direction"',
				toolArgs: '{ path: "projects/soul-hub/adr-010-cli-aligned-vault-project-tool-surface.md", reason: "Superseded by new approach", confirmed: false }',
			},
		],
	},
	{
		name: 'invokeSkill',
		category: 'skill',
		toolset: 'actions',
		llm_description:
			'Invoke a Claude Skill — fast scoped utility (seconds, not minutes). Prefer this over dispatchAgent for narrow tasks. Skills run synchronously and the output is threaded back to you so you can compose the final reply.',
		ui_description:
			'Invoke a chat-enabled skill (research, recipe, arabic, etc.). Synchronous, seconds. Skill list is dynamic — see /orchestration/skills.',
	},
	{
		// ADR-013 S3 — trimmed; routing discriminators preserved.
		name: 'inbox-list-queued',
		category: 'read',
		toolset: 'inbox',
		llm_description:
			"STRICT ROUTING: 'my inbox', 'queued', 'new emails', 'new mail', 'what came in', 'any bank alerts', 'show me receipts' → HERE (EMAIL, NOT vaultSearch). " +
			"Lists queued IMAP-synced messages (post-Layer-2 filter). " +
			"Filter by category: personal / transactional / notification / unclassified. Returns newest first. " +
			"MUST preserve `(msg N)` ids in every row — the user drills down with 'tell me about msg N'.",
		ui_description:
			'List queued inbox messages, optionally filtered by category. The queued stream is what Layer 2 deemed agent-relevant.',
		examples: [
			{ user: '"any new emails today"', toolArgs: '{ since: "today", limit: 10 }' },
			{ user: '"show me my bank alerts"', toolArgs: '{ category: "transactional", limit: 5 }' },
		],
	},
	{
		name: 'inbox-mark-processed',
		category: 'write',
		toolset: 'inbox',
		llm_description:
			"Mark an inbox message as processed (agent has handled it). The message transitions queued → processed; it stays cached for 365 days as audit trail but stops appearing in queued listings. " +
			"Use after summarizing, routing-to-vault, replying, or otherwise handling a message. " +
			"CONFIRMATION GATE (ADR-L3 §D7 Guardrail 1): until the operator has confirmed 50 successful mark-processed calls (audit trail in `agent_actions`), OMIT `confirmed` (or set false) to PROPOSE the action — the user replies 'yes' to confirm. After 50 confirmed calls the gate lifts and the tool executes directly. The operator can also force the gate back on via `INBOX_MARK_PROCESSED_CONFIRM=always`. Set `confirmed=true` ONLY when the user explicitly confirmed a prior proposal in this turn's history OR used an unambiguous command verb ('mark N as done', 'archive N', 'process N'). " +
			"PROVENANCE: `messageId` MUST be a REAL id returned by a prior `inbox-list-queued`, `inbox-read-body`, or `inbox-correct-classification` call in the SAME conversation. NEVER invent ids. If you don't have one from a prior tool result, call `inbox-list-queued` first to discover real ids. The tool returns an ERROR when the id doesn't exist — that error means you hallucinated; do NOT relay a fake 'success' to the user.",
		ui_description:
			'Mark a queued inbox message as processed. Gated by a 50-call confirmation trust-trainer (ADR-L3) — first 50 calls propose, then auto-confirm. Force-on via INBOX_MARK_PROCESSED_CONFIRM=always.',
	},
	{
		name: 'inbox-apply-recommendation',
		category: 'write',
		toolset: 'inbox',
		llm_description:
			"Apply the keeper's recommendation for a stuck-transactional inbox message — operator's accept/advise loop. " +
			"Use when the operator replies 'accept #N' / 'yes route N' / 'archive N' / 'advise: kind=X, zone=Y' after the keeper surfaced an inboxDecisions item with a recommendation. " +
			"Two action modes: 'route' (default) — patches extract.kind, routes to vault (overrideable zone + tags), marks processed. 'archive' — marks processed without saving (for junk/bounces). " +
			"PROVENANCE: `messageId` MUST be a real id from a prior keeper escalation, inboxDecisions report, or `inbox-list-queued` result. NEVER fabricate ids.",
		ui_description:
			"Apply or override the keeper's recommendation for a stuck inbox message — accept the suggested kind/zone/tags, or correct them in-line.",
	},
	{
		name: 'inbox-correct-classification',
		category: 'write',
		toolset: 'inbox',
		llm_description:
			"Correct the Layer 2 classification of a message and update the cache so future similar messages get the new category. " +
			"Use when the user pushes back (\"that's not promotional, it's a receipt\") or when the agent notices a clear miscategorization. " +
			"Scope can be 'this' (this message only) or 'pattern' (this message + all matching siblings via the cache signature).",
		ui_description:
			'Correct a misclassified inbox message and update the cache so future similar messages get the right category.',
	},
	{
		name: 'inbox-read-body',
		category: 'read',
		toolset: 'inbox',
		llm_description:
			"Fetch the full body text of a queued inbox message. " +
			"Use ONLY after inbox-list-queued returned a row whose preview is insufficient to answer the user's question. " +
			"Bodies are fetched live from IMAP each call — not cached server-side. " +
			"Avoid for routine 'what's in my inbox' queries; preview is usually enough. " +
			"Required for 'what did X say', 'what was the amount', 'extract the link from row N'.",
		ui_description:
			'Fetch the full body of a queued inbox message live from IMAP. Used when the preview is not enough to answer a follow-up question.',
		examples: [
			{
				user: '"what did the noon order email actually say"',
				toolArgs: '{ messageId: 32801 }',
			},
		],
	},
	{
		name: 'inbox-extract-data',
		category: 'read',
		toolset: 'inbox',
		llm_description:
			"Extract structured transactional data (kind, amount, currency, merchant, date, cardLast4, referenceNumber, anomalyHint) from a queued message. Returns cached extraction if present; otherwise runs the extractor (subject + 500-char preview) and caches the result. " +
			"Use for 'how much was that charge', 'what merchant', 'is this transaction unusual', 'what was the OTP'. " +
			"Only operates on rows with category='transactional' — non-transactional rows return a note explaining the row's category and skip extraction. " +
			"PROVENANCE: `messageId` MUST be a real id from a prior `inbox-list-queued` / `inbox-read-body` result. NEVER fabricate ids.",
		ui_description:
			'Extract structured transactional data from a queued message (subject + preview only). Results cache on the message row; subsequent calls are free. Layer 3 Stage 2.',
		examples: [
			{
				user: '"how much was that Carrefour charge"',
				toolArgs: '{ messageId: 32801 }',
			},
		],
	},
	{
		// ADR-013 S3 — trimmed; routing discriminators preserved.
		name: 'inbox-drill-down',
		category: 'read',
		toolset: 'inbox',
		llm_description:
			"STRICT ROUTING: 'msg N', 'message N', 'about N', or a bare 4-6 digit number from a digest/list-queued reply → HERE. NOT vaultSearch (vault notes ≠ inbox rows). " +
			"Returns envelope (from/subject/when) + cached extract + agent-action history + 200-char body preview for one message. " +
			"Triggers: 'what about msg 33602', 'tell me about 33425', bare '33877' reply to a digest. " +
			"PROVENANCE: messageId MUST be real (from prior inbox-list-queued / digest / user-typed). NEVER fabricate. " +
			"For full body: call `inbox-read-body` next.",
		ui_description:
			"Composite drill-down on one message — envelope + cached extract + agent_actions audit history + body preview snippet. Server-formatted, no LLM in the path. Closes the digest/anomaly-push reply loop.",
		examples: [
			{ user: '"what about msg 33602"', toolArgs: '{ messageId: 33602 }' },
			{ user: '"tell me more about 33877"', toolArgs: '{ messageId: 33877 }' },
		],
	},
	{
		name: 'crm-add-contact',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Add a new CRM contact. Use when the user says 'add X as a new lead', 'remember Sarah from Acme', " +
			"'create a contact for Y'. Provide displayName plus any combination of company, role, source, stage " +
			"(default 'Lead'), and an emails array. After creating, the contact's vault note is generated " +
			"automatically in knowledge/crm/contacts/ with managed frontmatter.",
		ui_description:
			'Add a new CRM contact with optional emails. Creates the vault note alongside the DB row.',
		examples: [
			{
				user: '"add Sarah from Acme as a lead, her email is sarah@acme.com"',
				toolArgs: '{ displayName: "Sarah Smith", company: "Acme", emails: [{ email: "sarah@acme.com", isPrimary: true }] }',
			},
		],
	},
	{
		name: 'crm-find-contact',
		category: 'read',
		toolset: 'crm',
		llm_description:
			"Search CRM contacts. Pass `email` for exact-email lookup (case-insensitive), `phone` for exact-phone lookup (as-typed — phones are stored unnormalized), or `query` for FTS5 over name, company, role, and notes. Returns the matches with stage and primary email. " +
			"Use for 'who is X', 'do I have a contact at Acme', 'find John's record', 'is sarah@acme.com in my CRM', 'who owns +971 50 123 4567'.",
		ui_description:
			'Search CRM contacts by name/company/role/notes (FTS5), exact email, or exact phone.',
		examples: [
			{ user: '"do I have John from Acme"', toolArgs: '{ query: "John Acme" }' },
			{
				user: '"is sarah@acme.com a contact"',
				toolArgs: '{ email: "sarah@acme.com" }',
			},
			{
				user: '"who owns +971 50 123 4567"',
				toolArgs: '{ phone: "+971 50 123 4567" }',
			},
		],
	},
	{
		name: 'crm-log-interaction',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Log an interaction with a CRM contact (channel: email/call/meeting/social/whatsapp/other). " +
			"Resolve the contact via `contactId` (CRM-YYYY-NNN) OR `email`. Provide a short `summary`. " +
			"Optionally set `messageId` to cross-reference an inbox message id from inbox-list-queued. " +
			"Use after 'I met with X', 'called Y', 'replied to Z's email'. " +
			"PROVENANCE: `contactId` MUST come from a prior `crm-find-contact` / `crm-add-contact` / `crm-update-stage` result. `email` MUST be either a known CRM contact's email (run `crm-find-contact` first if unsure) OR a real `from_address` from a prior `inbox-list-queued` row. NEVER fabricate emails or contact ids. `messageId` MUST be a real inbox id from a prior `inbox-list-queued` / `inbox-read-body` result.",
		ui_description:
			'Append an interaction touch to a contact. Supports linking to an inbox message id.',
		examples: [
			{
				user: '"log a meeting with Sarah today, we discussed pricing"',
				toolArgs: '{ email: "sarah@acme.com", channel: "meeting", summary: "Discussed pricing" }',
			},
		],
	},
	{
		name: 'crm-update-stage',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Move a CRM contact between pipeline stages: Lead → Contacted → In Conversation → Proposal → Won → Lost. " +
			"Resolve via `contactId` or `email`. Writes a stage_history row + refreshes the vault note frontmatter. " +
			"Use for 'move John to In Conversation', 'mark Acme as Won', 'lost the Carrefour deal'. " +
			"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. NEVER fabricate emails or contact ids.",
		ui_description:
			'Move a contact between pipeline stages. Audits the move in stage_history and syncs the vault note.',
		examples: [
			{
				user: '"move Sarah to In Conversation"',
				toolArgs: '{ email: "sarah@acme.com", stage: "In Conversation" }',
			},
		],
	},
	{
		name: 'crm-set-followup',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Schedule the next follow-up date for a CRM contact. Resolve via `contactId` or `email`. " +
			"Emit `dueAt` as ISO 8601 with timezone offset (parse natural language relative to Asia/Dubai). " +
			"By default also creates a WhatsApp reminder via the heartbeat commitments rail so the user is " +
			"pinged at the due time — set `createReminder=false` to skip the ping. " +
			"Use for 'follow up with X next Tuesday', 'set a reminder to ping Sarah in two weeks'. " +
			"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. NEVER fabricate emails or contact ids.",
		ui_description:
			'Set the next follow-up date on a CRM contact. Optionally fires a WhatsApp reminder via heartbeat commitments.',
		examples: [
			{
				user: '"follow up with John about the proposal next Tuesday"',
				toolArgs: '{ email: "john@acme.com", dueAt: "2026-05-19T09:00:00+04:00", context: "proposal" }',
			},
		],
	},
	{
		name: 'crm-list-followups',
		category: 'read',
		toolset: 'crm',
		llm_description:
			"List CRM contacts with overdue or upcoming follow-ups. Optional knobs: `overdueWindowDays` " +
			"(how far back to look for overdue rows) + `upcomingWindowDays` (default 3). Returns the lists " +
			"grouped — render them as two short sections in the reply. Use for 'what's overdue', " +
			"'who do I need to follow up with', 'my follow-ups this week'.",
		ui_description:
			'List CRM contacts with overdue + upcoming follow-ups inside a configurable window.',
		examples: [
			{ user: '"what is overdue this week"', toolArgs: '{ upcomingWindowDays: 0 }' },
			{ user: '"my follow-ups this week"', toolArgs: '{ upcomingWindowDays: 7 }' },
		],
	},
	{
		name: 'crm-add-email',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Add an additional email address to an existing CRM contact. Resolve via `contactId` or " +
			"`currentEmail` (one of the contact's existing addresses). Provide the `newEmail` and " +
			"optional `label` ('work' | 'personal' | other) and `isPrimary`. Emails are globally unique " +
			"across the CRM — reusing an email attached to another contact errors. " +
			"PROVENANCE: `contactId` / `currentEmail` MUST come from a prior `crm-find-contact` / `crm-add-contact` result. `newEmail` MUST come from the user explicitly (a message they typed) OR from a real `from_address` in `inbox-list-queued`. NEVER fabricate emails.",
		ui_description:
			'Add a secondary email address to a CRM contact. Mirrors the multi-email schema from ADR D2.',
		examples: [
			{
				user: '"John\'s personal email is john.doe@gmail.com"',
				toolArgs: '{ currentEmail: "john@acme.com", newEmail: "john.doe@gmail.com", label: "personal" }',
			},
		],
	},
	{
		name: 'crm-add-phone',
		category: 'write',
		toolset: 'crm',
		llm_description:
			"Add a phone number to an existing CRM contact. Resolve via `contactId` or `email` (one of the contact's existing emails). Provide `phone` (any format — stored as-typed, no E.164 normalization) and optional `label` ('mobile' | 'home' | 'work' | other) and `isPrimary`. Phones are globally unique across the CRM — reusing a number attached to another contact errors. " +
			"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result. `phone` MUST come from the user explicitly (a message they typed). NEVER fabricate phone numbers.",
		ui_description:
			'Add a phone number to a CRM contact. Mirrors the multi-phone schema from ADR Stage F2.',
		examples: [
			{
				user: '"Sarah\'s mobile is +971 50 123 4567"',
				toolArgs: '{ email: "sarah@acme.com", phone: "+971 50 123 4567", label: "mobile", isPrimary: true }',
			},
		],
	},
	{
		name: 'crm-attach-note',
		category: 'write',
		toolset: 'crm',
		llm_description:
			'Attach a vault note (transcript, document, reference) to a CRM contact. ' +
			'Resolve via `contactId` (CRM-YYYY-NNN) OR `email`. `vaultPath` is the ' +
			'vault-relative path of an EXISTING note (e.g., \'inbox/2026-05-11-acme-kickoff.md\'). ' +
			'Optional: `kind` (transcript / document / reference / other; default \'other\'), ' +
			'`label`, `sourceUrl`, `sourceMessageId`. ' +
			'Chains naturally after `vaultSave` when the saved content came from a URL fetch ' +
			'(via `fetchPage`) or an email link relevant to a CRM contact. ' +
			'Idempotent — re-attaching the same (contact, vaultPath) pair reports the prior ' +
			'attachment timestamp without inserting a duplicate. ' +
			'PROVENANCE — DO NOT INVENT ARGS: `vaultPath` MUST be the LITERAL `path` returned by a prior `vaultSave` call (NEVER guess based on title or date — vaultSave\'s output is the truth). `email` / `contactId` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. `sourceMessageId` MUST be a real inbox id from a prior `inbox-list-queued` / `inbox-read-body` result. The tool errors loudly when args don\'t resolve — that error means you hallucinated; do NOT relay a fake \'success\' to the user.',
		ui_description:
			'Attach a vault note to a CRM contact. Closes the email → fetchPage → vaultSave → CRM-link loop. Idempotent and validates the vault path exists before insert.',
		examples: [
			{
				user: '"attach inbox/2026-05-11-acme-kickoff-transcript.md to Sarah as a transcript"',
				toolArgs:
					'{ email: "sarah@acme.com", vaultPath: "inbox/2026-05-11-acme-kickoff-transcript.md", kind: "transcript" }',
			},
		],
	},
	{
		name: 'crm-find-website-leads',
		category: 'read',
		toolset: 'crm',
		llm_description:
			"Find inbox messages that look like website leads — subject contains a configurable tag " +
			"(default a configurable subject tag) AND the sender is NOT already a CRM contact. Returns a list " +
			"the user can convert into contacts via crm-add-contact. Use for 'any new website leads', " +
			"'check for inquiries from the site', 'who reached out from the site this week'.",
		ui_description:
			'Find fresh inbox messages that look like website leads (subject tag + unknown sender). Surfaces conversion candidates.',
		examples: [
			{ user: '"any new website leads"', toolArgs: '{}' },
			{
				user: '"any leads tagged with [acme.com]"',
				toolArgs: '{ subjectContains: "[acme.com]" }',
			},
		],
	},
	{
		name: 'projectShipSlice',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Mark a project ADR slice (S<N>, CP<N>, Phase <N>, PASS <N>, Stage <N>) as shipped/accepted/parked/superseded/rejected. ' +
			'Atomically updates the ADR Status section + the project index Ship log via the ADR-046 chokepoint. Use after a commit closes a slice — pass the project slug, ADR slug (or bare ordinal like "007"), slice label, status, and commit short-SHA. ' +
			'STRICT ROUTING: only fires when the user explicitly asks to "mark/ship/close/record" a slice or ADR phase. NEVER fires for vague "what shipped" / "what\'s open" queries (those use the read API directly). NEVER fires on commit messages alone — needs the user to ask. ' +
			'Mode "dry_run": true returns the preview without writing; use this to verify the slice label resolves correctly before applying. ' +
			'PROVENANCE — DO NOT INVENT ARGS: `commit` MUST be a REAL git short-SHA from a prior shell output or commit summary the user pasted; NEVER fabricate. `slice_id` MUST match the operator\'s exact label convention for that ADR — check the ADR\'s Implementation plan table if unsure. The tool returns 422 if the marker is already present (idempotent), 400 if the ADR can\'t be resolved.',
		ui_description:
			'Atomically mark an ADR slice as shipped — updates ADR Status section + project index Ship log in one operation. Eliminates the three-place-duplication drift surfaced by ADR-007 S3 retrospective.',
		examples: [
			{
				user: '"mark naseej ADR-007 S5 shipped at commit abc1234"',
				toolArgs:
					'{ slug: "naseej", adr: "adr-007-peer-brief-naseej-port", slice_id: "S5", status: "shipped", commit: "abc1234" }',
			},
			{
				user: '"close ADR-003 S3 in project-phases as accepted"',
				toolArgs:
					'{ slug: "project-phases", adr: "adr-003", slice_id: "S3", status: "accepted" }',
			},
		],
	},
	{
		// ADR-010 S10 — description aligned with `soul adr propose` engine path.
		name: 'proposeAdr',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Draft a NEW ADR (architecture decision record) note in a project, with status `proposed`. Uses the same `applyProposeAdr` engine path as `soul adr propose`. Picks the next-available `adr-NNN-<slug>` ordinal, composes the standard ADR structure (one H1 + Status / Context / Decision / Falsifiers / Implementation plan / Related sections), and writes via the ADR-046 chokepoint with `actor: proposeAdr`. ' +
			'STRICT ROUTING: only fires when the user explicitly asks to "draft / propose / write a new ADR" for a specific project. NEVER fires for vague "we should write something about X" — needs a concrete project slug + working title. NEVER mutates an existing ADR (that\'s the operator\'s job via the AdrDrawer). ' +
			'PROVENANCE — DO NOT INVENT ARGS: pull `problem_statement` and `falsifier_conditions` from the user\'s own words in the conversation, never fabricate. If the user hasn\'t articulated a problem statement or at least one falsifier, ASK before calling. ' +
			'The new ADR lands as `status: proposed`; the operator confirms via the existing AdrDrawer Accept button (no new acceptance UI) or `adrAccept` tool (S9). The tool returns 404 if `projects/<slug>/index.md` is missing, 409 on two consecutive ordinal collisions (rare race with manual hand-creation).',
		ui_description:
			'Draft a new project ADR with `status: proposed` via the same engine path as `soul adr propose`. Operator accepts via AdrDrawer or adrAccept tool.',
		examples: [
			{
				user: '"draft an ADR for naseej about caching the rendered peer-brief PDFs"',
				toolArgs:
					'{ slug: "naseej", working_title: "Cache rendered peer-brief PDFs", tier: "Tier 1", problem_statement: "...", decision_sketch: ["...", "..."], falsifier_conditions: ["..."] }',
			},
		],
	},
	{
		name: 'suggestAdrEdit',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Suggest a structured edit to an EXISTING ADR\'s prose. Writes a NEW proposal note under `projects/<slug>/proposals/YYYY-MM-DD-NN-<short-slug>.md` (NEVER mutates the target ADR). Frontmatter records `target_adr`, `proposed_section`, `status: open`. Operator reviews via the project page proposals panel and decides to apply, edit, or reject. ' +
			'STRICT ROUTING: only fires when the user explicitly asks to "suggest / propose / draft an edit" to a specific ADR section. NEVER fires on vague "we could rewrite X". NEVER mutates the target ADR — that\'s the operator\'s job after review. NEVER creates a new ADR (that\'s `proposeAdr`). NEVER adds a slice row (that\'s `proposeSlice`). ' +
			'PROVENANCE — DO NOT INVENT ARGS: `proposed_text` MUST be derived from the user\'s own articulation in the conversation, not fabricated. `rationale` must explain WHY this edit is needed, not just restate the proposed text. If the user has not described both, ASK before calling. ' +
			'The proposal is just a note — the operator still has to apply it manually. Returns 404 if the project is missing, 400 if the ADR cannot be resolved.',
		ui_description:
			'Draft a structured edit suggestion for an existing ADR section — proposal is persisted as a separate note (operator applies manually). Never mutates the target ADR.',
		examples: [
			{
				user: '"propose adding F6 to project-phases ADR-005 covering proposal-zone hygiene"',
				toolArgs:
					'{ slug: "project-phases", adr: "adr-005", section: "Falsifiers", title: "F6 proposal-zone hygiene", rationale: "30-day staleness check on the proposals folder ...", proposed_text: "- **F6** ..." }',
			},
		],
	},
	{
		name: 'proposeSlice',
		category: 'write',
		toolset: 'project-adr',
		llm_description:
			'Add a NEW slice row to an EXISTING ADR\'s `## Implementation plan` table. Writes the row via the ADR-046 chokepoint with `actor: proposeSlice` (distinct from `proposeAdr` creations and `projectShipSlice` closures in the audit log). ' +
			'STRICT ROUTING: only fires when the user explicitly asks to "add / propose a slice / phase / stage" to a specific ADR. NEVER fires on vague "we should plan more work on X". NEVER mutates the ADR\'s Status section, Decision section, frontmatter status, or any closure markers — that is `projectShipSlice`\'s job. NEVER creates a new ADR — that is `proposeAdr`\'s job. ' +
			'PROVENANCE — DO NOT INVENT ARGS: `scope` and `estimate` MUST be derived from the user\'s own articulation in the conversation, not fabricated. If the user has not described scope or estimate, ASK before calling. ' +
			'If `slice_id` is omitted the tool computes the next-available ordinal in the table\'s dominant family (defaults to `S<N>`). Pass `family` to force a specific family (e.g. `Phase` for naseej-style projects). The tool returns 404 if the project is missing, 400 if the ADR cannot be resolved, 422 if the ADR has no `## Implementation plan` table. Idempotent: if the slice_id is already in the table, returns `already_present: true` without writing.',
		ui_description:
			'Add a slice / phase / stage row to an existing ADR\'s Implementation plan table — does NOT close the slice, does NOT touch the Status section. Pair with `projectShipSlice` later to close it.',
		examples: [
			{
				user: '"add slice S5 to project-phases ADR-005 — extend proposeSlice with a dry-run mode, ~1-2 hours"',
				toolArgs:
					'{ slug: "project-phases", adr: "adr-005", slice_id: "S5", scope: "Extend proposeSlice with a dry-run mode that returns the preview row without writing", estimate: "1-2 hours" }',
			},
			{
				user: '"propose the next slice on naseej ADR-007 covering the falsifier dashboard"',
				toolArgs:
					'{ slug: "naseej", adr: "adr-007", scope: "Falsifier dashboard surface on /projects/naseej — count open vs closed by ADR", estimate: "2-3 hours" }',
			},
		],
	},
	// ── ADR-011 — Browser navigation tools ──────────────────────────────────────
	{
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		name: 'navigateTo',
		category: 'read',
		toolset: 'navigation',
		llm_description:
			'Navigate the browser to a Soul Hub page. ONLY works in the browser chat (web channel) — ' +
			'on WhatsApp/Telegram this returns a graceful error. ' +
			'Use when the user says "take me to X", "go to the scheduler", "open the vault", ' +
			'"navigate to projects", "show me the CRM". ' +
			'Pass `path` as a concrete route (e.g. `/scheduler`, `/projects/naseej`, `/vault`). ' +
			'For deep-links: pass `params` with `{ note: "vault/relative/path.md" }` to pre-select ' +
			'a vault note, or `{ adr: "adr-007" }` to open a project ADR drawer. ' +
			'Path MUST be an internal Soul Hub route — external URLs are rejected (use `fetchPage` for those). ' +
			'Call `listPages` first if unsure which route to use.',
		ui_description:
			'Navigate the browser to a Soul Hub page (web-only). Supports deep-links for vault notes and project ADRs. Validates path against the internal page catalog.',
		examples: [
			{ user: '"take me to the scheduler"', toolArgs: '{ path: "/scheduler" }' },
			{
				user: '"open the naseej project"',
				toolArgs: '{ path: "/projects/naseej" }',
			},
			{
				user: '"open ADR-007 in the naseej project"',
				toolArgs: '{ path: "/projects/naseej", params: { adr: "adr-007" } }',
			},
			{
				user: '"show me that vault note"',
				toolArgs: '{ path: "/vault", params: { note: "projects/naseej/adr-007.md" } }',
			},
		],
	},
	{
		// ADR-014 — in navigation toolset but NOT in WEB_ONLY_TOOLS: listPages is
		// all-channel (returns text list; no browser navigation needed).
		name: 'listPages',
		category: 'read',
		toolset: 'core',
		llm_description:
			'List all Soul Hub pages with their routes and descriptions. ' +
			'Use for "what pages are there?", "where can I go?", "show me the app map", ' +
			'"what sections does Soul Hub have?". ' +
			'Available on all channels (web + WhatsApp + Telegram).',
		ui_description:
			'List all Soul Hub pages with routes and descriptions. Available on all channels.',
		examples: [
			{ user: '"what pages are there?"', toolArgs: '{}' },
			{ user: '"show me the app map"', toolArgs: '{}' },
		],
	},
	{
		// ADR-013 S1 — STRICT-ROUTING preamble added: scopes this tool to
		// page/screen/UI description questions only; explicit redirect to
		// projectGet for project-status questions ("how is project X").
		// ADR-014 — in WEB_ONLY_TOOLS: never assembled off web.
		// ADR-014 S6 — disambiguation examples vs projectGet.
		name: 'describeCurrentPage',
		category: 'read',
		toolset: 'navigation',
		llm_description:
			'STRICT ROUTING — use ONLY for questions about the BROWSER UI ITSELF: "where am I?", "what is this screen?", ' +
			'"what can I do here?", "what features does this page have?", "describe this view". ' +
			'Takes no arguments. ONLY works in the browser chat (web channel). ' +
			'Do NOT use for project-status questions ("how is project X?", "what\'s open in Y?", ' +
			'"what\'s the status of Z?", "how is the soul-hub project?") — those are about vault project data, NOT the page UI → use `projectGet`. ' +
			'Returns the page title, description, and chat capabilities for the current scope.',
		ui_description:
			'Describe the current browser page and list chat capabilities for the active scope. Web-only.',
		examples: [
			{ user: '"where am I?"', toolArgs: '{}' },
			{ user: '"what can I do here?"', toolArgs: '{}' },
			{ user: '"describe this screen"', toolArgs: '{}' },
			{ user: '"what features does this page have?"', toolArgs: '{}' },
		],
	},
	// ─────────────────────────────────────────────────────────────────────────────
	// ADR-013 S2 — systemHealth tool: gives "system health / is everything ok /
	// are services up" questions a real target so they don't fall through to
	// projectList. Read-only, all channels, no confirmation gate.
	{
		// ADR-013 S2 — systemHealth added.
		// ADR-014 S6 — added disambiguation examples vs projectList.
		name: 'systemHealth',
		category: 'read',
		toolset: 'core',
		llm_description:
			'STRICT ROUTING — use for system health / server status / "is everything ok" / "are services up" / ' +
			'"show me the system health" questions. ' +
			'Returns Soul Hub server reachability, vault health summary, inbox sync freshness, ' +
			'catalog-index status, and hook installation status. All-channel, read-only. ' +
			'Do NOT use for project listing — use `projectList` for that. ' +
			'Do NOT use for vault note search — use `vaultSearch` for that.',
		ui_description:
			'Report Soul Hub system health: server status, vault health, inbox sync age, catalog freshness, hook status. All channels.',
		examples: [
			{ user: '"show me the system health"', toolArgs: '{}' },
			{ user: '"is everything ok?"', toolArgs: '{}' },
			{ user: '"are services up?"', toolArgs: '{}' },
			{ user: '"is the server running?"', toolArgs: '{}' },
		],
	},
	// ── ADR-014 S5 — Dynamic discovery meta-tools (Tier 3) ───────────────────────
	{
		// enableToolset: signals that a toolset should be loaded for subsequent
		// turns. Called when the model detects it needs a tool that isn't currently
		// assembled (gating under-selected). The toolset expansion persists for the
		// rest of the conversation session.
		name: 'enableToolset',
		category: 'read',
		toolset: 'core',
		llm_description:
			'ADR-014 Tier 3 — Enable an additional toolset for this conversation. ' +
			'Call ONLY when you need a tool that is not currently available and you know which toolset contains it. ' +
			'Available toolsets: core, vault, project-adr, inbox, crm, external-fetch, navigation, actions. ' +
			'After enabling, tell the user the relevant tools are now available and ask them to re-state their request. ' +
			'Do NOT call this for toolsets that are already loaded. Use `listToolsets` to see what is currently loaded.',
		ui_description:
			'ADR-014 Tier 3 — Enable an additional toolset for this conversation session. Self-healing fallback when gating under-selected.',
		examples: [
			{
				user: '"(model needs crm tools but they are not loaded)"',
				toolArgs: '{ toolset: "crm" }',
			},
			{
				user: '"(model needs vault tools for a save operation)"',
				toolArgs: '{ toolset: "vault" }',
			},
		],
	},
	{
		// listToolsets: lets the model discover what toolsets exist and which are
		// currently active, so it can call enableToolset intelligently.
		name: 'listToolsets',
		category: 'read',
		toolset: 'core',
		llm_description:
			'ADR-014 Tier 3 — List all available toolsets and which tools each contains. ' +
			'Use when you are unsure whether a needed tool exists or which toolset it belongs to. ' +
			'Returns the toolset names, their descriptions, current load status, and the tool names in each set. ' +
			'After reviewing, call `enableToolset` if you need tools from an unloaded set.',
		ui_description:
			'ADR-014 Tier 3 — List all toolsets with their current load status and tool inventory.',
		examples: [
			{ user: '"what tools are available?"', toolArgs: '{}' },
			{ user: '"(model needs to know if CRM tools are loaded)"', toolArgs: '{}' },
		],
	},
	{
		name: 'scheduleReminder',
		category: 'write',
		toolset: 'actions',
		llm_description:
			'Schedule a one-time reminder for the user. ' +
			'Use ONLY when the user explicitly asks to be reminded ("remind me to X at Y", "ping me tomorrow about Z"). ' +
			'NEVER use for discussion ("do you remember when..."), vague intents ("I should probably do X someday"), or inferred follow-ups from the conversation. ' +
			'Emit `dueAt` as an ISO 8601 datetime WITH timezone offset — parse natural language ' +
			'("tomorrow 11am", "next Monday morning") relative to the user\'s timezone (Asia/Dubai unless context overrides). ' +
			'Reminders fire on the WhatsApp heartbeat (within ~30 min of the due time) and only inside the user\'s active hours. ' +
			'If the user names a time outside active hours (e.g. "remind me at 3 am"), the system defers to the start of the next active window — the tool result\'s `cadenceNote` tells you when it will actually fire so you can confirm honestly. ' +
			'Reminders are WhatsApp-only today (Telegram returns `reminders-not-supported-on-this-channel`). ' +
			'After the tool returns successfully, confirm to the user: "OK — I\'ll remind you about <text> on <date> around <time>" — include the cadenceNote when present.',
		ui_description:
			'Schedule a one-time reminder. Rides the WhatsApp heartbeat commitments rail (ADR-025) — fires within ~30 min of the due time during active hours; same `HEARTBEAT_OK <id>` dismissal contract as extractor-inferred follow-ups.',
		examples: [
			{
				user: '"remind me tomorrow to call my dad around 11am"',
				toolArgs: '{ text: "Call your dad", dueAt: "2026-05-12T11:00:00+04:00" }',
			},
		],
	},
];

/** Lookup helper. Returns undefined for unknown names so callers can
 *  decide between strict failure and graceful degrade. */
export function getToolManifest(name: string): ToolManifest | undefined {
	return TOOL_MANIFESTS.find((m) => m.name === name);
}

/** Stable category order for grouping in the UI — read-tools first
 *  (most common), then write, then orchestration (agent/skill), reply
 *  last (least interesting to surface). */
export const CATEGORY_ORDER: ToolCategory[] = ['read', 'write', 'agent', 'skill', 'reply'];

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
	read: 'Read',
	write: 'Write',
	agent: 'Dispatch agent',
	skill: 'Invoke skill',
	reply: 'Reply',
};
