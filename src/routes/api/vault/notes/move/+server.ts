import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import type { MoveSpec } from '$lib/vault/relocate.js';

/** POST /api/vault/notes/move — ADR-004 (soul-hub-cli) link-safe relocation.
 *
 *  Single move:  { src, targetZone?, newFilename?, dryRun? }
 *  Batch move:   { moves: [{ src, targetZone?, newFilename? }, …], dryRun? }
 *
 *  Unlike `/api/vault/move` (keeper's file-only relocate), this rewrites every
 *  inbound wikilink across the vault — body AND frontmatter relationship fields
 *  — so nothing dangles, and moves the whole batch before rewriting so
 *  mutually-referencing notes relocate in one pass. `dryRun: true` returns the
 *  planned destinations + the exact notes whose links would be rewritten,
 *  writing nothing.
 */
function validSrc(p: unknown): p is string {
	return (
		typeof p === 'string' &&
		!p.includes('..') &&
		!p.startsWith('/') &&
		!p.includes('\0') &&
		p.endsWith('.md')
	);
}
function validZone(z: unknown): z is string {
	return typeof z === 'string' && !/\.\./.test(z) && !z.startsWith('/') && !z.includes('\0') && /^[\w\-./]+$/.test(z);
}
function validFilename(f: unknown): f is string {
	return typeof f === 'string' && /^[\w\-.]+\.md$/.test(f) && !f.includes('..') && !f.includes('/');
}

export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ success: false, error: 'Vault not initialized' }, { status: 503 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const dryRun = body.dryRun === true;
	const actor = typeof body.actor === 'string' ? body.actor : undefined;
	const actorContext = typeof body.actorContext === 'string' ? body.actorContext : undefined;

	// Normalise single-vs-batch into a MoveSpec[].
	const rawMoves: unknown[] = Array.isArray(body.moves) ? body.moves : [body];
	if (rawMoves.length === 0) {
		return json({ success: false, error: 'No moves supplied' }, { status: 400 });
	}

	const specs: MoveSpec[] = [];
	for (const m of rawMoves) {
		const move = m as Record<string, unknown>;
		if (!validSrc(move.src)) {
			return json({ success: false, error: `Invalid src: ${String(move.src)}` }, { status: 400 });
		}
		if (move.targetZone !== undefined && !validZone(move.targetZone)) {
			return json({ success: false, error: `Invalid targetZone: ${String(move.targetZone)}` }, { status: 400 });
		}
		if (move.newFilename !== undefined && !validFilename(move.newFilename)) {
			return json({ success: false, error: `Invalid newFilename: ${String(move.newFilename)}` }, { status: 400 });
		}
		if (move.targetZone === undefined && move.newFilename === undefined) {
			return json({ success: false, error: `Move for ${move.src} must change targetZone and/or newFilename` }, { status: 400 });
		}
		specs.push({
			src: move.src,
			targetZone: move.targetZone as string | undefined,
			newFilename: move.newFilename as string | undefined,
		});
	}

	try {
		const result = await engine.relocateNotes(specs, { dryRun, actor, actorContext });
		return json(result, { status: result.success ? 200 : 400 });
	} catch (err) {
		return json({ success: false, error: (err as Error).message }, { status: 500 });
	}
};
