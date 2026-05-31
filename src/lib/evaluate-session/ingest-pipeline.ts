/** ADR-012 P1 — shared post-call ingestion pipeline.
 *
 *  One code path that turns a finished conversation's transcript into a
 *  persisted use-case brief: persist the verbatim transcript note, run the
 *  Sonnet analyst, apply the ADR-004 gates, route to the customer's project,
 *  and populate the preview state (in-memory + durable mirror) + the vault
 *  brief note.
 *
 *  Two callers share this:
 *    - the NEW app-pull path `POST /api/evaluate-session/ingest` (ADR-012) —
 *      the app pulls the transcript from ElevenLabs and POSTs it here. This is
 *      the primary path.
 *    - the (now-retired, dormant) post-call WEBHOOK route — kept working in
 *      case it is ever re-enabled as a redundant backup.
 *
 *  SECURITY: `project` is validated by `resolveProjectSlug` against the project
 *  allow-list (slug regex + the project must already exist in the vault) before
 *  it can steer the vault write path — never trust raw client/conversation input.
 */

import { getVaultEngine } from '$lib/vault/index.js';
import { getAvailableChatProviders } from '$lib/llm/registry.js';
import type { CreateNoteRequest, VaultMeta } from '$lib/vault/types.js';
import { runAllGates } from '$lib/evaluate-session/analyst-gates.js';
import { savePending } from '$lib/evaluate-session/preview-store.js';
import {
	pendingPreview,
	pendingTranscript,
	writeBrief,
	type Brief,
	type PersistedTurn,
} from '$lib/evaluate-session/index.js';

/** Fallback project when none is supplied or it fails the allow-list. */
const DEFAULT_PROJECT = 'coffee-ops-sandiego';

type Engine = ReturnType<typeof getVaultEngine>;

/** Validate a raw, untrusted project slug against the allow-list. Two gates:
 *  (1) strict slug regex, (2) the project must already exist in the vault
 *  (`projects/<slug>/index.md`). Either failing → DEFAULT_PROJECT. New customers
 *  are onboarded by provisioning the project first — never by client input. */
export function resolveProjectSlug(engine: Engine, raw: unknown): string {
	if (typeof raw !== 'string') return DEFAULT_PROJECT;
	const slug = raw.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return DEFAULT_PROJECT;
	if (!engine || !engine.getNote(`projects/${slug}/index.md`)) return DEFAULT_PROJECT;
	return slug;
}

/** ADR-012 — drop hallucinated / barge-in "user" turns before they reach the
 *  analyst (research note 2026-06-01-elevenlabs-phantom-user-turns-fixes).
 *  ElevenLabs' VAD/ASR can capture the agent's own audio (speaker bleed) or a
 *  cut-off fragment as a USER turn — there is no server-side retraction event,
 *  so we filter the pulled transcript here. Three conservative rules, USER turns
 *  only (agent turns are never dropped):
 *
 *    1. BARGE-IN PHANTOM (primary, validated on conv_7401): a SHORT user turn
 *       (<=10 content-ish words) whose immediately-preceding agent turn is
 *       `interrupted: true`. On the failing session this cleanly separated both
 *       phantoms ("What do you mean by change?", "Right. So you don't...") from
 *       all six real turns (every real turn followed a non-interrupted agent
 *       turn). The length cap protects genuine long interruptions.
 *    2. STOCK HALLUCINATION: a lone filler/farewell phrase ("thank you", "see
 *       you", "bye", "okay", "thanks") — the classic silence artifact.
 *    3. ECHO-OF-AGENT: a short user turn with >=60% word-overlap with the prior
 *       agent turn (the agent's question transcribed back), as a backstop when
 *       the `interrupted` flag is absent (older callers).
 *
 *  We log every drop so silent over-filtering is visible in the server log. */
