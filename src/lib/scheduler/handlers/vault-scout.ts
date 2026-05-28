/** Task handler: vault-scout (Phase 7 / ADR-007).
 *
 *  Daily 3-tier pipeline that catches voice-worthy moments individual
 *  producer-scripts can't see:
 *
 *    [1] Extractor (deterministic, in-process):
 *        - frontmatter `falsifier:` / `review_date:` within window
 *        - status-log future ISO dates (regex match in project.md content)
 *        - emits stable `voice_candidate_id` per finding
 *
 *    [2] Synthesizer (Gemini Flash via direct AI SDK call):
 *        - reads candidates JSON
 *        - decides per-candidate: queue / skip / defer
 *        - generates voice_summary, voice_due, voice_priority, body
 *        - strict JSON via `Output.object` (per feedback_ai_sdk_v6_structured_output)
 *
 *    [3] Note writer (deterministic, idempotent):
 *        - validates output (voice_due ≥ today, ISO format)
 *        - writes inbox/YYYY-MM-DD-{slug}.md with frontmatter
 *        - records every candidate's decision in `vault_scout_decisions`
 *        - already-decided candidates skipped on subsequent runs (PK)
 *        - rejects logged to `vault_scout_rejects` for audit
 *
 *  ADR-007 originally specified `cli:claude:sonnet` as primary via the
 *  routes layer. The routes layer doesn't accept `cli:` providers yet
 *  (failover.ts:66 throws UnsupportedProviderError), so v1 calls Gemini
 *  Flash directly — same pattern as vault-chat/selector.ts and brain/save.ts.
 *  Future: when CLI-in-routes lands, swap `synthesize()` to
 *  `dispatchRoute('vault-scout-synth', request)` per the original design.
 *
 *  Settings shape:
 *    {
 *      id: 'vault-scout-daily',
 *      type: 'vault-scout',
 *      cron: '0 5 * * *',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        falsifierWindowDays: 30,    // optional, default 30
 *        reviewDateWindowDays: 30,   // optional, default 30
 *        maxCandidatesPerRun: 50,    // optional, default 50
 *        maxQueuedPerRun: 5,         // optional, default 5 (caps inbox writes)
 *      }
 *    }
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { getVaultEngine } from '../../vault/index.js';
import type { VaultNote } from '../../vault/types.js';
import {
	getDecidedCandidateIds,
	recordScoutDecision,
	recordScoutReject,
	getBlockerSnapshot,
	upsertBlockerSnapshot,
	type BlockerSnapshotRow,
	getEdgeSnapshot,
	upsertEdgeSnapshot,
	type EdgeSnapshotRow,
	getPrepSnapshot,
	upsertPrepSnapshot,
	type PrepSnapshotRow,
} from '../../channels/whatsapp/heartbeat-state.js';
import {
	extractUnblockCandidates,
	type BlockerSnapshot,
	type BlockerSnapshotStore,
	type BlockerResolver,
	type UnblockCandidate,
} from './vault-scout-unblock.js';
import {
	extractEdgeStaleCandidates,
	type EdgeSnapshot,
	type EdgeSnapshotStore,
	type EdgeStaleCandidate,
	type ProducerIndex,
} from './vault-scout-edge.js';
import {
	extractProactivePrepDispatches,
	type PrepSnapshot,
	type PrepSnapshotStore,
	type PrepResolver,
} from './proactive-prep.js';
import { dispatchAgent } from '../../agents/dispatch/index.js';
import type { TaskFn } from '../task-types.js';

const SYNTH_MODEL = 'gemini-2.5-flash';
const SYNTH_TIMEOUT_MS = 60_000;

interface ScoutParams {
	falsifierWindowDays?: number;
	reviewDateWindowDays?: number;
	maxCandidatesPerRun?: number;
	maxQueuedPerRun?: number;
	vaultDir?: string;
}

export type CandidateKind = 'falsifier' | 'review-date' | 'future-mention' | 'unblock' | 'edge-stale';

export interface Candidate {
	id: string;
	kind: CandidateKind;
	sourcePath: string;
	projectFolder: string;
	suggestedDate: string; // ISO YYYY-MM-DD
	rawText: string;
	frontmatter: Record<string, unknown>;
	/** ADR-009 — only set when kind === 'unblock'. Frozen list of blocker
	 *  paths that all transitioned to shipped/superseded. Carried through
	 *  to the synth prompt so the model can name the unblock chain. */
	blockerPaths?: string[];
	/** ADR-009 — only set when kind === 'unblock'. Audit trail of the
	 *  transitions observed THIS run (prev_status → new_status). Used by
	 *  F2 verification + the renderer's audit footer. */
	triggerTrail?: Array<{ blockerPath: string; prevStatus: string; newStatus: string }>;
	/** projects-graph ADR-006 — only set when kind === 'edge-stale'.
	 *  Names the consumer slug, filesystem destination, and how stale the
	 *  edge is so the synth prompt can compose a useful WhatsApp surface. */
	edgeStale?: {
		consumerSlug: string;
		destination: string;
		falsifier: string;
		falsifierDate: string;
		lastFlowMtime: number | null;
		daysStale: number;
		staleWindowDays: number;
	};
}

