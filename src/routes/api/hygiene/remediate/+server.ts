import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import {
	unlinkBrokenWikilink,
	archiveOrphanNote,
	dropStaleInboxItem,
} from '$lib/vault-hygiene/link-actions.js';
import { suppressAnomaly } from '$lib/vault-hygiene/actions.js';
import { vaultHygieneKeyFor } from '$lib/vault-hygiene/vault-escalator.js';

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
 *  Defense-in-depth: rejects cross-site requests (same guard as
 *  /api/intent/proposed). Vault mutations are git-revertible.
 *
 *  Body: { action, bucket, source, raw? }
 *    action: 'unlink' | 'archive-orphan' | 'drop-stale' | 'dismiss'
 *    bucket: 'unresolved' | 'orphan_note' | 'stale_inbox_item'
 *    source: the note path (orphan/stale) or link source (unresolved)
 *    raw:    the raw wikilink target — required for 'unlink' + 'unresolved' dismiss
 */

const SUPPRESS_DAYS = 30;
const BUCKETS = ['unresolved', 'orphan_note', 'stale_inbox_item'] as const;
const ACTIONS = ['unlink', 'archive-orphan', 'drop-stale', 'dismiss'] as const;
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

	let body: { action?: string; bucket?: string; source?: string; raw?: string };
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, bucket, source, raw } = body;
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
		}
	} catch (err) {
		return json({ ok: false, error: (err as Error).message }, { status: 500 });
	}
};
