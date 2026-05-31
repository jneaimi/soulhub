/** ADR-008 P2 — POST /api/evaluate-session/post-call
 *
 *  Soul Hub route that receives ElevenLabs post-call webhooks.
 *  Apply to Soul Hub at: src/routes/api/evaluate-session/post-call/+server.ts
 *
 *  Flow:
 *    1. Verify ElevenLabs HMAC signature (401 on bad sig)
 *    2. Persist verbatim transcript → projects/coffee-ops-sandiego/sessions/<stem>.transcript.md
 *       (satisfies ADR-005 for free)
 *    3. Dispatch Sonnet analyst via claude-pty to extract a structured brief
 *    4. Stash brief in pendingPreview map (read by GET /api/evaluate-session/preview) */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getVaultEngine } from '$lib/vault/index.js';
import { getAvailableChatProviders } from '$lib/llm/registry.js';
import type { CreateNoteRequest, VaultMeta } from '$lib/vault/types.js';
import { pendingPreview, pendingTranscript, writeBrief } from '$lib/evaluate-session/index.js';
import type { Brief } from '$lib/evaluate-session/index.js';
import { runAllGates } from '$lib/evaluate-session/analyst-gates.js';
import { savePending } from '$lib/evaluate-session/preview-store.js';

/** Fallback when the conversation carries no validated project (see
 *  resolveProject). The brief-zone is always `projects/<project>/sessions`. */
const DEFAULT_PROJECT = 'coffee-ops-sandiego';

interface ElevenLabsTurn {
	role: 'agent' | 'user';
	message: string;
	time_in_call_secs?: number;
}

interface ElevenLabsWebhook {
	event_id: string;
	event_timestamp: number;
	type: string;
	data: {
		conversation_id: string;
		agent_id: string;
		status: string;
		transcript: ElevenLabsTurn[];
		analysis?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
		// ADR-009 #2 — the app passes `dynamicVariables: { project }` at
		// startSession; ElevenLabs echoes them back here. This is the ONLY
		// channel by which the project reaches soul-hub (it's off the start
		// path). Treated as untrusted input — validated by resolveProject.
		conversation_initiation_client_data?: {
			dynamic_variables?: Record<string, unknown>;
		};
	};
}

/** Resolve the brief's target project from the webhook's echoed dynamic
 *  variables. SECURITY: this is untrusted, conversation-supplied input — it
 *  MUST NOT be allowed to steer the vault write path (path-injection guard,
 *  see index.ts). Two gates: (1) strict slug regex, (2) the project must
 *  already exist in the vault (`projects/<slug>/index.md`). Anything that
 *  fails either gate falls back to DEFAULT_PROJECT. New customers are onboarded
 *  by provisioning the project in the vault first — never by the webhook. */
function resolveProject(
	engine: ReturnType<typeof getVaultEngine>,
	data: ElevenLabsWebhook['data'],
): string {
	const raw = data.conversation_initiation_client_data?.dynamic_variables?.project;
	if (typeof raw !== 'string') return DEFAULT_PROJECT;
	const slug = raw.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return DEFAULT_PROJECT;
	if (!engine || !engine.getNote(`projects/${slug}/index.md`)) return DEFAULT_PROJECT;
	return slug;
}

/** Resolve the HMAC key bytes from the env-supplied secret.
 *  ElevenLabs uses `wsec_<hex>` for workspace webhook secrets — the post-prefix
 *  payload is HEX-encoded (not base64; verified empirically 2026-05-30 against
 *  the live workspace webhook). Legacy "raw string" secrets (no `wsec_` prefix)
 *  are still accepted as UTF-8 bytes for operator-generated dev secrets. */
function resolveHmacKey(secret: string): Buffer {
	if (secret.startsWith('wsec_')) {
		const hex = secret.slice('wsec_'.length);
		// Validate the post-prefix is hex; if not, fall back to UTF-8 to avoid
		// silently producing garbage bytes from a future format change.
		if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
			return Buffer.from(hex, 'hex');
		}
	}
	return Buffer.from(secret, 'utf8');
}

