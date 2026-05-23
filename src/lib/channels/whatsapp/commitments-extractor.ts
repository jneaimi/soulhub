/** Slice 5 — inferred commitments. Hidden Flash extraction that runs
 *  after every meaningful WhatsApp exchange and spots conversation-bound
 *  follow-ups ("interview tomorrow" → check in afterward). Below the
 *  configured confidence threshold the extracted commitment is dropped
 *  without storage; above, it's persisted scoped to (channel, target)
 *  and the heartbeat composer surfaces it when due.
 *
 *  Fire-and-forget: dispatch.ts kicks this off via `setImmediate` after
 *  the user already has their reply, so no extraction failure can block
 *  or slow the chat. Errors are logged and swallowed.
 *
 *  Structured output uses the flat-enum + `.describe()` per-field pattern
 *  per `feedback_ai_sdk_v6_structured_output` — Zod discriminated unions
 *  break Gemini controlled-generation. */

import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { parseProviderRef } from '../../llm/types.js';
import { insertCommitment } from './heartbeat-state.js';
import { searchContacts, setNextFollowup, syncContactToVault } from '../../crm/index.js';

const CommitmentSchema = z.object({
	suggested_text: z
		.string()
		.describe(
			'A short natural-language follow-up the agent could send later, written in second person ("How did your interview go?"). Empty string when nothing extractable.',
		),
	hours_until_due: z
		.number()
		.min(0)
		.max(168)
		.describe(
			'Hours from now until this follow-up becomes relevant. 1 = soon, 24 = tomorrow, 168 = a week. 0 means the message is too immediate to track as a commitment.',
		),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How confident you are that this is a real conversation-bound commitment worth tracking. 0 = clearly not, 1 = certainty. Below 0.7 means probably skip.',
		),
	crm_contact_name: z
		.string()
		.describe(
			'When the message explicitly names a person the user is tracking ("follow up with John about the Carrefour proposal", "check in with Sara next week"), put the bare name here. Empty string for impersonal commitments or when no specific contact is named. The system fuzzy-resolves this against the CRM; an ambiguous match falls back to a regular commitment.',
		),
});

const ExtractionSchema = z.object({
	commitments: z
		.array(CommitmentSchema)
		.describe(
			'List of inferred follow-ups. Empty array when the exchange has no commitment-worthy content (most exchanges).',
		),
});

const SYSTEM_PROMPT_TEMPLATE = `You read a single WhatsApp exchange and decide whether it implies a follow-up the agent should remember.

## Current time anchor
- User's local time: **__LOCAL_NOW__** (timezone: __TZ__)
- UTC now: __UTC_NOW__
- Use these as ground truth when computing \`hours_until_due\` from natural-language times like "tomorrow", "Friday", "next week".
- "Tomorrow" relative to the local time above. "Friday" = the upcoming Friday in the user's tz. "Next week" ≈ 168 hours.

Rules:
- Only extract commitments tied to a future event the user mentioned ("I have an interview tomorrow", "I'm flying out Friday", "I'll know by next week").
- Skip rhetorical statements, questions, and generic chitchat.
- Skip explicit reminders ("remind me at 3pm") — those are handled by a different system.
- Each commitment must have a clear time horizon (hours_until_due) computed AGAINST THE TIME ANCHOR ABOVE, and a natural follow-up text.
- Set confidence honestly — if you're guessing, score below 0.7 and the system will drop it.
- Most exchanges produce zero commitments. That's the right answer when nothing surfaces.

## CRM follow-ups (new in 2026-05-12)

When the user names a specific person they want to follow up with — patterns like "follow up with John about X", "check in with Sara next Tuesday", "ping Rahul Friday on the proposal" — set \`crm_contact_name\` to the bare name (e.g. "John", "Sara", "Rahul"). The system will fuzzy-match against the CRM and route to the relationship pipeline when the name resolves unambiguously. If you're not sure it's a CRM-tracked person, leave \`crm_contact_name\` empty and the system falls back to a regular commitment — that's the safe default.`;

function buildSystemPrompt(timezone: string): string {
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
	return SYSTEM_PROMPT_TEMPLATE
		.replace('__LOCAL_NOW__', localNow)
		.replace('__TZ__', timezone)
		.replace('__UTC_NOW__', now.toISOString());
}

