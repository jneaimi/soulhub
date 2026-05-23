/**
 * Unified conversation context — single read surface across the two SQLite
 * stores that hold WhatsApp conversation state.
 *
 *   - `chat_history` lives in `inbox.db` (owned by vault-chat's history.ts).
 *   - `agent_runs` lives in `whatsapp/heartbeat.db` (owned by agents/runs.ts).
 *
 * The orchestrator and any future per-conversation reasoner reads from here
 * instead of touching either store directly. Two narrow queries, no join,
 * no schema migration.
 *
 * Conversation key convention is the one already in `_inbound`:
 *   DM    → `senderNumber` (E.164)
 *   Group → `chatJid`
 *
 * The optional `jid` is the full WhatsApp JID (e.g. `971500000099@s.whatsapp.net`)
 * used to look up `agent_runs`. Pass it when you have it; without it, the
 * recent-dispatches slice comes back empty (history alone is still useful).
 */

import { loadHistory } from '$lib/vault-chat/history.js';
import { listAgentRunsByJid } from '$lib/agents/runs.js';
import { getVaultEngine } from '$lib/vault/index.js';
import type { ChatMessage } from '$lib/llm/types.js';

export interface AgentRunSummary {
	agentId: string;
	status: string;
	startedAt: number;
	excerpt: string;
}

export interface ConversationContext {
	history: ChatMessage[];
	recentDispatches: AgentRunSummary[];
}

export interface ContextOptions {
	jid?: string;
	recentLimit?: number;
}

const EXCERPT_MAX = 240;
const TURN_PREVIEW_MAX = 280;
const BRIEF_HISTORY_TURNS = 4;
const BRIEF_DISPATCHES = 2;

// ADR-053 P2 — vault-recon injection bounds.
const RECON_LIMIT = 3;
const RECON_SNIPPET_MAX = 90;
// Drop hits scoring below this fraction of the top hit — the documented
// anti-tangential-pollution mitigation (a loose match is not relevant context).
const RECON_SCORE_RATIO = 0.3;

/**
 * ADR-053 P2 — lexical vault-recon for a dispatch subject. Returns a bounded
 * "prior vault notes" block (top-3 distilled hits: title + date + snippet) so a
 * dispatched agent starts vault-aware and EXTENDS prior work instead of
 * re-deriving it (this is the agent-side fix, soul-hub-agents ADR-003 P1 —
 * the supervisor pre-fetches context for the worker).
 *
 * Lexical only (MiniSearch, in-memory, ~ms) — no semantic/embedding dependency
 * (the embeddings RAG was retired per soul-hub-whatsapp ADR-004). Returns '' when
 * the engine is unavailable or nothing relevant matches — recon is best-effort
 * and never blocks a dispatch.
 */
export function buildVaultReconBlock(subject: string | undefined): string {
	const q = (subject ?? '').replace(/\s+/g, ' ').trim();
	if (q.length < 3) return '';
	const engine = getVaultEngine();
	if (!engine) return '';
	let results;
	try {
		results = engine.getNotes({ q, limit: RECON_LIMIT * 2 });
	} catch {
		return '';
	}
	if (!results || results.length === 0) return '';
	const top = results[0].score ?? 0;
	const floor = top * RECON_SCORE_RATIO;
	const kept = results.filter((r) => (r.score ?? 0) >= floor).slice(0, RECON_LIMIT);
	if (kept.length === 0) return '';
	const lines = kept.map((r) => {
		const date = r.path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
		const snip = (r.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, RECON_SNIPPET_MAX);
		return `- ${r.title || r.path}${date ? ` (${date})` : ''} — ${snip}`;
	});
	return (
		'## Prior vault notes (recon — extend these, do not re-derive)\n' + lines.join('\n')
	);
}

export function getConversationContext(
	conversationKey: string,
	opts: ContextOptions = {},
): ConversationContext {
	const history = conversationKey ? loadHistory(conversationKey) : [];
	const recentDispatches: AgentRunSummary[] = opts.jid
		? listAgentRunsByJid(opts.jid, { limit: opts.recentLimit ?? 3, mode: 'production' }).map(
				(r) => ({
					agentId: r.agentId,
					status: r.status,
					startedAt: r.startedAt,
					excerpt: (r.resultExcerpt ?? '').slice(0, EXCERPT_MAX),
				}),
			)
		: [];
	return { history, recentDispatches };
}

