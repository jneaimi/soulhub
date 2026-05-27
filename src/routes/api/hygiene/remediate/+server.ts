import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import {
	unlinkBrokenWikilink,
	archiveOrphanNote,
	dropStaleInboxItem,
} from '$lib/vault-hygiene/link-actions.js';
import { suppressAnomaly, dispatchStatusFlip, setNoteStatus } from '$lib/vault-hygiene/actions.js';
import { vaultHygieneKeyFor } from '$lib/vault-hygiene/vault-escalator.js';
import { getMisplacedNotes } from '$lib/vault-hygiene/misplaced-notes.js';
import { getStatusContradictions } from '$lib/vault-hygiene/status-contradictions.js';
import { getAdrImplementationDrift } from '$lib/vault-hygiene/adr-implementation-drift.js';

/** POST /api/hygiene/remediate — web disposition for vault-side hygiene
 *  anomalies (soul-hub-hygiene ADR-005 P2 / ADR-004 Phase 2).
 *
 *  Mirrors the actions the Telegram `vh-*` callbacks already expose, so the
 *  /hygiene dashboard becomes a second action surface for the same anomalies.
 *  Reuses the existing remediation functions verbatim — only the trigger moves
 *  from a button tap to a web POST. There is no send→tap gap on the web path,
 *  so (unlike Telegram) no pending-callback state is persisted; the request
 *  carries the target directly.
 *
 *  ADR-006 P1.2 — adds `move` + `reopen-status` actions for the two previously
 *  unactionable buckets (`misplaced_note`, `status_contradiction`).
 *  Both actions re-validate the target at execute time (TOCTOU guard, ADR-006
 *  item 5): the report may be stale between `load()` and the tap. If the item
 *  is no longer flagged the handler returns 409 `{ok:false,error:'stale'}`.
 *  High classifier confidence ≠ correct (edge case #2) — confirm-move is NEVER
 *  blind; the dashboard requires the operator to confirm the destination.
 *
 *  Defense-in-depth: rejects cross-site requests (same guard as
 *  /api/intent/proposed). Vault mutations are git-revertible.
 *
 *  Body: { action, bucket?, source, raw?, targetZone?, status? }
 *    action:     'unlink' | 'archive-orphan' | 'drop-stale' | 'dismiss' | 'move' | 'reopen-status' | 'mark-shipped'
 *    bucket:     required for 'dismiss' — one of the BUCKETS list
 *    source:     the note path (orphan/stale/misplaced/status-drift/impl-drift) or link source (unresolved)
 *    raw:        the raw wikilink target — required for 'unlink' + 'unresolved' dismiss
 *    targetZone: target zone slug — required for 'move'
 *    status:     new status value — required for 'reopen-status'
 *
 *  ADR-009 adds:
 *    action: 'mark-shipped' — flips the ADR status to 'shipped' via setNoteStatus.
 *      TOCTOU guard: re-validates the item is still in the implementation-drift bucket.
 *    bucket: 'adr_implementation_drift' — for 'dismiss' (30-day suppress = "Not yet").
 */