const STOCK_HALLUCINATIONS = new Set([
	'thank you', 'thanks', 'thank you.', 'thanks.', 'see you', 'see you.',
	'bye', 'bye.', 'goodbye', 'goodbye.', 'okay', 'okay.', 'ok', 'ok.', 'yeah', 'mhm',
]);

function wordCount(s: string): number {
	return s.trim().split(/\s+/).filter(Boolean).length;
}

function wordSet(s: string): Set<string> {
	return new Set(
		s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
	);
}

/** Fraction of a's content words also present in b. */
function overlapFraction(a: string, b: string): number {
	const wa = wordSet(a);
	if (wa.size === 0) return 0;
	const wb = wordSet(b);
	let hit = 0;
	for (const w of wa) if (wb.has(w)) hit++;
	return hit / wa.size;
}

export interface PhantomFilterResult {
	clean: PersistedTurn[];
	dropped: Array<{ index: number; message: string; reason: string }>;
}

export function filterPhantomTurns(turns: PersistedTurn[]): PhantomFilterResult {
	const clean: PersistedTurn[] = [];
	const dropped: PhantomFilterResult['dropped'] = [];
	let lastAgent: PersistedTurn | null = null;
	for (let i = 0; i < turns.length; i++) {
		const t = turns[i];
		if (t.role !== 'user') {
			clean.push(t);
			if (t.role === 'agent') lastAgent = t;
			continue;
		}
		const msg = (t.message ?? '').trim();
		const norm = msg.toLowerCase();
		// 1. barge-in phantom: short user turn right after an interrupted agent turn.
		if (lastAgent?.interrupted === true && wordCount(msg) <= 10) {
			dropped.push({ index: i, message: msg, reason: 'barge-in-after-interrupt' });
			continue;
		}
		// 2. stock silence-hallucination phrase, standing alone.
		if (STOCK_HALLUCINATIONS.has(norm)) {
			dropped.push({ index: i, message: msg, reason: 'stock-hallucination' });
			continue;
		}
		// 3. echo-of-agent backstop (when interrupted flag is unavailable).
		if (lastAgent && wordSet(msg).size <= 12 && overlapFraction(msg, lastAgent.message) >= 0.6) {
			dropped.push({ index: i, message: msg, reason: 'echo-of-agent' });
			continue;
		}
		clean.push(t);
	}
	return { clean, dropped };
}

export function transcriptToMarkdown(
	turns: PersistedTurn[],
	conversationId: string,
	date: string,
): string {
	return [
		'# Evaluate Session Transcript',
		'',
		`- **Conversation ID:** ${conversationId}`,
		`- **Date:** ${date}`,
		'- **Source:** ElevenLabs Hosted Agent (ADR-008 / ADR-012 pull)',
		'',
		'## Transcript',
		'',
		...turns.flatMap((t) => [`**${t.role === 'agent' ? 'Guide' : 'SME'}:** ${t.message}`, '']),
	].join('\n');
}

