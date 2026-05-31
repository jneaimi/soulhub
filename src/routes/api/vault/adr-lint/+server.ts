/** POST /api/vault/adr-lint — ADR lint pre-flight (ADR-044 P1+P2).
 *
 *  Two modes:
 *    1. Lint an existing note by path: { path: 'projects/foo/adr-NNN-...md' }
 *       — fetches via the vault engine, runs lint, returns findings.
 *    2. Lint a candidate note before write: { candidate: { path, meta, content } }
 *       — useful for the propose pre-flight where the note doesn't exist yet.
 *
 *  Response: { success: true, findings: Finding[], highSeverityCount: number }
 *  Returns 200 with success: true even if findings are non-empty. The CALLER
 *  decides what to do — the CLI exits non-zero on high-severity, the propose
 *  endpoint refuses, the dispatcher refuses. Lint itself is a read.
 *
 *  Errors (400/404/500) are reserved for the lint engine failing, not for
 *  finding violations. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { lintAdr, validatePhaseRoutingShape, type Finding, type AdrNoteForLint } from '$lib/vault/adr-lint.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { path?: string; candidate?: AdrNoteForLint };
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	let note: AdrNoteForLint;

	if (body.candidate) {
		if (
			typeof body.candidate.path !== 'string' ||
			typeof body.candidate.content !== 'string' ||
			!body.candidate.meta ||
			typeof body.candidate.meta !== 'object'
		) {
			return json({
				success: false,
				error: 'candidate must have { path: string, meta: object, content: string }',
			}, { status: 400 });
		}
		note = body.candidate;
	} else if (typeof body.path === 'string') {
		const engine = getVaultEngine();
		if (!engine) {
			return json({ success: false, error: 'Vault engine not initialized' }, { status: 503 });
		}
		const noteData = engine.getNote(body.path);
		if (!noteData) {
			return json({ success: false, error: `Note not found: ${body.path}` }, { status: 404 });
		}
		note = {
			path: noteData.path,
			meta: (noteData.meta ?? {}) as Record<string, unknown>,
			content: noteData.content ?? '',
		};
	} else {
		return json({
			success: false,
			error: 'Provide either { path } or { candidate: { path, meta, content } }',
		}, { status: 400 });
	}

	// Combine the runtime phase_routing shape check with the lint rules.
	// validatePhaseRoutingShape catches malformed phase_routing entries before
	// they're persisted; lintAdr applies the R5/R9/R11 corpus-survey rules.
	const findings: Finding[] = [
		...validatePhaseRoutingShape(note.meta),
		...lintAdr(note),
	];
	const highSeverityCount = findings.filter((f) => f.severity === 'high').length;

	return json({
		success: true,
		path: note.path,
		findings,
		highSeverityCount,
	});
};