/** Verifies ElevenLabs-Signature: t=<timestamp>,v0=<hmac-sha256>
 *  Payload = "<timestamp>.<rawBody>" (the route's prior comment was misleading —
 *  the `t=` prefix is header framing only; the signed payload starts with the
 *  bare timestamp).  Key = `resolveHmacKey(secret)` (see above). */
function verifySignature(rawBody: string, header: string, secret: string): boolean {
	const tPart = header.split(',').find((p) => p.startsWith('t='));
	const v0Part = header.split(',').find((p) => p.startsWith('v0='));
	if (!tPart || !v0Part) return false;

	const ts = tPart.slice(2);
	const received = v0Part.slice(3);
	const key = resolveHmacKey(secret);
	const expected = createHmac('sha256', key)
		.update(`${ts}.${rawBody}`)
		.digest('hex');

	try {
		return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
	} catch {
		return false;
	}
}

function transcriptToMarkdown(
	turns: ElevenLabsTurn[],
	conversationId: string,
	date: string,
): string {
	return [
		'# Evaluate Session Transcript',
		'',
		`- **Conversation ID:** ${conversationId}`,
		`- **Date:** ${date}`,
		'- **Source:** ElevenLabs Hosted Agent (ADR-008)',
		'',
		'## Transcript',
		'',
		...turns.flatMap((t) => [`**${t.role === 'agent' ? 'Guide' : 'SME'}:** ${t.message}`, '']),
	].join('\n');
}

function buildBriefExtractionPrompt(transcriptText: string): string {
	return [
		'You are a post-call analyst. Extract a structured brief from this verbatim SME interview transcript.',
		'',
		'THE IRON RULE: every field you populate MUST cite a verbatim phrase from the SME\'s turns.',
		'Do NOT infer from the Guide\'s turns. Leave a field "" if it never came up.',
		'',
		'STRICT FORMAT RULES — the downstream validator will reject any brief that breaks these:',
		'',
		'1. verdict_reason MUST contain at least one phrase the SME literally said, wrapped in SINGLE QUOTES. Not double quotes, not curly quotes — straight single quotes. The phrase inside the quotes must match an SME turn word-for-word (case + extra whitespace ignored).',
		'   GOOD: Strong candidate — owner cites concrete waste (\'We threw out 28 boxes of pastries\') and a clear target (\'under 10 boxes a week by week 8\').',
		'   BAD:  "Strong candidate based on concrete waste numbers." (no quoted SME phrase)',
		'   BAD:  Strong candidate — owner cited "we threw out 28 boxes" (double quotes, not single)',
		'',
		'2. pull_out_trigger MUST use DIGITS for any number ("3 Saturdays", not "Three Saturdays") OR include a duration keyword (week, month, cycle, by, within) OR an observable-event keyword (customer, complaint, refund, miss, hire). One of these must be present, or the validator rejects the brief.',
		'   GOOD: "3 Saturdays in a row missing customers before noon"',
		'   GOOD: "Two weeks of waste above 15 boxes a week"',
		'   BAD:  "Three Saturdays in a row" (number is spelled out)',
		'   BAD:  "When it gets bad enough" (no quantity, duration, or event)',
		'',
		'3. Do NOT use these registers — the validator catches them as banned lexicon: compliance ("ensuring X practices", "stakeholders", "governance"), AI-spec ("leveraging", "optimizing", "automating"), vague-quantifier ("significant", "approximately", "multiple"), therapist ("I hear you"), consultant ("let\'s drill down", "holistic"). Use the SME\'s words, not these.',
		'',
		'Output ONLY a single-line JSON object with exactly these fields:',
		'{"title":"","problem_statement":"","roi_baseline":"","roi_target":"","scope_ai":"","scope_human":"","success_markers":"","risks":"","pull_out_trigger":"","verdict":"candidate","verdict_reason":""}',
		'',
		'verdict: "candidate" or "back-to-draft".',
		'',
		'--- TRANSCRIPT ---',
		'',
		transcriptText,
	].join('\n');
}

