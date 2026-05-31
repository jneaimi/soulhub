/** Evaluate Session — AI-led, hand-held facilitation of the implementation-mode
 *  "Evaluate" scenario for the SME-Led AI Adoption program.
 *
 *  The IP (the scenario script + the facilitation discipline) lives here,
 *  server-side. The thin standalone app (`~/dev/evaluate-session-app`) is a
 *  dumb chat shell that proxies to `POST /api/evaluate-session`; it holds no
 *  scenario text. See `projects/coffee-ops-sandiego/2026-05-26-evaluate-app-arch.md`.
 *
 *  Flow: the model runs the scenario one move at a time, never answering the
 *  evaluative questions for the SME. When the session reaches a filter verdict
 *  it emits a BRIEF marker + JSON; we parse it and write a use-case brief into
 *  the project — zone HARDCODED below so conversation content can never steer
 *  the write to an arbitrary vault path (path-injection guard). */

import { getVaultEngine } from '$lib/vault/index.js';
import { getAvailableChatProviders } from '$lib/llm/registry.js';
import type { ChatMessage, ChatProvider } from '$lib/llm/types.js';
import type { CreateNoteRequest, VaultMeta } from '$lib/vault/types.js';

/** Single source of truth for the scenario script (the IP). */
const SCENARIO_PATH = 'projects/coffee-ops-sandiego/2026-05-26-evaluate-scenario.md';
/** Fallback project when the session carries no validated project (legacy
 *  text-turn path, or a webhook whose dynamic-variable project failed the
 *  allow-list). The brief-zone is ALWAYS `projects/<project>/sessions` where
 *  `<project>` is a validated slug — never raw conversation input. The
 *  caller (post-call route) is responsible for validation; writeBrief trusts
 *  the slug it is handed. */
const DEFAULT_PROJECT = 'coffee-ops-sandiego';
const MAX_TOKENS = 1200;
const BRIEF_MARKER = '<<<BRIEF>>>';

/** Per-session conversation history. In-memory by design for v0.1 — sessions
 *  are short, low-volume, and operator-driven; no persistence needed yet. */
const histories = new Map<string, ChatMessage[]>();

/** ADR-008 P2 — in-memory pending preview map, keyed by transcript stem.
 *  Populated by the post-call webhook after the analyst returns; consumed
 *  by GET /api/evaluate-session/preview. Per-session, ephemeral; rebuilt
 *  on each post-call. */
export const pendingPreview = new Map<string, Brief>();

/** ADR-004 P2 / ADR-006 P1 — companion map to pendingPreview, holding the
 *  verbatim SME transcript turns from the webhook payload. Lets the action
 *  endpoint re-run the verbatim-anchor gate on amend without depending on
 *  the persisted transcript file (which can be absent or shape-shifted by
 *  zone governance). Keyed by the same stem; cleared on accept / back-to-
 *  draft alongside pendingPreview. */
export interface PersistedTurn {
	role: 'agent' | 'user';
	message: string;
	/** ADR-012 — ElevenLabs marks an agent turn `interrupted` when the user (or
	 *  bleed/noise) barged in. A short USER turn right after an interrupted agent
	 *  turn is the barge-in/echo phantom signature; carried through so the phantom
	 *  filter can use it. Optional for back-compat with callers that don't set it. */
	interrupted?: boolean;
}
export const pendingTranscript = new Map<string, PersistedTurn[]>();

/** Companion map remembering the on-disk path of the brief note that the
 *  post-call webhook wrote, keyed by session stem. Lets the SME accept /
 *  back-to-draft / amend handlers re-write the same note via updateNote
 *  instead of bouncing off createNote's already-exists guard. Cleared by
 *  the terminal handlers alongside pendingPreview + pendingTranscript. */
export const pendingBriefPath = new Map<string, string>();

export interface Brief {
	title?: string;
	problem_statement?: string;
	roi_baseline?: string;
	roi_target?: string;
	scope_ai?: string;
	scope_human?: string;
	success_markers?: string;
	risks?: string;
	pull_out_trigger?: string;
	verdict?: string;
	verdict_reason?: string;
	/** ADR-004 P2 — analyst gate failures attached when looksConcrete /
	 *  verbatim-anchor / banned-lexicon gates flag the brief. Drives the
	 *  preview UI's "back-to-draft because X" surfacing. */
	gate_failures?: Array<{
		rule: string;
		severity: 'high' | 'medium';
		field?: string;
		message: string;
	}>;
}

export interface EvaluateTurnResult {
	ok: boolean;
	text: string;
	done: boolean;
	briefPath?: string;
	error?: string;
}

/** Prefer Anthropic (strongest at holding the "never answer for the SME"
 *  discipline), then OpenRouter, then Gemini, then whatever has a key. */