const PROJECT_FOLDER_RE = /^projects\/([^/]+)\//;

function projectFolderFor(path: string): string | null {
	const m = PROJECT_FOLDER_RE.exec(path);
	return m ? m[1] : null;
}

function asIsoDate(value: unknown): string | null {
	if (typeof value === 'string') {
		const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
		if (m) {
			const d = new Date(m[1]);
			if (!Number.isNaN(d.getTime())) return m[1];
		}
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	return null;
}

function todayIsoInTz(now: Date, tz: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

function daysBetween(a: string, b: string): number {
	const ms = new Date(a).getTime() - new Date(b).getTime();
	return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function shortHash(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function slugFromSummary(summary: string, max = 60): string {
	const cleaned = summary
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (cleaned.length <= max) return cleaned || 'scout-item';
	// Snap back to the last hyphen at or before `max` so we don't truncate
	// mid-word ("weekly" → "weekl"). If no hyphen exists in the window,
	// fall back to a hard cut.
	const window = cleaned.slice(0, max);
	const lastHyphen = window.lastIndexOf('-');
	const snapped = lastHyphen > 0 ? window.slice(0, lastHyphen) : window;
	return snapped || 'scout-item';
}

// ── Tier 1: Extractor ──────────────────────────────────────────────

const FUTURE_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const FUTURE_DATE_CONTEXT_WORDS = /\b(by|until|earliest|deadline|due|review|fire[ds]?|delete|cleanup|verify|check)\b/i;

/** Pure function — exported for smoke testing without a live vault. */
export function extractCandidates(
	notes: VaultNote[],
	now: Date,
	opts: { falsifierWindowDays: number; reviewDateWindowDays: number; tz: string },
): Candidate[] {
	const today = todayIsoInTz(now, opts.tz);
	const out: Candidate[] = [];

	for (const note of notes) {
		const folder = projectFolderFor(note.path);
		if (!folder) continue;

		// Type 1: falsifier / review_date frontmatter dates.
		const falsifier = asIsoDate(note.meta.falsifier);
		if (falsifier) {
			const days = daysBetween(falsifier, today);
			// Within window OR already past (still surface for explicit review)
			if (days <= opts.falsifierWindowDays) {
				out.push({
					id: `falsifier-${folder}-${falsifier}`,
					kind: 'falsifier',
					sourcePath: note.path,
					projectFolder: folder,
					suggestedDate: falsifier,
					rawText: `falsifier: ${falsifier}`,
					frontmatter: note.meta as Record<string, unknown>,
				});
			}
		}

		const reviewDate = asIsoDate(note.meta.review_date);
		if (reviewDate) {
			const days = daysBetween(reviewDate, today);
			if (days <= opts.reviewDateWindowDays) {
				out.push({
					id: `review-date-${folder}-${reviewDate}`,
					kind: 'review-date',
					sourcePath: note.path,
					projectFolder: folder,
					suggestedDate: reviewDate,
					rawText: `review_date: ${reviewDate}`,
					frontmatter: note.meta as Record<string, unknown>,
				});
			}
		}

		// Type 3: status-log future-date mentions in body content.
		// Look for ISO dates near contextual words like "by", "earliest",
		// "deadline" etc. — avoids false positives on every YYYY-MM-DD in
		// the file (e.g. status log entry headers).
		if (note.path.endsWith('/project.md')) {
			const body = note.content;
			const matches = body.matchAll(FUTURE_DATE_RE);
			const seen = new Set<string>();
			for (const m of matches) {
				const date = m[1];
				if (date <= today) continue; // past or today — skip
				if (seen.has(date)) continue;
				seen.add(date);
				const days = daysBetween(date, today);
				if (days > opts.falsifierWindowDays) continue; // too far out

				// Get surrounding context (50 chars before + after)
				const idx = m.index ?? 0;
				const ctxStart = Math.max(0, idx - 50);
				const ctxEnd = Math.min(body.length, idx + date.length + 50);
				const context = body.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ');

				if (!FUTURE_DATE_CONTEXT_WORDS.test(context)) continue;

				out.push({
					id: `future-mention-${folder}-${date}-${shortHash(context)}`,
					kind: 'future-mention',
					sourcePath: note.path,
					projectFolder: folder,
					suggestedDate: date,
					rawText: context.trim(),
					frontmatter: note.meta as Record<string, unknown>,
				});
			}
		}
	}

	return out;
}

// ── Tier 2: Synthesizer (Gemini Flash, direct call) ───────────────

const ScoutDecisionItemSchema = z.object({
	candidate_id: z.string(),
	action: z.enum(['queue', 'skip', 'defer']),
	voice_summary: z.string().optional(),
	voice_due: z.string().optional(),
	voice_priority: z.enum(['low', 'normal', 'high']).optional(),
	body: z.string().optional(),
	reason: z.string().optional(),
});

const ScoutOutputSchema = z.object({
	decisions: z.array(ScoutDecisionItemSchema),
});

const SCOUT_SYSTEM_PROMPT = `You are Vault-Scout, the proactive milestone-detector for Jasem's Soul Hub second-brain. Each day you receive a list of candidates extracted from the vault — falsifier dates, review dates, future-date mentions in project notes, unblock events (an ADR's blockers just shipped), AND edge-stale events (a producer→consumer flow has gone dark beyond its declared window) — and decide which deserve a WhatsApp voice-queue surface.

Your job:
1. For each candidate, decide: "queue" (worth pinging), "skip" (irrelevant or covered by another producer), or "defer" (re-evaluate next run).
2. For "queue" decisions, generate:
   - voice_summary: ≤200 chars, the WhatsApp ping body. Direct, actionable.
   - voice_due: ISO date YYYY-MM-DD when the consumer should surface this. MUST be ≥ today's date.
   - voice_priority: low | normal | high based on actionability + time-pressure.
   - body: markdown body of the inbox note. Include vault links and one-line rationale.

Rules:
- Be CONSERVATIVE. Quality over quantity. The user gets max 5 queued items per run.
- Falsifiers within 7 days of today: high priority. Within 30 days: normal. Past: high (overdue review).
- Review dates: same scaling.
- Future-mentions: only queue if the date itself is the actionable signal (e.g. an "earliest YYYY-MM-DD" deadline).
- Unblock events: HIGH priority by default — the operator has been blocked on this dependent ADR; surface it the same day. voice_due = today's date. body should name the unblocked ADR + the blocker(s) that shipped + a one-line "next step" suggestion. Skip only if the dependent ADR is itself already in status: shipped or superseded.
- Edge-stale events: NORMAL priority by default; HIGH when the consumer is on the operator's critical path (peer-brief, social-media-launch). voice_due = today's date. body should name the producer→consumer chain, the destination path, the falsifier window, and how many days the edge has been silent. Skip only if either the producer or the consumer is already in status: parked or superseded.
- Skip duplicates of project-hygiene's coverage (anomalies, stale-active) — those producers handle their own flagging.
- "defer" sparingly — only when you're genuinely uncertain.

Output strict JSON matching the schema. Pass candidate_id through unchanged.`;

interface SynthDecision {
	candidate_id: string;
	action: 'queue' | 'skip' | 'defer';
	voice_summary?: string;
	voice_due?: string;
	voice_priority?: 'low' | 'normal' | 'high';
	body?: string;
	reason?: string;
}

async function synthesize(
	candidates: Candidate[],
	abortSignal: AbortSignal,
): Promise<{ decisions: SynthDecision[]; modelUsed: string }> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		throw new Error('vault-scout: GEMINI_API_KEY not set');
	}
	const client = createGoogleGenerativeAI({ apiKey });
	const userPrompt = JSON.stringify(
		{
			today: todayIsoInTz(new Date(), 'Asia/Dubai'),
			candidates: candidates.map((c) => ({
				candidate_id: c.id,
				kind: c.kind,
				project: c.projectFolder,
				source_path: c.sourcePath,
				suggested_date: c.suggestedDate,
				raw_text: c.rawText.slice(0, 300),
				frontmatter_status: c.frontmatter.status ?? null,
				// ADR-009 — only present on kind: 'unblock'. Names the
				// blockers that just transitioned to shipped/superseded.
				blocker_paths: c.blockerPaths,
				trigger_trail: c.triggerTrail,
				// projects-graph ADR-006 — only present on kind: 'edge-stale'.
				edge_stale: c.edgeStale,
			})),
		},
		null,
		2,
	);

	const result = await generateText({
		model: client(SYNTH_MODEL),
		output: Output.object({ schema: ScoutOutputSchema }),
		system: SCOUT_SYSTEM_PROMPT,
		messages: [{ role: 'user', content: userPrompt }],
		maxOutputTokens: 4000,
		providerOptions: {
			google: { thinkingConfig: { thinkingBudget: 200 } },
		},
		abortSignal,
	});

	return {
		decisions: result.output.decisions,
		modelUsed: `gemini:${SYNTH_MODEL}`,
	};
}

// ── Tier 3: Note writer (idempotent) ─────────────────────────────

interface RunResult {
	candidatesFound: number;
	alreadyDecided: number;
	queued: number;
	skipped: number;
	deferred: number;
	rejects: number;
	modelUsed: string | null;
	durationMs: number;
	/** ADR-009 F3 — independent measurement of the unblock-watch slice
	 *  (extractor walk + per-pair snapshot diff). Excludes synth + writer
	 *  cost. Falsifier reads this field, NOT whole-handler `durationMs`. */
	unblockWatchMs: number;
	/** ADR-009 stats — surfaced in output_summary for the operator
	 *  dashboard + post-deploy audit. */
	unblockCandidates: number;
	unblockPairsExamined: number;
	unblockTransitions: number;
	unblockUnresolved: number;
	/** projects-graph ADR-006 — edge-stale slice measurement, mirroring
	 *  the ADR-009 split. Falsifier reads `edgeStaleCandidates > 0`. */
	edgeWatchMs?: number;
	edgeStaleCandidates?: number;
	edgesExamined?: number;
	edgesFirstObserved?: number;
	/** projects-graph ADR-019 — proactive prep action layer measurement.
	 *  prepDispatched counts DispatchIntents emitted this run. */
	prepWatchMs?: number;
	prepDispatched?: number;
	prepFirstObservations?: number;
	prepDeduped?: number;
}

function validateDecision(d: SynthDecision, today: string): { ok: boolean; reason?: string } {
	if (d.action === 'queue') {
		if (!d.voice_summary || !d.voice_due || !d.body) {
			return { ok: false, reason: 'queue action missing required fields (voice_summary, voice_due, body)' };
		}
		const dueIso = asIsoDate(d.voice_due);
		if (!dueIso) return { ok: false, reason: `voice_due not ISO date: ${d.voice_due}` };
		if (dueIso < today) return { ok: false, reason: `voice_due ${dueIso} is in the past (today=${today})` };
	}
	if ((d.action === 'skip' || d.action === 'defer') && !d.reason) {
		// Soft requirement — accept without reason but flag for audit
		return { ok: true };
	}
	return { ok: true };
}

function renderInboxNote(
	candidate: Candidate,
	decision: SynthDecision,
	today: string,
	modelUsed: string,
): { content: string; outputPath: string; vaultDir: string } | null {
	if (decision.action !== 'queue') return null;
	if (!decision.voice_summary || !decision.voice_due || !decision.body) return null;

	const priority = decision.voice_priority ?? 'normal';
	const safeSummary = decision.voice_summary.replace(/"/g, "'");
	const slug = slugFromSummary(decision.voice_summary);

	const lines = [
		'---',
		'type: task',
		`created: ${today}`,
		'tags: [vault-scout, milestone, voice-queue]',
		`project: ${candidate.projectFolder}`,
		'source: agent',
		'source_agent: vault-scout',
		'source_context: soul-hub-scheduler',
		'voice_eligible: true',
		`voice_priority: ${priority}`,
		`voice_due: ${decision.voice_due}`,
		`voice_summary: "${safeSummary}"`,
		`voice_candidate_id: ${candidate.id}`,
		`scout_model: ${modelUsed}`,
		`scout_kind: ${candidate.kind}`,
		'---',
		'',
		decision.body,
		'',
		'---',
		'',
		`_Source: [[${candidate.sourcePath.replace(/\.md$/, '')}|${candidate.projectFolder}]] · ` +
			`Suggested by Vault-Scout from ${candidate.kind} signal._`,
		'',
	];

	// ADR-009 — when this is an unblock candidate, append the audit trail
	// so the operator (and F2 verification) can read prev_status →
	// new_status for each blocker that triggered the candidate.
	if (candidate.kind === 'unblock' && candidate.triggerTrail && candidate.triggerTrail.length > 0) {
		lines.push('');
		lines.push('**Unblock audit trail:**');
		lines.push('');
		for (const t of candidate.triggerTrail) {
			const slug = t.blockerPath.replace(/\.md$/, '');
			lines.push(`- \`${slug}\`: ${t.prevStatus || '∅'} → ${t.newStatus}`);
		}
		lines.push('');
	}

	const filename = `${decision.voice_due}-${slug}.md`;
	return {
		content: lines.join('\n'),
		outputPath: filename,
		vaultDir: '',
	};
}

// ── Factory + orchestration ──────────────────────────────────────

export function vaultScoutFactory(rawParams: unknown): TaskFn {
	const params: ScoutParams =
		typeof rawParams === 'object' && rawParams !== null ? (rawParams as ScoutParams) : {};
	const falsifierWindowDays = params.falsifierWindowDays ?? 30;
	const reviewDateWindowDays = params.reviewDateWindowDays ?? 30;
	const maxCandidatesPerRun = params.maxCandidatesPerRun ?? 50;
	const maxQueuedPerRun = params.maxQueuedPerRun ?? 5;
	const vaultDir = params.vaultDir ?? resolve(homedir(), 'vault');
	const tz = 'Asia/Dubai';

	return async (ctx): Promise<RunResult> => {
		const externalSignal = ctx?.signal;
		const startMs = Date.now();
		const engine = getVaultEngine();
		if (!engine) {
			throw new Error('vault-scout: vault engine is not initialised');
		}
		const now = new Date();
		const today = todayIsoInTz(now, tz);

		// Tier 1: extract.
		const allNotes = engine.getRecent(10000);
		let candidates = extractCandidates(allNotes, now, {
			falsifierWindowDays,
			reviewDateWindowDays,
			tz,
		});

		// ADR-009 — unblock-watch slice. Measured separately so F3 can
		// verify the cost stays under 50ms independent of total handler
		// duration. The store + resolver adapters are thin shims over
		// heartbeat-state.ts + the vault engine respectively.
		const unblockStartMs = Date.now();
		const decisionNotes = allNotes.filter((n) => n.meta.type === 'decision');
		const snapshotStore: BlockerSnapshotStore = {
			get: (dependentPath, blockerPath) => {
				const row = getBlockerSnapshot(dependentPath, blockerPath);
				return row ? (row as BlockerSnapshot) : null;
			},
			upsert: (row) => upsertBlockerSnapshot(row as BlockerSnapshotRow),
		};
		const blockerResolver: BlockerResolver = {
			resolveLink: (raw, sourcePath) => engine.resolveLink(raw, sourcePath),
			getNote: (path) => engine.getNote(path),
		};
		const unblock = extractUnblockCandidates(
			decisionNotes,
			snapshotStore,
			blockerResolver,
			now.getTime(),
		);
		const unblockWatchMs = Date.now() - unblockStartMs;

		// Bridge unblock candidates into the unified Candidate shape so the
		// synth + writer pipeline handles them with the existing
		// already-decided dedup + cap logic.
		const unblockCandidatesBridged: Candidate[] = unblock.candidates.map((u: UnblockCandidate) => ({
			id: u.id,
			kind: 'unblock' as const,
			sourcePath: u.dependentPath,
			projectFolder: u.projectFolder,
			suggestedDate: u.blockerShippedOn,
			rawText: `unblocked by ${u.triggerTrail.map((t) => t.blockerPath).join(', ')}`,
			frontmatter: { status: undefined },
			blockerPaths: u.blockerPaths,
			triggerTrail: u.triggerTrail,
		}));

		// projects-graph ADR-006 — edge-stale slice. Walks producer index.md
		// notes with rich-form `produces_for[]` entries, probes their
		// filesystem destinations via edge-flow.ts, and emits candidates
		// when the freshness gap exceeds the declared window. Single-table
		// snapshot store mirrors the unblock pattern; first observation
		// is quiet to keep the first post-deploy run noise-free.
		const edgeStartMs = Date.now();
		const producerIndexes: ProducerIndex[] = allNotes
			.filter((n) => /^projects\/[^/]+\/index\.md$/.test(n.path))
			.map<ProducerIndex | null>((n) => {
				const raw = n.meta.produces_for;
				if (!Array.isArray(raw) || raw.length === 0) return null;
				const richEntries = raw
					.filter((e): e is { target: string; destination?: string; falsifier?: string; falsifier_date?: string } =>
						!!e && typeof e === 'object' && 'target' in e && typeof (e as { target?: unknown }).target === 'string',
					);
				if (richEntries.length === 0) return null;
				const slug = n.path.replace(/^projects\//, '').replace(/\/index\.md$/, '');
				return { path: n.path, slug, producesFor: richEntries };
			})
			.filter((p): p is ProducerIndex => p !== null);

		const edgeStore: EdgeSnapshotStore = {
			get: (producerSlug, consumerSlug) => {
				const row = getEdgeSnapshot(producerSlug, consumerSlug);
				return row ? (row as EdgeSnapshot) : null;
			},
			upsert: (row) => upsertEdgeSnapshot(row as EdgeSnapshotRow),
		};
		const edge = await extractEdgeStaleCandidates(producerIndexes, edgeStore, now.getTime());
		const edgeWatchMs = Date.now() - edgeStartMs;

		const edgeStaleBridged: Candidate[] = edge.candidates.map((e: EdgeStaleCandidate) => ({
			id: e.id,
			kind: 'edge-stale' as const,
			sourcePath: e.producerPath,
			projectFolder: e.producerSlug,
			suggestedDate: today,
			rawText: `producer→consumer edge stale: ${e.producerSlug} → ${e.consumerSlug} (${Number.isFinite(e.daysStale) ? `no flow for ${e.daysStale}d` : 'no flow ever — destination empty/missing'}, window ${e.staleWindowDays}d)`,
			frontmatter: { status: undefined },
			edgeStale: {
				consumerSlug: e.consumerSlug,
				destination: e.destination,
				falsifier: e.falsifier,
				falsifierDate: e.falsifierDate,
				lastFlowMtime: e.lastFlowMtime,
				daysStale: e.daysStale,
				staleWindowDays: e.staleWindowDays,
			},
		}));

		// projects-graph ADR-019 — proactive prep action layer. Post-step on
		// the raw unblock candidates just extracted by vault-scout-unblock.
		// Emits DispatchIntents for human-owned tasks in opted-in projects
		// that have no prep note yet; fires them detached (fire-and-forget).
		// First-observation is quiet per ADR-019 guardrail 3 — no dispatch
		// on the first encounter of any task.
		const prepStartMs = Date.now();
		const prepStore: PrepSnapshotStore = {
			get: (taskPath) => {
				const row = getPrepSnapshot(taskPath);
				return row ? (row as PrepSnapshot) : null;
			},
			upsert: (row) => upsertPrepSnapshot(row as PrepSnapshotRow),
		};
		const prepResolver: PrepResolver = {
			isProjectOptedIn: (projectFolder) => {
				const indexPath = `projects/${projectFolder}/index.md`;
				const indexNote = engine.getNote(indexPath);
				return indexNote?.meta.proactive_prep_enabled === true;
			},
			getNote: (path) => engine.getNote(path),
		};
		const prepResult = extractProactivePrepDispatches(
			unblock.candidates,
			prepResolver,
			prepStore,
			now.getTime(),
		);
		const prepWatchMs = Date.now() - prepStartMs;

		// Fire prep dispatches detached — agent_runs threads them into the
		// Workbench `in_flight` lane automatically via `subjectPath`.
		for (const intent of prepResult.dispatches) {
			void (async () => {
				try {
					for await (const _event of dispatchAgent(intent.agentId, intent.prompt, {
						mode: 'production',
						subjectPath: intent.taskPath,
						pausableOnCeiling: true,
					})) {
						// drain the generator; events persisted to agent_runs
					}
				} catch (err) {
					console.error(
						`[vault-scout/proactive-prep] dispatch failed for ${intent.taskPath}:`,
						String(err),
					);
				}
			})();
		}

		candidates = [...candidates, ...unblockCandidatesBridged, ...edgeStaleBridged];

		// Skip already-decided candidates.
		const decidedIds = getDecidedCandidateIds(candidates.map((c) => c.id));
		const alreadyDecidedCount = candidates.filter((c) => decidedIds.has(c.id)).length;
		candidates = candidates.filter((c) => !decidedIds.has(c.id));

		// Cap before sending to AI.
		const overcap = candidates.length > maxCandidatesPerRun;
		if (overcap) candidates = candidates.slice(0, maxCandidatesPerRun);

		if (candidates.length === 0) {
			return {
				candidatesFound: 0,
				alreadyDecided: alreadyDecidedCount,
				queued: 0,
				skipped: 0,
				deferred: 0,
				rejects: 0,
				modelUsed: null,
				durationMs: Date.now() - startMs,
				unblockWatchMs,
				unblockCandidates: unblock.candidates.length,
				unblockPairsExamined: unblock.stats.pairsExamined,
				unblockTransitions: unblock.stats.transitionsObserved,
				unblockUnresolved: unblock.stats.unresolvedBlockers,
				edgeWatchMs,
				edgeStaleCandidates: edge.candidates.length,
				edgesExamined: edge.stats.edgesExamined,
				edgesFirstObserved: edge.stats.edgesFirstObserved,
				prepWatchMs,
				prepDispatched: prepResult.stats.dispatched,
				prepFirstObservations: prepResult.stats.skippedFirstObservation,
				prepDeduped: prepResult.stats.skippedDedup,
			};
		}

		// Tier 2: synthesize. Internal timer guards against API hangs;
		// external `ctx.signal` (from `killRun`) is chained in so cancel
		// from the UI aborts the in-flight Gemini call.
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
		const onExternalAbort = () => ctrl.abort();
		if (externalSignal) {
			if (externalSignal.aborted) ctrl.abort();
			else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
		}
		let synth: { decisions: SynthDecision[]; modelUsed: string };
		try {
			synth = await synthesize(candidates, ctrl.signal);
		} catch (err) {
			recordScoutReject(null, null, `synthesizer error: ${(err as Error).message}`);
			throw err;
		} finally {
			clearTimeout(timer);
			if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
		}

		// Tier 3: validate + write + record.
		const candidateById = new Map(candidates.map((c) => [c.id, c]));
		let queued = 0;
		let skipped = 0;
		let deferred = 0;
		let rejects = 0;

		// Cap queued writes per run.
		const queueDecisions = synth.decisions.filter((d) => d.action === 'queue');
		const otherDecisions = synth.decisions.filter((d) => d.action !== 'queue');
		const queueDecisionsCapped = queueDecisions.slice(0, maxQueuedPerRun);
		const cappedOut = queueDecisions
			.slice(maxQueuedPerRun)
			.map((d): SynthDecision => ({ ...d, action: 'defer', reason: 'capped: maxQueuedPerRun' }));

		const allDecisions = [...queueDecisionsCapped, ...otherDecisions, ...cappedOut];

		for (const d of allDecisions) {
			const candidate = candidateById.get(d.candidate_id);
			if (!candidate) {
				rejects += 1;
				recordScoutReject(d.candidate_id, JSON.stringify(d), 'unknown candidate_id from synthesizer');
				continue;
			}

			const validation = validateDecision(d, today);
			if (!validation.ok) {
				rejects += 1;
				recordScoutReject(d.candidate_id, JSON.stringify(d), validation.reason ?? 'invalid');
				continue;
			}

			if (d.action === 'queue') {
				const note = renderInboxNote(candidate, d, today, synth.modelUsed);
				if (!note) {
					rejects += 1;
					recordScoutReject(d.candidate_id, JSON.stringify(d), 'render returned null');
					continue;
				}
				const outPath = resolve(vaultDir, 'inbox', note.outputPath);
				await mkdir(dirname(outPath), { recursive: true });
				await writeFile(outPath, note.content, 'utf-8');
				const inserted = recordScoutDecision({
					candidateId: candidate.id,
					decision: 'queued',
					notePath: `inbox/${note.outputPath}`,
					modelUsed: synth.modelUsed,
					reason: null,
				});
				if (inserted) queued += 1;
			} else if (d.action === 'skip') {
				recordScoutDecision({
					candidateId: candidate.id,
					decision: 'skipped',
					notePath: null,
					modelUsed: synth.modelUsed,
					reason: d.reason ?? null,
				});
				skipped += 1;
			} else if (d.action === 'defer') {
				recordScoutDecision({
					candidateId: candidate.id,
					decision: 'deferred',
					notePath: null,
					modelUsed: synth.modelUsed,
					reason: d.reason ?? null,
				});
				deferred += 1;
			}
		}

		return {
			candidatesFound: candidates.length + alreadyDecidedCount,
			alreadyDecided: alreadyDecidedCount,
			queued,
			skipped,
			deferred,
			rejects,
			modelUsed: synth.modelUsed,
			durationMs: Date.now() - startMs,
			unblockWatchMs,
			unblockCandidates: unblock.candidates.length,
			unblockPairsExamined: unblock.stats.pairsExamined,
			unblockTransitions: unblock.stats.transitionsObserved,
			unblockUnresolved: unblock.stats.unresolvedBlockers,
			edgeWatchMs,
			edgeStaleCandidates: edge.candidates.length,
			edgesExamined: edge.stats.edgesExamined,
			edgesFirstObserved: edge.stats.edgesFirstObserved,
			prepWatchMs,
			prepDispatched: prepResult.stats.dispatched,
			prepFirstObservations: prepResult.stats.skippedFirstObservation,
			prepDeduped: prepResult.stats.skippedDedup,
		};
	};
}