const SUPPRESS_DAYS = 30;
const BUCKETS = [
	'unresolved',
	'orphan_note',
	'stale_inbox_item',
	'misplaced_note',
	'status_contradiction',
	'adr_implementation_drift',
] as const;
const ACTIONS = ['unlink', 'archive-orphan', 'drop-stale', 'dismiss', 'move', 'reopen-status', 'mark-shipped'] as const;
type Bucket = (typeof BUCKETS)[number];
type Action = (typeof ACTIONS)[number];

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	let body: {
		action?: string;
		bucket?: string;
		source?: string;
		raw?: string;
		targetZone?: string;
		status?: string;
	};
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, bucket, source, raw, targetZone, status: flipStatus } = body;
	if (!action || !ACTIONS.includes(action as Action)) {
		return json({ ok: false, error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
	}
	if (!source || typeof source !== 'string') {
		return json({ ok: false, error: 'source is required' }, { status: 400 });
	}
	if (action === 'unlink' && (!raw || typeof raw !== 'string')) {
		return json({ ok: false, error: 'raw is required for unlink' }, { status: 400 });
	}
	if (action === 'dismiss' && (!bucket || !BUCKETS.includes(bucket as Bucket))) {
		return json({ ok: false, error: `dismiss requires bucket in ${BUCKETS.join(', ')}` }, { status: 400 });
	}
	if (action === 'move' && (!targetZone || typeof targetZone !== 'string')) {
		return json({ ok: false, error: 'targetZone is required for move' }, { status: 400 });
	}
	if (action === 'reopen-status' && (!flipStatus || typeof flipStatus !== 'string')) {
		return json({ ok: false, error: 'status is required for reopen-status' }, { status: 400 });
	}

	const engine = getVaultEngine();
	if (!engine) return json({ ok: false, error: 'vault-engine-not-ready' }, { status: 503 });
	const vaultDir = engine.vaultDir;

	try {
		switch (action as Action) {
			case 'unlink':
				return json(await unlinkBrokenWikilink(source, raw as string, vaultDir));
			case 'archive-orphan':
				return json(await archiveOrphanNote(source, vaultDir));
			case 'drop-stale':
				return json(await dropStaleInboxItem(source, vaultDir));
			case 'dismiss': {
				// Suppression key mirrors the escalator: composite for broken
				// links, the bare path for orphan/stale.
				const key = bucket === 'unresolved' ? vaultHygieneKeyFor(source, raw ?? '') : source;
				return json(await suppressAnomaly(key, bucket as string, SUPPRESS_DAYS));
			}
			case 'move': {
				// ADR-006 P1.2 — TOCTOU re-validation (item 5).
				// Re-run the misplaced detector so a stale report cannot cause a
				// blind move: if the item is no longer flagged OR the suggested
				// zone changed since load(), reject with 409 stale.
				// High confidence ≠ correct (edge case #2) — the confirm prompt in
				// the dashboard is the operator's last line of defence; this guard
				// is the server-side backstop.
				const freshMisplaced = getMisplacedNotes(engine);
				const stillFlagged = freshMisplaced.find(
					(m) => m.path === source && m.suggestedZone === targetZone,
				);
				if (!stillFlagged) {
					return json({ ok: false, error: 'stale' }, { status: 409 });
				}
				const moveResult = await engine.moveNote(source, targetZone as string);
				if (!moveResult.success) {
					return json({ ok: false, error: moveResult.error }, { status: 400 });
				}
				return json({ ok: true, detail: `moved ${source} → ${moveResult.path}` });
			}
			case 'reopen-status': {
				// ADR-006 P1.2 — TOCTOU re-validation (item 5).
				// Re-run the status-contradiction detector before flipping: if the
				// item was already resolved (or the report was stale), don't flip.
				const freshContradictions = getStatusContradictions(engine);
				const stillFlagged = freshContradictions.find((sc) => sc.path === source);
				if (!stillFlagged) {
					return json({ ok: false, error: 'stale' }, { status: 409 });
				}
				// dispatchStatusFlip is dual-file-aware (P1.1): routes project
				// pairs through setProjectStatus + reconcileDualStatus; everything
				// else through setNoteStatus (ADR-046 write chokepoint).
				return json(await dispatchStatusFlip(source, flipStatus as string, vaultDir));
			}
			case 'mark-shipped': {
				// ADR-009 — TOCTOU re-validation: re-run the implementation drift
				// detector before flipping. If the item is no longer flagged (e.g.
				// the operator already shipped it in another session), return 409.
				const freshDrift = await getAdrImplementationDrift(engine);
				const stillFlagged = freshDrift.find((d) => d.path === source);
				if (!stillFlagged) {
					return json({ ok: false, error: 'stale' }, { status: 409 });
				}
				// setNoteStatus runs through the ADR-046 write chokepoint:
				// governance gates + audit-log + git commit.  Only valid
				// for non-project-pair notes (ADR-009 targets are always ADR
				// files, not project index/project.md pairs).
				return json(await setNoteStatus(source, 'shipped'));
			}
		}
	} catch (err) {
		return json({ ok: false, error: (err as Error).message }, { status: 500 });
	}
};