export const POST: RequestHandler = async ({ request }) => {
	const webhookSecret = env.ELEVENLABS_WEBHOOK_SECRET;
	if (!webhookSecret) {
		return json({ ok: false, error: 'Webhook not configured' }, { status: 500 });
	}

	const rawBody = await request.text();
	const signature = request.headers.get('ElevenLabs-Signature') ?? '';

	if (!verifySignature(rawBody, signature, webhookSecret)) {
		return json({ ok: false, error: 'Invalid signature' }, { status: 401 });
	}

	let payload: ElevenLabsWebhook;
	try {
		payload = JSON.parse(rawBody) as ElevenLabsWebhook;
	} catch {
		return json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
	}

	// Only handle the post-call transcription event; ack all other events
	if (payload.type !== 'post_call_transcription') {
		return json({ ok: true, skipped: true });
	}

	const { conversation_id, transcript } = payload.data;
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
	const safeId = conversation_id.replace(/[^a-z0-9-]/gi, '-').slice(0, 30);
	const stem = `${date}-${safeId}-${hhmm}`;

	// Persist verbatim transcript (satisfies ADR-005)
	const engine = getVaultEngine();
	// ADR-009 #2 — route this brief to the customer's project. Validated against
	// the project allow-list; falls back to DEFAULT_PROJECT for unknown/missing.
	const project = resolveProject(engine, payload.data);
	const briefZone = `projects/${project}/sessions`;
	if (engine && transcript.length > 0) {
		const req: CreateNoteRequest = {
			zone: briefZone,
			filename: `${stem}.transcript.md`,
			meta: {
				type: 'transcript',
				status: 'raw',
				created: date,
				project,
				tags: [project, 'evaluate-session', 'voice-transcript', 'adr-008'],
				source_agent: 'elevenlabs-agent',
				source_context: `ElevenLabs conversation ${conversation_id}`,
			} as VaultMeta,
			content: transcriptToMarkdown(transcript, conversation_id, date),
		};
		await engine.createNote(req, {
			actor: 'evaluate-session-post-call',
			actorContext: `conv:${conversation_id}`,
		});
	}

	// Dispatch analyst (Sonnet) to extract the brief. Fire-and-forget so the
	// webhook ACK returns immediately (ElevenLabs has a 10s timeout).
	const provider =
		getAvailableChatProviders().find((p) => p.id === 'anthropic') ??
		getAvailableChatProviders()[0];

	if (provider && transcript.length > 0) {
		const transcriptText = transcript
			.map((t) => `${t.role === 'agent' ? 'Guide' : 'SME'}: ${t.message}`)
			.join('\n');

		void (async () => {
			try {
				const out = await provider.generate({
					system: 'You are a structured data extractor. Output only valid JSON.',
					messages: [{ role: 'user', content: buildBriefExtractionPrompt(transcriptText) }],
					maxOutputTokens: 800,
				});
				const text = out.text ?? '';
				const start = text.indexOf('{');
				const end = text.lastIndexOf('}');
				if (start !== -1 && end > start) {
					const brief = JSON.parse(text.slice(start, end + 1)) as Brief;
					// ADR-004 P2 / ADR-006 P1 — cache the verbatim transcript turns
					// alongside the brief so the action endpoint can re-run the
					// verbatim-anchor gate on amend without reading from disk.
					pendingTranscript.set(conversation_id, transcript.map((t) => ({ role: t.role, message: t.message })));
					// ADR-004 P2 — run analyst gates against the candidate brief.
					// looksConcrete + verbatim-anchor + banned-lexicon. High-severity
					// failures override `verdict` to "back-to-draft" with a structured
					// reason; medium findings (banned lexicon) attach but don't reverse
					// a passing verdict on their own.
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
					// Stash for ADR-006 preview UI — keyed by conversation_id so the
					// standalone app (which polls with the ElevenLabs conversation id)
					// finds it. The transcript FILE keeps the dated `stem` name.
					pendingPreview.set(conversation_id, brief);
					// ADR-009 P2 -- durable mirror so the live accept page survives a
					// soul-hub restart between this webhook and the app's poll. Cleared
					// on accept / back-to-draft. See preview-store.ts.
					savePending(conversation_id, {
						brief,
						transcript: transcript.map((t) => ({ role: t.role, message: t.message })),
						project,
					});
					// Persist the human-facing brief note to the vault.
					await writeBrief(conversation_id, brief, project);
				}
			} catch {
				// Non-fatal: transcript is already persisted; brief write can be retried
			}
		})();
	}

	return json({ ok: true, stem });
};