function readChannelConfig() {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export interface ExtractInput {
	channel: 'whatsapp';
	target: string;
	userText: string;
	agentReply: string;
	sourceMsgId: string | null;
}

/** Run the extraction. Returns the count of commitments inserted (>=0).
 *  Throws only on config/setup errors; extraction failures are caught
 *  and logged so the caller can fire-and-forget without `.catch()`. */
export async function extractCommitments(input: ExtractInput): Promise<number> {
	const cfg = readChannelConfig();
	if (!cfg) return 0;
	const cm = cfg.commitments;
	if (!cm.enabled) return 0;
	if (!input.userText.trim() || !input.agentReply.trim()) return 0;

	const { providerId, modelId } = parseProviderRef(cm.extractionModel);
	if (providerId !== 'gemini') {
		// Other providers will be wired alongside heartbeat.callModel; same gate.
		console.warn(
			`[whatsapp/commitments] extractor only supports gemini for now; got "${providerId}". Skipping.`,
		);
		return 0;
	}

	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.warn('[whatsapp/commitments] GEMINI_API_KEY not set — extractor disabled.');
		return 0;
	}

	const client = createGoogleGenerativeAI({ apiKey });
	// ADR-001 P3 — heartbeat config lifted to the top level.
	const timezone = soulHubConfig.heartbeat?.activeHours?.timezone ?? 'Asia/Dubai';
	const systemPrompt = buildSystemPrompt(timezone);

	let extraction: z.infer<typeof ExtractionSchema>;
	try {
		const result = await generateText({
			model: client(modelId),
			system: systemPrompt,
			output: Output.object({ schema: ExtractionSchema }),
			prompt: `User: ${input.userText}\n\nAgent: ${input.agentReply}`,
			maxOutputTokens: 600,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		extraction = result.output;
	} catch (err) {
		console.warn('[whatsapp/commitments] extraction failed:', (err as Error).message);
		return 0;
	}

	const minIntervalMs = 60 * 60 * 1000; // floor of 1h between extraction and due — matches dueDelayHours min
	const dueDelayMs = Math.max(cm.dueDelayHours * 60 * 60 * 1000, minIntervalMs);

	let inserted = 0;
	for (const commitment of extraction.commitments) {
		if (commitment.confidence < cm.confidenceThreshold) continue;
		if (!commitment.suggested_text.trim()) continue;
		if (commitment.hours_until_due <= 0) continue;

		const dueAfterTs =
			Date.now() + Math.max(commitment.hours_until_due * 60 * 60 * 1000, dueDelayMs);

		// ADR-CRM §D6 — when the extractor named a CRM contact, try to
		// route to the relationship pipeline. Unambiguous single match →
		// set next_followup on the contact + sync vault frontmatter +
		// insert a heartbeat commitment tagged `crm-followup`. Ambiguous
		// or no match → fall through to today's `extractor` insert path.
		const crmName = commitment.crm_contact_name?.trim();
		if (crmName) {
			let matches: Awaited<ReturnType<typeof searchContacts>> = [];
			try {
				matches = searchContacts(crmName, 5);
			} catch {
				matches = [];
			}
			if (matches.length === 1) {
				const contact = matches[0];
				try {
					setNextFollowup(contact.id, dueAfterTs);
					await syncContactToVault(contact.id);
					insertCommitment({
						channel: input.channel,
						target: input.target,
						suggestedText: commitment.suggested_text.trim(),
						dueAfterTs,
						sourceMsgId: input.sourceMsgId,
						confidence: commitment.confidence,
						source: 'crm-followup',
					});
					console.log(
						`[whatsapp/commitments] routed to CRM: ${contact.id} (${contact.displayName}) at ${new Date(dueAfterTs).toISOString()}`,
					);
					inserted++;
					continue;
				} catch (err) {
					console.warn(
						`[whatsapp/commitments] CRM route failed for "${crmName}":`,
						(err as Error).message,
					);
					// Fall through to extractor insert below — better to land
					// the commitment somewhere than drop it on the floor.
				}
			} else if (matches.length > 1) {
				console.log(
					`[whatsapp/commitments] "${crmName}" matched ${matches.length} contacts; falling back to extractor source`,
				);
			}
		}

		try {
			insertCommitment({
				channel: input.channel,
				target: input.target,
				suggestedText: commitment.suggested_text.trim(),
				dueAfterTs,
				sourceMsgId: input.sourceMsgId,
				confidence: commitment.confidence,
				source: 'extractor',
			});
			inserted++;
		} catch (err) {
			console.warn('[whatsapp/commitments] insert failed:', (err as Error).message);
		}
	}

	if (inserted > 0) {
		console.log(`[whatsapp/commitments] inserted ${inserted} commitment(s) for ${input.target}`);
	}
	return inserted;
}

/** Fire-and-forget wrapper — never throws, never awaited. Use this from
 *  the dispatcher right after a successful reply so commitment extraction
 *  doesn't block the user. */
export function extractCommitmentsAsync(input: ExtractInput): void {
	setImmediate(() => {
		void extractCommitments(input).catch((err) => {
			console.warn('[whatsapp/commitments] background extraction errored:', (err as Error).message);
		});
	});
}
