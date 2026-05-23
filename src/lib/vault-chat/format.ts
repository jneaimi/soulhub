/** Formatter — turns the top-K hydrated notes into a markdown context
 *  block the chat LLM can read. Hard-caps total bytes so we don't blow
 *  the model's input budget on a single retrieval. */

import type { HydratedNote } from './retrieval.js';

const MAX_CONTEXT_BYTES = 4000; // ~1000 tokens of context max
const PER_NOTE_BUDGET_OVERVIEW = 500; // multi-note overview — short excerpts
const PER_NOTE_BUDGET_FOCUS = 3000; // single-note focus — almost-full body for analysis intent
/** Switch to "focus" mode when the selector retrieved 1–2 notes — that's a
 *  strong signal the user wants depth on a specific note (e.g. "analyze the
 *  latest draft") rather than a list scan. Multi-note retrievals stay in
 *  short-excerpt mode so a wide query doesn't burn the entire budget on
 *  the first result. */
const FOCUS_MAX_NOTES = 2;

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';

/** Build the dashboard deep-link for a vault note. Goes through the same
 *  `?note=&view=note` query the `/vault` page parses on init, so a click
 *  lands directly on the note view. */
function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}

function tightExcerpt(body: string, budget: number): string {
	const trimmed = body.trim();
	if (trimmed.length <= budget) return trimmed;
	// Prefer cutting on a paragraph boundary if one falls in the back half
	// of the budget — keeps the excerpt readable rather than chopped mid-word.
	const window = trimmed.slice(0, budget);
	const para = window.lastIndexOf('\n\n');
	const cutoff = para > budget * 0.5 ? para : budget;
	return window.slice(0, cutoff).trimEnd() + '…';
}

function formatNote(note: HydratedNote, idx: number, budget: number): string {
	const meta: string[] = [];
	if (note.type) meta.push(`type: ${note.type}`);
	if (note.project) meta.push(`project: ${note.project}`);
	if (note.tags && note.tags.length) meta.push(`tags: ${note.tags.slice(0, 5).join(', ')}`);
	if (note.updated) meta.push(`updated: ${note.updated}`);
	else if (note.created) meta.push(`created: ${note.created}`);

	const header = `### ${idx + 1}. ${note.title}`;
	const path = `_path: \`${note.path}\` · via ${note.source}_`;
	const open = `_open: ${noteOpenUrl(note.path)}_`;
	const metaLine = meta.length ? `- ${meta.join(' · ')}` : '';
	const fixedSize = header.length + path.length + open.length + metaLine.length + 8; // newlines
	const bodyBudget = Math.max(80, budget - fixedSize);
	const excerpt = tightExcerpt(note.body, bodyBudget);

	return [header, metaLine, path, open, '', excerpt].filter(Boolean).join('\n');
}

/** Detect "I want to discuss/analyze the top result" intent in the user
 *  message. Same regex family as router.ts's analysis-intent disqualifier
 *  — kept duplicated here (rather than imported) so format.ts has no
 *  dependency on the WhatsApp channel module. Two regex hits is the
 *  rule, not one. */
function hasAnalysisIntent(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		/\b(analy[sz]e|analy[sz]ing|critique|evaluate|assess|review)\b/.test(lower) ||
		/\bhow\s+(?:does|do|is)\b/.test(lower) ||
		/\bwhat\s+do\s+you\s+(?:think|make)\b/.test(lower)
	);
}

export function formatContextBlock(notes: HydratedNote[], userMessage?: string): string {
	if (notes.length === 0) return '';

	// Focus mode triggers on EITHER signal: a small retrieval (selector
	// already narrowed to 1–2 notes) OR an explicit analysis-intent in the
	// user message (e.g. "analyze the latest draft" — the selector may
	// over-retrieve, but the user's intent is depth on the top result).
	// In focus mode, the top result gets a near-full body, downstream
	// notes still get short excerpts for cross-reference.
	const focus =
		notes.length <= FOCUS_MAX_NOTES ||
		(userMessage !== undefined && hasAnalysisIntent(userMessage));

	const blocks: string[] = [];
	let used = 0;
	for (let i = 0; i < notes.length; i++) {
		const remaining = MAX_CONTEXT_BYTES - used;
		if (remaining < 200) break;
		const budget = Math.min(
			focus && i === 0 ? PER_NOTE_BUDGET_FOCUS : PER_NOTE_BUDGET_OVERVIEW,
			remaining,
		);
		const block = formatNote(notes[i], i, budget);
		blocks.push(block);
		used += block.length + 2; // +2 for the joining newlines
	}

	return blocks.join('\n\n');
}