/** Build a short brief that the orchestrator inlines into a dispatched
 *  agent's task. Bounded to ~600 chars so it doesn't blow CLI prompt
 *  budgets — agents like `scribe`/`weaver` produce content from a spec, not
 *  a chat continuation, and a 16-turn dump confuses them. The brief carries
 *  the prior topic + the gist of the most recent agent answers, nothing more. */
export function buildAgentContextBrief(ctx: ConversationContext, subject?: string): string {
	const parts: string[] = [];
	// ADR-053 P2 — prepend vault-recon so the agent sees prior work first.
	const recon = buildVaultReconBlock(subject);
	if (recon) parts.push(recon);
	if (ctx.history.length > 0) {
		const recent = ctx.history.slice(-BRIEF_HISTORY_TURNS);
		const lines = recent.map(
			(t) => `**${t.role}:** ${t.content.slice(0, TURN_PREVIEW_MAX).replace(/\s+/g, ' ').trim()}`,
		);
		parts.push('## Conversation context\n' + lines.join('\n\n'));
	}
	if (ctx.recentDispatches.length > 0) {
		const lines = ctx.recentDispatches
			.slice(0, BRIEF_DISPATCHES)
			.map((d) => `- ${d.agentId} (${d.status}): ${d.excerpt.slice(0, 160)}`);
		parts.push('## Recent agent runs\n' + lines.join('\n'));
	}
	return parts.join('\n\n---\n\n');
}

// ANSI control sequences (CSI, OSC, SS3, DCS) + raw control chars + the
// box / block / shade drawing chars Claude Code's TUI uses for its banner.
// PTY-backed lanes (claude-pty) leak all of this into the captured output
// buffer; without stripping, summaries from cancelled-mid-init runs are
// unreadable for both humans AND the orchestrator's next decide() call.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1bP[\s\S]*?\x1b\\)|(?:\x1b[NOPX^_])|[\x00-\x08\x0B-\x1F\x7F]/g;
const BOX_DRAW_RE = /[─-▟■-◿]+/g;

function stripTerminalNoise(s: string): string {
	return s.replace(ANSI_RE, '').replace(BOX_DRAW_RE, '').replace(/\s+/g, ' ').trim();
}

const MIN_ALPHA_WORDS_FOR_USEFUL_LINE = 3;
// `\p{L}` matches a letter in ANY script (Latin, Arabic, CJK, Cyrillic, …).
// The previous Latin-only `[A-Za-z]{3,}` silently dropped pure-Arabic prose
// lines from chat replies — every line had zero "alpha words" so the
// cleaner stripped them as banner noise. Banner-detection runs AFTER this
// in `looksLikeClaudeCodeBanner`, so widening the script set can't re-leak
// TUI artifacts.
const WORD_RE = /\p{L}{3,}/gu;

function alphaWordCount(s: string): number {
	const m = s.match(WORD_RE);
	return m ? m.length : 0;
}

// The Claude Code TUI startup banner survives ANSI/box stripping because
// the model names + version strings are all alpha-word-heavy. After the
// box-draw chars between them are stripped, you get one long line like
// "ClaudeCodev2.1.128 Sonnet4.6·ClaudeMax". Targeted regex catches it
// without false-positive risk (no real sentence concatenates a model
// version + model name like this).
const CC_BANNER_RE = /Claude\s*Code\s*v\d|ClaudeCode\s*v\d|Claude\s*Max|·\s*Claude\s*Max/i;

