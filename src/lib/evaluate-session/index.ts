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
/** Server-hardcoded write target — NOT derived from client/conversation input. */
const BRIEF_ZONE = 'projects/coffee-ops-sandiego/sessions';
const PROJECT = 'coffee-ops-sandiego';
const MAX_TOKENS = 1200;
const BRIEF_MARKER = '<<<BRIEF>>>';

/** Per-session conversation history. In-memory by design for v0.1 — sessions
 *  are short, low-volume, and operator-driven; no persistence needed yet. */
const histories = new Map<string, ChatMessage[]>();

interface Brief {
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

function buildBriefMarkdown(date: string, sessionKey: string, brief: Brief): string {
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
		'- **Scenario:** `[[coffee-ops-sandiego/2026-05-26-evaluate-scenario]]` (draft v0.1)',
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

async function writeBrief(sessionKey: string, brief: Brief): Promise<string | null> {
	const engine = getVaultEngine();
	if (!engine) return null;
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

	const req: CreateNoteRequest = {
		zone: BRIEF_ZONE,
		filename,
		meta: {
			type: 'output',
			status: 'proposed',
			created: date,
			project: PROJECT,
			tags: [
				'coffee-ops-sandiego',
				'sme-led-ai-adoption',
				'evaluate-session',
				'use-case-brief',
				verdictTag,
			],
			relates_to: '[[coffee-ops-sandiego/2026-05-26-evaluate-scenario]]',
			source_agent: 'evaluate-session-app',
			source_context: `Evaluate session brief for "${sessionKey}" (${date})`,
		} as VaultMeta,
		content: buildBriefMarkdown(date, sessionKey, brief),
	};

	const res = await engine.createNote(req, {
		actor: 'evaluate-session-app',
		actorContext: `session:${sessionKey}`,
	});
	if ('success' in res && res.success === false) return null;
	return ('path' in res && typeof res.path === 'string' ? res.path : `${BRIEF_ZONE}/${filename}`);
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
