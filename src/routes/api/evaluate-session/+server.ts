/** POST /api/evaluate-session
 *
 *  Two modes:
 *
 *  (1) Conversational turn — body `{ message, sessionKey }` (text-mode
 *      original; voice-mode uses ElevenLabs directly + the post-call
 *      webhook). Returns `{ ok, text, done, briefPath? }`.
 *
 *  (2) ADR-006 P1 SME confirmation actions — body `{ action, sessionKey,
 *      amendments? }`:
 *        - `accept` → confirm the pendingPreview brief, write to vault
 *          with `sme_confirmed: true` + amendments_count, clear state.
 *        - `amend` → patch pendingPreview with `amendments` (partial Brief);
 *          re-run ADR-004 P2 gates; if gates fail return validation_error,
 *          otherwise stash the patched brief back.
 *        - `back-to-draft` → override verdict; write with verdict=back-to-
 *          draft; clear state.
 *
 *      `amendments` shape: `Partial<Brief>` keyed by field name.
 *      Returns `{ ok, action, briefPath?, brief?, gate_failures? }`.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { runEvaluateTurn, pendingPreview, pendingTranscript, pendingBriefPath, writeBrief } from '$lib/evaluate-session/index.js';
import type { Brief } from '$lib/evaluate-session/index.js';
import { runAllGates, type TranscriptTurn } from '$lib/evaluate-session/analyst-gates.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { loadPending, savePending, clearPending } from '$lib/evaluate-session/preview-store.js';

type SmeAction = 'accept' | 'amend' | 'back-to-draft';

interface ActionBody {
	action: SmeAction;
	sessionKey: string;
	amendments?: Partial<Brief>;
	verdict_reason_sme?: string;
}

interface TurnBody {
	message: string;
	sessionKey: string;
}

const VALID_ACTIONS: ReadonlySet<SmeAction> = new Set(['accept', 'amend', 'back-to-draft']);

/** Resolve the transcript turns for a session: prefer the in-memory
 *  pendingTranscript map (populated by the post-call webhook), fall back
 *  to parsing the persisted transcript note. Returns [] when neither is
 *  available — verbatim-anchor will then fail any quote, which is the
 *  right behavior. */
function loadTranscript(sessionKey: string): TranscriptTurn[] {
	const cached = pendingTranscript.get(sessionKey);
	if (cached && cached.length > 0) {
		return cached.map((t) => ({ role: t.role, message: t.message }));
	}
	const engine = getVaultEngine();
	if (!engine) return [];
	// Search the candidate session zone for a transcript note that matches
	// the session key as a stem fragment (the persisted filename has a
	// date prefix doubled on by the engine — see the post-call route note).
	for (const candidate of [
		`projects/coffee-ops-sandiego/sessions/${sessionKey}.transcript.md`,
		`projects/coffee-ops-sandiego/sessions/${sessionKey}.md`,
	]) {
		const note = engine.getNote(candidate);
		if (!note) continue;
		const body = note.content ?? '';
		const turns: TranscriptTurn[] = [];
		const re = /^\*\*(Guide|SME):\*\*\s+(.*)$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			turns.push({
				role: m[1] === 'Guide' ? 'agent' : 'user',
				message: m[2].trim(),
			});
		}
		if (turns.length > 0) return turns;
	}
	return [];
}

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	// Dispatch on shape: presence of `action` → SME confirmation action.
	const maybeAction = (body as Partial<ActionBody>).action;
	if (typeof maybeAction === 'string') {
		return handleSmeAction(body as ActionBody);
	}
	return handleTurn(body as TurnBody);
};

async function handleTurn(body: TurnBody): Promise<Response> {
	const message = body.message?.trim();
	const sessionKey = body.sessionKey?.trim();
	if (!message) return json({ ok: false, error: 'Missing `message`' }, { status: 400 });
	if (!sessionKey) return json({ ok: false, error: 'Missing `sessionKey`' }, { status: 400 });
	const result = await runEvaluateTurn(sessionKey, message);
	const status = result.ok ? 200 : result.error?.includes('not found') ? 404 : 500;
	return json(result, { status });
}