// 2026-05-06: in-session TUI status indicators that survive ANSI stripping
// AND have ≥3 alpha words (so the alphaWordCount filter doesn't drop
// them). Real examples from leaked PTY transcripts:
//   "vault Sonnet 4.6 high · /effort"
//   "⏵⏵ bypass permissions on (shift+tab to cycle)"
//   "ctx 14% 2k/200k Create plane image with text overlay"
//   "117 skill descriptions dropped · /doctor for details"
//   "100 tokens · thought for 9s"
//   "Welcome back Jasem!"
//   "Fixed VSCode extension failing to activate on Windows"
//   'Added `--plugin-url <url>` flag to fetch a plugin `.zip` archive'
//   "/release-notes for more"
//   '❯ Try "refactor <filepath>"'
//   "[Pasted text #1 +14 lines]"
//   "paste again to expand"
//   "Sonnet 4.6 · Claude Max · Jasem Al Neaimi"
// Each pattern is tight enough that real prose can't false-positive.
const CC_STATUS_RE_LIST: RegExp[] = [
	// Model identity tokens
	/^Sonnet\s*4\.6|^Opus\s*4\.6|^Haiku\s*4\.5|·\s*Sonnet\s*4\.6|·\s*Claude\s*Max/i,
	// Session control hints
	/bypass\s+permissions\s+on/i,
	/shift\+tab\s+to\s+cycle/i,
	/^ctx\s+\d+%\s+\d/i,
	/skill\s+descriptions\s+dropped/i,
	/\d+\s+tokens?\s+·\s+thought\s+for\s+\d+s/i,
	/^⏵⏵|^⎿|^⏺|❯\s*vault\s|^❯\s*Try\s/i,
	/\/effort\s|\s\/effort$|·\s*\/effort/i,
	// Welcome / splash panel content
	/Welcome\s+back\s+\w+/i,
	/What['']s\s+new/i,
	/release[-\s]?notes\s+for\s+more/i,
	// Release-note ticker bullets — `Added \`--<flag> <arg>\`` etc.
	/Added\s+`?--[\w-]+\s+<[^>]+>`?\s+flag/i,
	/Fixed\s+(?:VSCode|Mantle|Windows|Linux|macOS)\b/i,
	/failing\s+to\s+activate/i,
	// Paste-content elision markers
	/\[Pasted\s+text\s+#\d+\s+\+\d+\s+lines?\]/i,
	/paste\s+again\s+to\s+expand/i,
	// Try-prompt suggestions
	/^["“]?Try\s+["“]refactor\s+<[^>]+>/i,
];

function looksLikeClaudeCodeBanner(s: string): boolean {
	if (CC_BANNER_RE.test(s)) return true;
	for (const re of CC_STATUS_RE_LIST) if (re.test(s)) return true;
	return false;
}

// 2026-05-06: section headings that ONLY appear in agent system prompts
// (output-shape spec, pipeline integration spec, failure handling spec).
// When an agent runs short on real content and dumps its own prompt, these
// headings appear in the captured output. Truncate at the first match —
// everything below is system-prompt echo, not real work.
const PROMPT_ECHO_MARKERS: RegExp[] = [
	/^\s*(?:###?\s+)?Trailer\s+rules\b/im,
	/^\s*(?:###?\s+)?Machine-style\b/im,
	/^\s*(?:###?\s+)?Failure\s*\/\s*partial\s+output\b/im,
	/^\s*(?:###?\s+)?Composable\s+Pipeline\b/im,
	/^\s*##\s+Recent\s+agent\s+runs\s*$/im,
	/^\s*\*\*assistant:\*\*/m,
	/^\s*\*\*user:\*\*/m,
];

/** Locate the earliest "this output starts echoing the agent's system
 *  prompt" marker. Returns the index of the start of the offending line,
 *  or -1 when no echo signature is present. */
function firstPromptEchoIndex(s: string): number {
	let earliest = -1;
	for (const re of PROMPT_ECHO_MARKERS) {
		const m = re.exec(s);
		if (m) {
			const i = m.index;
			if (earliest === -1 || i < earliest) earliest = i;
		}
	}
	return earliest;
}

/** One-line writeback to `chat_history` after an agent finishes, so the next
 *  conversational turn (in either the orchestrator or vault-chat) sees the
 *  gist of what the agent answered. Raw output stays in `agent_runs.output`
 *  for full retrieval; this is just an anchor for anaphoric resolution. */
export function summarizeAgentResultForHistory(
	agentId: string,
	output: string | undefined,
	error: string | undefined,
	status: string,
): string {
	const raw = output && output.trim() ? output : error && error.trim() ? error : '';
	// Walk the lines and pick the first one that survives ANSI/box stripping
	// with enough alphanumeric content to be a real sentence. Cancelled PTY
	// runs can have many leading lines that are pure control codes / banners.
	let cleaned = '';
	for (const line of raw.split('\n')) {
		const c = stripTerminalNoise(line);
		if (alphaWordCount(c) >= MIN_ALPHA_WORDS_FOR_USEFUL_LINE) {
			cleaned = c.slice(0, EXCERPT_MAX);
			break;
		}
	}
	const tag = status === 'success' ? '' : ` [${status}]`;
	return cleaned ? `[${agentId}${tag}] ${cleaned}` : `[${agentId}${tag}] (no useful output)`;
}

// Patterns the chat-trailer parser splits on. The Phase 1 output-shape spec
// asks chat-dispatchable agents to end their stdout with a literal
// `---CHAT---` marker followed by a short summary. Until Phase 3 ships,
// only some agents emit it; we fall back to whole-output cleaning for the
// rest. Marker check is exact-line + case-sensitive to keep false-positive
// rate near zero (vault notes occasionally contain `---` separators).
//
// 2026-05-06 hardening: when an agent echoes its own system prompt (e.g.
// because it stopped to ask for clarification rather than producing real
// output), the prompt's EXAMPLE trailer was getting picked up as if it
// were the agent's actual trailer — leaking the example body + the
// surrounding rule prose into the chat reply. Two guards: (a) ignore
// any `---CHAT---` line inside a fenced code block, (b) prefer the LAST
// surviving occurrence (the real trailer is always at the end).
const CHAT_TRAILER_RE = /^[ \t]*---CHAT---[ \t]*$/gm;
const CODE_FENCE_BLOCK_RE = /```[\s\S]*?```/g;

// Dispatcher-metadata lines the agent emits inside its trailer for the
// dispatcher to consume — `Saved to:` (vault path → URL), `PDF:` (artefact
// path → Baileys document attach), `Vault path:` / `Wrote to:` (legacy
// aliases). Already harvested upstream by `extractVaultPath` and
// `extractMediaArtefacts`, which scan the FULL `result.output` independently
// of trailer slicing — stripping them from the user-facing trailer body
// keeps captions clean.
const TRAILER_METADATA_LINE_RE =
	/^[ \t]*(?:Saved\s*to|Vault\s*path|Wrote\s*to|PDF(?:\s*\([^)]*\))?)\s*:\s*\S.*$/gim;

interface TrailerSplit {
	body: string;
	matched: boolean;
}

/** Find the agent's real `---CHAT---` trailer, ignoring any occurrences
 *  inside fenced code blocks (those are typically echoed system-prompt
 *  examples). Returns the body AFTER the last surviving marker, or the
 *  whole output unchanged when no real marker is present. The body has
 *  dispatcher-metadata lines stripped (see TRAILER_METADATA_LINE_RE). */
function splitChatTrailer(output: string): TrailerSplit {
	const masked = output.replace(CODE_FENCE_BLOCK_RE, (block) =>
		// Replace fence content with same-length spaces so line offsets stay
		// aligned. We only need to defeat the regex inside fences.
		block.replace(/[^\n]/g, ' '),
	);
	let lastIdx = -1;
	let lastLen = 0;
	let m: RegExpExecArray | null;
	while ((m = CHAT_TRAILER_RE.exec(masked)) !== null) {
		lastIdx = m.index;
		lastLen = m[0].length;
	}
	CHAT_TRAILER_RE.lastIndex = 0;
	if (lastIdx < 0) return { body: output, matched: false };
	const rawBody = output.slice(lastIdx + lastLen);
	return { body: rawBody.replace(TRAILER_METADATA_LINE_RE, '').trimEnd(), matched: true };
}

/** Predicate: does this output carry a real `---CHAT---` trailer marker?
 *  Used by the WhatsApp settle path to decide between sending the cleaned
 *  body and suppressing it entirely (when artefacts exist and the agent
 *  forgot the marker, the cleaned body is a leaky transcript dump — better
 *  to attach the file silently than to show that). Mirrors the fence-aware
 *  detection in `splitChatTrailer` so the two stay in sync. */
export function hasChatTrailer(output: string | undefined): boolean {
	if (!output) return false;
	const masked = output.replace(CODE_FENCE_BLOCK_RE, (block) =>
		block.replace(/[^\n]/g, ' '),
	);
	const matched = CHAT_TRAILER_RE.test(masked);
	CHAT_TRAILER_RE.lastIndex = 0;
	return matched;
}

// Heuristic vault-path detection. Three real shapes observed in agent
// outputs: explicit "Saved to: <path>", a bare path like
// "~/vault/<…>.md" or "vault/<…>.md", and an Obsidian wikilink at the end.
// Stops at the first match — agents only report one final landing place.
//
// LABEL form is permissive: once "Saved to:" announces a path, we trust
// the path shape and let the strip chain normalize it (vault-relative
// paths like "knowledge/ai/X.md" are valid and do not need a vault/ prefix).
//
// RAW form requires a recognizable vault prefix to avoid false positives
// in arbitrary prose. The negative lookbehind `(?<!api\/)` skips matches
// inside `/api/vault/notes/...` URLs that agents leak via curl examples
// in their bash output.
const VAULT_LABEL_RE = /(?:Saved to|Vault path|Saved|Wrote to)[:\s]+([^\s`'")]+\.md)/i;
const VAULT_RAW_PATH_RE = /([~]?\/?(?:Users\/[^\s]+\/vault\/|(?<!api\/)vault\/)[^\s`'")]+\.md)/;
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/;

// 2026-05-06: reject paths that are obviously prompt-template placeholders.
// A real-world bug: agent dumped its system prompt frontmatter example which
// contained `<zone>/<…>.md`-style placeholders, the extractor matched the
// wikilink, and the user got a broken Soul Hub URL. Any path containing
// angle-brackets or curly braces is template scaffolding, not a real file.
const PLACEHOLDER_RE = /[<>{}]|…|\.\.\./;

function isPlaceholderPath(path: string): boolean {
	return PLACEHOLDER_RE.test(path);
}

/** Best-effort vault-path extraction from agent output. Returns the relative
 *  path under `~/vault/` so the caller can render a `https://soul-hub…/vault/notes/<path>`
 *  URL. Returns null when nothing plausible is found.
 *
 *  Phase 1.5a uses heuristics; Phase 1.5b will rely on the structured
 *  trailer for guaranteed extraction. */
export function extractVaultPath(output: string | undefined): string | null {
	if (!output) return null;
	const labeled = output.match(VAULT_LABEL_RE);
	const raw = labeled ? labeled[1] : output.match(VAULT_RAW_PATH_RE)?.[1];
	if (raw && !isPlaceholderPath(raw)) {
		// Normalise to vault-relative path. Strip order matters: leading
		// slash strips BEFORE the bare `vault/` strip so that absolute
		// paths like "/vault/notes/X.md" (from a leaky URL match) don't
		// keep their `vault/` prefix.
		return raw
			.replace(/^~\//, '')
			.replace(/^\/Users\/[^/]+\/vault\//, '')
			.replace(/^\/+/, '')
			.replace(/^vault\//, '');
	}
	const wiki = output.match(WIKILINK_RE);
	if (wiki) {
		const target = wiki[1].trim();
		if (isPlaceholderPath(target)) return null;
		// Only accept wikilinks that look like a path (contain "/" or end in
		// .md). Display aliases for entities ([[OpenAI]]) shouldn't get linked.
		if (target.includes('/') || /\.md$/i.test(target)) {
			return target.replace(/\.md$/i, '') + '.md';
		}
	}
	return null;
}

/** Multi-line cleaner for chat replies. Strips ANSI/box noise per line,
 *  drops banner-y lines (require ≥3 alphabetic words to keep), collapses
 *  internal whitespace, caps total length. Used in the WhatsApp settle
 *  path so the user sees prose instead of a TUI dump.
 *
 *  Trailer-aware: if the agent emitted a `---CHAT---` marker, only the
 *  body below the marker is returned (the long-form report stays in the
 *  vault note as planned in Phase 1.5b). When no marker is present we
 *  clean the whole output. */
export function cleanAgentOutputForChat(output: string | undefined, maxLen = 3500): string {
	if (!output || !output.trim()) return '';
	const split = splitChatTrailer(output);
	let source = split.body;
	// Truncate at the first sign of system-prompt echo. The agent has clearly
	// run out of real work to report by that point; everything below is
	// scaffolding leaking through.
	const echoIdx = firstPromptEchoIndex(source);
	if (echoIdx > 0) source = source.slice(0, echoIdx);

	const kept: string[] = [];
	for (const line of source.split('\n')) {
		const c = line.replace(ANSI_RE, '').replace(BOX_DRAW_RE, '').trimEnd();
		// Drop pure-whitespace and banner-y leftovers, but keep blank-line
		// separators between paragraphs (max one blank in a row).
		if (!c.trim()) {
			if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
			continue;
		}
		if (alphaWordCount(c) < MIN_ALPHA_WORDS_FOR_USEFUL_LINE) continue;
		if (looksLikeClaudeCodeBanner(c)) continue;
		kept.push(c.replace(/\s+/g, ' ').trim());
	}
	// Strip a possible trailing blank.
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

	const joined = kept.join('\n');
	if (joined.length <= maxLen) return joined;
	return joined.slice(0, maxLen - 1).trimEnd() + '…';
}