const SYSTEM_PREAMBLE = `You answer questions about the Soul Hub vault using the context below. The context is the top-ranked notes from a lexical search over the vault — title, path, tags, an open URL, and an excerpt of each note's body.

Rules:
- Ground every claim in the context. If something isn't in it, say "I don't see that in the vault" rather than guessing.
- When you reference a note, append its open URL on the same line (or right after) so the user can tap it. Format: \`<note title or path> — <url>\`. Use the URL exactly as given in the context's \`open:\` line. WhatsApp does not render markdown links, so put the bare URL inline.
- Be concise. WhatsApp messages must fit comfortably in a phone screen — aim for a short paragraph or a tight bullet list, not a full report.
- If the context is empty or irrelevant, say so honestly and suggest the user refine the question (mention a project, a tag, or a date).
- **You cannot save notes.** If the user asks you to save / capture / remember something, do not pretend to do it. Discuss the idea with them, then tell them to send \`/save <text>\` (or \`/save\` as the caption on an image/voice/video) when they're ready to capture it. The same applies to attachments: ask what they want to do with the image/voice/video; only \`/save\` writes to the vault.
- **When the user asks about "the latest"/"the newest"/"my latest" something and the context contains exactly ONE note in focus mode, treat that note AS the one they mean.** Don't ask for clarification — the retrieval already narrowed to the most recently modified match. Just analyze/discuss it directly.
- Reply in the same language the user wrote in (English or Arabic).`;

/** Render a "Current time anchor" block prepended to vault-chat system
 *  prompts. Without this the model hallucinates "today" / "last week" /
 *  "this month" when the user asks date-relative questions about their
 *  notes. Notes carry their own `created:` frontmatter; the anchor lets
 *  the model compute relative ranges against those dates. Same fix
 *  pattern as orchestrator-v2 system-prompt.ts and heartbeat.ts. */
function timeAnchorBlock(timezone: string = 'Asia/Dubai'): string {
	const now = new Date();
	const localNow = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(now);
	return [
		'## Current time anchor',
		`- User's local time: **${localNow}** (timezone: ${timezone})`,
		`- UTC now: ${now.toISOString()}`,
		'- Use these as ground truth for "today", "yesterday", "last week", "this month", weekday names, etc.',
		'- Compute date-relative ranges against this anchor when filtering or summarizing notes.',
	].join('\n');
}

export function buildSystemPrompt(contextBlock: string, timezone?: string): string {
	const anchor = timeAnchorBlock(timezone);
	if (!contextBlock) {
		return `${anchor}\n\n${SYSTEM_PREAMBLE}\n\n## Vault Context\n\n_(no relevant notes found — answer honestly that nothing matched)_`;
	}
	return `${anchor}\n\n${SYSTEM_PREAMBLE}\n\n## Vault Context\n\n${contextBlock}`;
}

const MULTIMODAL_PREAMBLE = `You're chatting with the user over WhatsApp. They've attached an image, video, or document and want to discuss it. The vault context below is supporting material — facts about their projects, decisions, and prior notes — to ground the conversation when relevant.

Rules:
- **Look at the attachment.** Describe what you see, answer questions about it, and engage with what the user actually sent. Don't refuse to look at the image or fall back to "I can only answer from text context".
- **Use the vault context when relevant.** If the attachment relates to something in their vault (a project, a prior decision, an earlier draft), call that out and link the note with its open URL — same format as the text-only flow.
- When you reference a vault note, append its open URL inline. Format: \`<note title or path> — <url>\`. Use the URL exactly as given in the context's \`open:\` line. WhatsApp does not render markdown links — put the bare URL inline.
- Be concise. WhatsApp messages must fit comfortably in a phone screen.
- **You cannot save notes.** If the user wants to capture this attachment to the vault, tell them to send \`/save\` as the caption on the image (or as a follow-up message). Discussion is your job; saving is theirs.
- Reply in the same language the user wrote in (English or Arabic).`;

/** Build the system prompt for the multimodal vault-chat path (image /
 *  video / document attached). Distinct from `buildSystemPrompt` because
 *  the text-only rule "ground every claim in the context" reads, in the
 *  multimodal case, as "refuse to look at the image" — which is what
 *  the model literally did until this branch landed. */
export function buildMultimodalSystemPrompt(contextBlock: string, timezone?: string): string {
	const anchor = timeAnchorBlock(timezone);
	if (!contextBlock) {
		return `${anchor}\n\n${MULTIMODAL_PREAMBLE}\n\n## Vault Context\n\n_(no relevant notes found — engage with the attachment directly)_`;
	}
	return `${anchor}\n\n${MULTIMODAL_PREAMBLE}\n\n## Vault Context\n\n${contextBlock}`;
}