function pickProvider(): ChatProvider | null {
	const avail = getAvailableChatProviders();
	if (avail.length === 0) return null;
	for (const id of ['anthropic', 'openrouter', 'gemini']) {
		const p = avail.find((x) => x.id === id);
		if (p) return p;
	}
	return avail[0];
}

function buildSystemPrompt(scenarioBody: string): string {
	return [
		'You are the facilitator running a live, hand-held "Evaluate" session with a single SME — a business owner or practitioner — over chat. You run it ONE focused move at a time.',
		'',
		'THE IRON RULE: never answer the evaluative questions for the SME. Ask, reflect back what you heard, probe, then wait. If they try to make you answer ("what would you do?", "just tell me"), turn it back to them warmly. The entire value of this session is that the problem statement ends up being THEIRS, in their words. Breaking this rule fails the session even if the output looks complete.',
		'',
		'Conduct: ask a single question or give one short prompt, then STOP and wait for their reply. Never dump the whole script or multiple phases at once. Keep every message short and conversational. Move through the phases in order. Open warmly and briefly.',
		'',
		'COMPLETION PROTOCOL: when — and ONLY when — you have genuinely completed all phases and reached a filter verdict (candidate or back-to-draft), write a short closing line to the SME, then on a new line output the marker below, then on the next line a SINGLE-LINE JSON object with the brief. Never output the marker before the session is truly complete. Fill every field from the SME\'s own answers; leave a field "" only if it never came up.',
		'',
		BRIEF_MARKER,
		'{"title":"","problem_statement":"","roi_baseline":"","roi_target":"","scope_ai":"","scope_human":"","success_markers":"","risks":"","pull_out_trigger":"","verdict":"candidate","verdict_reason":""}',
		'',
		'--- THE SCENARIO YOU ARE RUNNING (your facilitation script) ---',
		'',
		scenarioBody,
	].join('\n');
}

/** Pull the first balanced-looking JSON object out of a string. */
function extractJson(raw: string): string {
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return raw;
	return raw.slice(start, end + 1);
}

function val(s: string | undefined): string {
	const t = (s ?? '').trim();
	return t.length > 0 ? t : '_(not captured in session)_';
}

function buildBriefMarkdown(date: string, sessionKey: string, brief: Brief, project: string): string {
	const title = (brief.title ?? '').trim() || 'Untitled use-case';
	const roi = `${val(brief.roi_baseline)} → ${val(brief.roi_target)}`;
	const verdict = (brief.verdict ?? '').trim() || 'back-to-draft';
	return [
		`# Use-Case Brief — ${title}`,
		'',
		'## Pipeline Context',
		'',
		`- **SME / tester:** ${sessionKey}`,
		`- **Session date:** ${date}`,
		`- **Project:** [[${project}/index]] — scenario owned by the Evaluate Session app (ADR-011)`,
		'- **Produced by:** Evaluate Session app (automated capture from the live session)',
		'',
		'## Output',
		'',
		`**Problem statement (SME's words):** ${val(brief.problem_statement)}`,
		'',
		`**ROI baseline → target:** ${roi}`,
		'',
		`**Scope — AI may own:** ${val(brief.scope_ai)}`,
		'',
		`**Scope — stays human (L3/L4):** ${val(brief.scope_human)}`,
		'',
		`**Success markers:** ${val(brief.success_markers)}`,
		'',
		`**Risks + pull-out trigger:** ${val(brief.risks)} / ${val(brief.pull_out_trigger)}`,
		'',
		`**Filter verdict:** \`${verdict}\` — ${val(brief.verdict_reason)}`,
		'',
	].join('\n');
}