async function handleSmeAction(body: ActionBody): Promise<Response> {
	const action = body.action;
	const sessionKey = body.sessionKey?.trim();

	if (!VALID_ACTIONS.has(action)) {
		return json(
			{ ok: false, error: `Invalid action "${action}" (must be: accept | amend | back-to-draft)` },
			{ status: 400 },
		);
	}
	if (!sessionKey) {
		return json({ ok: false, error: 'Missing `sessionKey`' }, { status: 400 });
	}
	let brief = pendingPreview.get(sessionKey);
	// ADR-009 P2 — defensive durable fallback: if soul-hub restarted after the
	// /preview poll but before this action, the in-memory map is cold. Rehydrate
	// from the durable store so accept/amend/back-to-draft don't 404.
	if (!brief) {
		const record = loadPending(sessionKey);
		if (record) {
			brief = record.brief;
			pendingPreview.set(sessionKey, record.brief);
			pendingTranscript.set(sessionKey, record.transcript);
		}
	}
	if (!brief) {
		return json(
			{ ok: false, error: `No pending preview for session "${sessionKey}". Run the conversation first.` },
			{ status: 404 },
		);
	}

	switch (action) {
		case 'amend': {
			const amendments = body.amendments;
			if (!amendments || typeof amendments !== 'object') {
				return json({ ok: false, error: 'Amend requires `amendments` (Partial<Brief>)' }, { status: 400 });
			}
			const patched: Brief = { ...brief, ...amendments };
			// Track amendment count for ADR-006 acceptance criterion.
			const amendCount = (((brief as { sme_amendments_count?: number }).sme_amendments_count) ?? 0) + 1;
			(patched as { sme_amendments_count?: number }).sme_amendments_count = amendCount;
			// Re-run gates on the patched brief.
			const transcript = loadTranscript(sessionKey);
			const report = runAllGates(patched, transcript);
			if (!report.pass) {
				return json({
					ok: false,
					error: 'validation_error',
					gate_failures: report.findings,
					hint: 'Amend rejected — patched brief fails one or more high-severity gates. Fix the field values or use back-to-draft.',
				}, { status: 422 });
			}
			patched.gate_failures = report.findings.length > 0 ? report.findings.map((f) => ({
				rule: f.rule,
				severity: f.severity,
				field: f.field,
				message: f.message,
			})) : undefined;
			pendingPreview.set(sessionKey, patched);
			// ADR-009 P2 — keep the durable mirror in step with the patched brief
			// so a restart mid-amend doesn't revert to the pre-amend version.
			savePending(sessionKey, {
				brief: patched,
				transcript,
				project: loadPending(sessionKey)?.project,
			});
			return json({ ok: true, action, brief: patched });
		}
		case 'accept': {
			// Stamp confirmation metadata onto the brief, write to vault, clear state.
			const amendCount = ((brief as { sme_amendments_count?: number }).sme_amendments_count) ?? 0;
			const stamped: Brief & {
				sme_confirmed?: boolean;
				sme_confirmed_at?: string;
				sme_amendments_count?: number;
			} = {
				...brief,
				sme_confirmed: true,
				sme_confirmed_at: new Date().toISOString(),
				sme_amendments_count: amendCount,
			};
			const briefPath = await writeBrief(sessionKey, stamped);
			pendingPreview.delete(sessionKey);
			pendingTranscript.delete(sessionKey);
			pendingBriefPath.delete(sessionKey);
			clearPending(sessionKey); // ADR-009 P2 — drop the durable mirror; session is terminal
			return json({ ok: true, action, briefPath, brief: stamped });
		}
		case 'back-to-draft': {
			const reason = body.verdict_reason_sme?.trim() || 'SME marked back-to-draft (no reason provided).';
			const out: Brief & { sme_confirmed?: boolean; sme_confirmed_at?: string } = {
				...brief,
				verdict: 'back-to-draft',
				verdict_reason: reason,
				sme_confirmed: false,
				sme_confirmed_at: new Date().toISOString(),
			};
			const briefPath = await writeBrief(sessionKey, out);
			pendingPreview.delete(sessionKey);
			pendingTranscript.delete(sessionKey);
			pendingBriefPath.delete(sessionKey);
			clearPending(sessionKey); // ADR-009 P2 — drop the durable mirror; session is terminal
			return json({ ok: true, action, briefPath, brief: out });
		}
	}
}