function buildBriefExtractionPrompt(transcriptText: string): string {
	return [
		'You are a post-call analyst. From this verbatim SME interview transcript, produce ONE structured use-case brief that a non-technical business owner could read and SIGN. Write it FOR the SME, in plain, warm, concrete business language.',
		'',
		'Output ONLY a single-line JSON object with exactly these keys:',
		'{"title":"","problem_statement":"","roi_baseline":"","roi_target":"","scope_ai":"","scope_human":"","success_markers":"","risks":"","pull_out_trigger":"","verdict":"candidate","verdict_reason":""}',
		'',
		'HOW TO WRITE EACH FIELD — synthesize in your own plain words; do NOT paste long verbatim quotes into fields. (The ONLY field that must carry a single-quoted SME phrase is verdict_reason; problem_statement MAY include one short anchoring quote.)',
		'',
		'- title: a short, specific name for the use-case (e.g., "CV-screening assistant for barista hiring"). NOT "SME Interview: <name>".',
		'- problem_statement: the ONE problem in 1-2 sentences — what is painful, how often, roughly how costly — grounded in what the SME said.',
		'- roi_baseline: the current measurable state, with a number + unit if the SME gave one (e.g., "~4 hours/week filtering CVs"). If no number, state the qualitative baseline plainly.',
		'- roi_target: the target the SME wants, as a NUMBER if they gave one (e.g., "under 1 hour/week"). If the SME did NOT give a target number, write EXACTLY: "Target not set in session — confirm before build." Never invent a number; never pad with a quote about "saving time".',
		'- scope_ai: what the assistant would do — job-relevant, checkable work the human reviews — in plain language (no tool-spec jargon).',
		'- scope_human: what stays the human\'s decision and judgment.',
		'- success_markers: a MEASURABLE outcome proving it worked (e.g., "screening time drops from ~4h to under 1h/week within 6 weeks and shortlist quality holds"). NOT a restatement of the problem.',
		'- risks: what could go wrong or mislead. If the session never surfaced risks, write EXACTLY: "Not captured in session — to be defined before build."',
		'- pull_out_trigger: the SPECIFIC condition that would tell the SME to STOP using it — a trip-wire, NOT the baseline metric. It MUST name a number (digits) OR a duration (week/month/cycle/by/within) OR an observable event (customer/complaint/refund/miss/hire). Example: "If after 4 weeks screening still takes more than 2 hours a week, stop." If the SME never gave a trip-wire, write EXACTLY: "No trip-wire set in session." Do NOT reuse the baseline number as the trigger, and do NOT invent one to look complete.',
		'',
		'ANTI-DISCRIMINATION GUARDRAIL (mandatory): no field — especially scope_ai — may propose screening, scoring, ranking, or filtering people on age, weight, body size, physical appearance/"fitness", gender, race, nationality, religion, marital or family status, disability, or health. If the SME named any of these as hiring criteria, EXCLUDE them and instead describe job-relevant, checkable, lawful criteria (equipment proficiency, tenure in past roles, availability, relevant experience). Do not echo the protected attributes anywhere in the brief.',
		'',
		'VERDICT — be honest, do not game it:',
		'- "candidate" ONLY if there is a real specific problem AND a measurable baseline AND a concrete pull-out trigger.',
		'- "back-to-draft" if any of those is missing (no trip-wire, no baseline number, vague problem). An honest "back-to-draft" is the correct, valuable outcome — never fabricate a field just to reach "candidate".',
		'- verdict_reason: 1-2 sentences that MUST contain at least one phrase the SME literally said, in straight \'single quotes\', matching an SME turn word-for-word (case/whitespace ignored). State plainly why it is a candidate, or exactly what is missing for back-to-draft.',
		'',
		'FORBIDDEN WORDS (rejected in any field): "leveraging", "optimizing", "enabling", "facilitating", "automating <X>", "structured data extraction", "quantifying <X>", "stakeholders", "governance", "compliance with", "best practices", "significant", "substantial", "approximately", "multiple", "various". Use the SME\'s plain register.',
		'',
		'--- TRANSCRIPT ---',
		'',
		transcriptText,
	].join('\n');
}

export interface IngestResult {
	ok: boolean;
	brief?: Brief;
	briefPath?: string | null;
	project: string;
	error?: string;
}

/** Turn a finished transcript into a persisted, gated, routed brief.
 *
 *  `project` is the (untrusted) slug from the conversation's dynamic variables;
 *  it is re-validated here. `source` labels the audit trail ('pull' | 'webhook').
 *  Returns the brief + its vault path, or an error result. */