export async function writeBrief(
	sessionKey: string,
	brief: Brief,
	project: string = DEFAULT_PROJECT,
): Promise<string | null> {
	const engine = getVaultEngine();
	if (!engine) return null;
	// Brief-zone is derived from the (already-validated) project slug. The
	// post-call route validates against the project allow-list before handing
	// the slug here; the legacy text path uses DEFAULT_PROJECT.
	const briefZone = `projects/${project}/sessions`;
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
	const safeKey =
		sessionKey
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'session';
	const filename = `${date}-${safeKey}-${hhmm}.md`;
	const verdictTag = (brief.verdict ?? '').trim() === 'candidate' ? 'candidate' : 'back-to-draft';

	// SME stamp fields land in frontmatter when the action handler stamps the
	// brief on accept / back-to-draft, so a future reader of the disk note can
	// tell at a glance the verdict was operator-confirmed and how many amends
	// the SME applied. Read via assertion to keep the public Brief surface clean.
	const stamp = brief as Brief & {
		sme_confirmed?: boolean;
		sme_confirmed_at?: string;
		sme_amendments_count?: number;
	};

	const meta: Record<string, unknown> = {
		type: 'output',
		status: 'proposed',
		created: date,
		project,
		tags: [
			project,
			'sme-led-ai-adoption',
			'evaluate-session',
			'use-case-brief',
			verdictTag,
		],
		relates_to: `[[${project}/index]]`,
		source_agent: 'evaluate-session-app',
		source_context: `Evaluate session brief for "${sessionKey}" (${date})`,
	};
	if (typeof stamp.sme_confirmed === 'boolean') meta.sme_confirmed = stamp.sme_confirmed;
	if (typeof stamp.sme_confirmed_at === 'string') meta.sme_confirmed_at = stamp.sme_confirmed_at;
	if (typeof stamp.sme_amendments_count === 'number') meta.sme_amendments_count = stamp.sme_amendments_count;

	const content = buildBriefMarkdown(date, sessionKey, brief, project);
	const audit = { actor: 'evaluate-session-app', actorContext: `session:${sessionKey}` };

	// Update-or-create: the post-call webhook writes the analyst's initial
	// brief, then the SME action handler (accept / amend / back-to-draft)
	// re-writes the same note with stamp fields. Without the cache, the
	// second write hits createNote's already-exists guard and silently
	// returns null, leaving stale frontmatter on disk.
	const cachedPath = pendingBriefPath.get(sessionKey);
	if (cachedPath) {
		const upd = await engine.updateNote(cachedPath, { meta: meta as VaultMeta, content }, audit);
		if ('success' in upd && upd.success === false) return null;
		return cachedPath;
	}

	const req: CreateNoteRequest = {
		zone: briefZone,
		filename,
		meta: meta as VaultMeta,
		content,
	};
	const res = await engine.createNote(req, audit);
	if ('success' in res && res.success === false) return null;
	const path = 'path' in res && typeof res.path === 'string' ? res.path : `${briefZone}/${filename}`;
	pendingBriefPath.set(sessionKey, path);
	return path;
}

/** Run one conversational turn of the Evaluate session. */
export async function runEvaluateTurn(
	sessionKey: string,
	message: string,
): Promise<EvaluateTurnResult> {
	const key = sessionKey.trim();
	if (!key) return { ok: false, text: '', done: false, error: 'Missing sessionKey' };
	const msg = message.trim();
	if (!msg) return { ok: false, text: '', done: false, error: 'Missing message' };

	if (/^\/?(reset|restart)$/i.test(msg)) {
		histories.delete(key);
		return {
			ok: true,
			text: "Fresh start. When you're ready, tell me a bit about your operation and what's been on your mind — and we'll begin.",
			done: false,
		};
	}

	const engine = getVaultEngine();
	if (!engine) return { ok: false, text: '', done: false, error: 'Vault not initialized' };
	const scenario = engine.getNote(SCENARIO_PATH);
	if (!scenario) {
		return { ok: false, text: '', done: false, error: `Scenario not found: ${SCENARIO_PATH}` };
	}

	const provider = pickProvider();
	if (!provider) {
		return {
			ok: false,
			text: '',
			done: false,
			error: 'No chat provider available — set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY.',
		};
	}

	const history = histories.get(key) ?? [];
	const messages: ChatMessage[] = [...history, { role: 'user', content: msg }];

	let resultText: string;
	try {
		const out = await provider.generate({
			system: buildSystemPrompt(scenario.content),
			messages,
			maxOutputTokens: MAX_TOKENS,
		});
		resultText = out.text ?? '';
	} catch (err) {
		return {
			ok: false,
			text: '',
			done: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// Persist the round-trip so the next turn carries context.
	histories.set(key, [...messages, { role: 'assistant', content: resultText }]);

	const markerIdx = resultText.indexOf(BRIEF_MARKER);
	if (markerIdx === -1) {
		return { ok: true, text: resultText, done: false };
	}

	const closing = resultText.slice(0, markerIdx).trim();
	const jsonPart = resultText.slice(markerIdx + BRIEF_MARKER.length).trim();
	let brief: Brief;
	try {
		brief = JSON.parse(extractJson(jsonPart)) as Brief;
	} catch {
		// Marker present but JSON malformed — show the closing text, don't crash.
		return { ok: true, text: closing || resultText, done: false, error: 'brief parse failed' };
	}

	const briefPath = await writeBrief(key, brief);
	histories.delete(key); // session complete — clear state

	return {
		ok: true,
		text: closing || 'Session complete — your use-case brief has been saved.',
		done: true,
		briefPath: briefPath ?? undefined,
		error: briefPath ? undefined : 'brief write failed',
	};
}