export async function ingestTranscript(params: {
	conversationId: string;
	transcript: PersistedTurn[];
	project?: string;
	source?: string;
}): Promise<IngestResult> {
	const { conversationId, transcript: rawTranscript } = params;
	const source = params.source ?? 'pull';
	const engine = getVaultEngine();
	const project = resolveProjectSlug(engine, params.project);

	if (!Array.isArray(rawTranscript) || rawTranscript.length === 0) {
		return { ok: false, project, error: 'Empty transcript' };
	}

	// ADR-012 — strip phantom/echo user turns before anything downstream sees
	// them (transcript note, analyst, gates, preview). See filterPhantomTurns.
	const { clean: transcript, dropped } = filterPhantomTurns(rawTranscript);
	if (dropped.length > 0) {
		console.warn(
			`[evaluate-session/ingest] conv:${conversationId} dropped ${dropped.length} phantom turn(s): ` +
				dropped.map((d) => `[${d.reason}] ${JSON.stringify(d.message.slice(0, 40))}`).join(' '),
		);
	}

	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
	const safeId = conversationId.replace(/[^a-z0-9-]/gi, '-').slice(0, 30);
	const stem = `${date}-${safeId}-${hhmm}`;
	const briefZone = `projects/${project}/sessions`;

	// Persist the verbatim transcript note (satisfies ADR-005). Best-effort —
	// a brief can still be produced even if this write is refused.
	if (engine) {
		const req: CreateNoteRequest = {
			zone: briefZone,
			filename: `${stem}.transcript.md`,
			meta: {
				type: 'transcript',
				status: 'raw',
				created: date,
				project,
				tags: [project, 'evaluate-session', 'voice-transcript', 'adr-012'],
				source_agent: 'elevenlabs-agent',
				source_context: `ElevenLabs conversation ${conversationId} (${source})`,
			} as VaultMeta,
			content: transcriptToMarkdown(transcript, conversationId, date),
		};
		await engine
			.createNote(req, { actor: 'evaluate-session-ingest', actorContext: `conv:${conversationId}` })
			.catch(() => undefined);
	}

	const provider =
		getAvailableChatProviders().find((p) => p.id === 'anthropic') ??
		getAvailableChatProviders()[0];
	if (!provider) {
		return { ok: false, project, error: 'No chat provider available' };
	}

	const transcriptText = transcript
		.map((t) => `${t.role === 'agent' ? 'Guide' : 'SME'}: ${t.message}`)
		.join('\n');

	let brief: Brief;
	try {
		const out = await provider.generate({
			system: 'You are a structured data extractor. Output only valid JSON.',
			messages: [{ role: 'user', content: buildBriefExtractionPrompt(transcriptText) }],
			maxOutputTokens: 800,
		});
		const text = out.text ?? '';
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start === -1 || end <= start) {
			return { ok: false, project, error: 'Analyst returned no JSON object' };
		}
		brief = JSON.parse(text.slice(start, end + 1)) as Brief;
	} catch (err) {
		return { ok: false, project, error: err instanceof Error ? err.message : 'Analyst failed' };
	}

	// ADR-004 gates. High-severity failures flip the verdict to back-to-draft.
	const gateReport = runAllGates(brief, transcript);
	if (gateReport.findings.length > 0) {
		brief.gate_failures = gateReport.findings.map((f) => ({
			rule: f.rule,
			severity: f.severity,
			field: f.field,
			message: f.message,
		}));
		if (!gateReport.pass) {
			brief.verdict = 'back-to-draft';
			const highReasons = gateReport.findings
				.filter((f) => f.severity === 'high')
				.map((f) => f.message)
				.join(' · ');
			brief.verdict_reason = `${brief.verdict_reason ?? ''}\n\n[gate-failure] ${highReasons}`.trim();
		}
	}

	// Populate preview state: in-memory maps + durable mirror (ADR-009 #1),
	// then write the brief note routed to `project` (ADR-009 #2). Keyed by
	// conversation_id so the app's /preview poll finds it.
	pendingTranscript.set(conversationId, transcript);
	pendingPreview.set(conversationId, brief);
	savePending(conversationId, { brief, transcript, project });
	const briefPath = await writeBrief(conversationId, brief, project);

	return { ok: true, brief, briefPath, project };
}
