/** ADR-009 P2 — durable mirror of the in-memory pending-preview maps.
 *
 *  The post-call webhook stashes the analyst's brief (+ verbatim transcript)
 *  in two in-memory `Map`s in `index.ts` (`pendingPreview`, `pendingTranscript`)
 *  and writes a human-facing brief note to the vault. The live accept flow
 *  (`GET /preview` → Accept/Amend/Back-to-draft) reads ONLY the in-memory maps.
 *
 *  Problem (observed 2026-05-31): if soul-hub restarts between the webhook
 *  landing and the app's poll, the maps are empty — the brief is in the vault
 *  but the live accept page never appears, and amend's gate re-run loses the
 *  transcript. See [[2026-05-31-post-call-correlate-by-provider-conversation-id]].
 *
 *  Fix: this module persists the SAME machine state to a JSON sidecar keyed by
 *  the ElevenLabs `conversation_id`. It is NOT the vault note — the vault note
 *  is the formatted, governed human artifact (lossy to re-parse into a Brief);
 *  this sidecar is the source of truth for re-hydrating the live flow after a
 *  restart. `/preview` reads it on a cache miss and re-warms the maps; the
 *  terminal handlers (accept / back-to-draft) clear it.
 *
 *  Files live at `~/.soul-hub/data/evaluate-previews/<conversation_id>.json`.
 */

import { writeFileSync, readFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubDataDir } from '$lib/paths.js';
import type { Brief } from './index.js';
import type { PersistedTurn } from './index.js';

/** TTL for un-accepted previews. Files older than this are pruned on save so
 *  abandoned sessions don't accumulate forever. A session that never reaches
 *  Accept/Back-to-draft is dead well before this. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingPreviewRecord {
	brief: Brief;
	transcript: PersistedTurn[];
	/** Vault project the brief was routed to (ADR-009 #2 multi-customer routing).
	 *  Recorded so a rehydrated session keeps its routing; optional for back-compat
	 *  with records written before routing existed. */
	project?: string;
	/** ISO timestamp of the last write — used for TTL pruning + debugging. */
	savedAt: string;
}

/** Directory holding the sidecar files. `soulHubDataDir` ensures the parent
 *  `data/` exists; we ensure the leaf via the same recursive-mkdir helper. */
function storeDir(): string {
	return soulHubDataDir('evaluate-previews');
}

/** Map a conversation_id to its sidecar path. The id is sanitized to a safe
 *  filename — it's an ElevenLabs-issued token (alnum + `-`/`_`), but we never
 *  trust an external id to be path-clean. */
function recordPath(conversationId: string): string {
	const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'session';
	return resolve(storeDir(), `${safe}.json`);
}

/** Persist (or overwrite) the pending record for a conversation. Atomic via
 *  tmp+rename so a crash mid-write never leaves a half-JSON file that would
 *  throw on the next read. Best-effort prune of stale records runs first. */
export function savePending(
	conversationId: string,
	record: Omit<PendingPreviewRecord, 'savedAt'>,
): void {
	pruneStale();
	const full: PendingPreviewRecord = { ...record, savedAt: new Date().toISOString() };
	const path = recordPath(conversationId);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(full), 'utf8');
	renameSync(tmp, path);
}

/** Read the durable record for a conversation, or null if absent/corrupt.
 *  A corrupt file (partial write that somehow escaped the atomic rename, or
 *  a manual edit) is treated as a miss — never throws into the request path. */
export function loadPending(conversationId: string): PendingPreviewRecord | null {
	const path = recordPath(conversationId);
	try {
		const raw = readFileSync(path, 'utf8');
		const parsed = JSON.parse(raw) as PendingPreviewRecord;
		if (!parsed || typeof parsed !== 'object' || !parsed.brief) return null;
		if (!Array.isArray(parsed.transcript)) parsed.transcript = [];
		return parsed;
	} catch {
		return null;
	}
}

/** Remove the durable record once the session reaches a terminal state
 *  (Accept / Back-to-draft). Idempotent — a missing file is not an error. */
export function clearPending(conversationId: string): void {
	try {
		unlinkSync(recordPath(conversationId));
	} catch {
		/* already gone — fine */
	}
}

/** Delete sidecar files older than MAX_AGE_MS. Best-effort: any per-file
 *  error (race with another delete, permission) is swallowed so a prune never
 *  breaks the save that triggered it. */
function pruneStale(): void {
	let entries: string[];
	try {
		entries = readdirSync(storeDir());
	} catch {
		return;
	}
	const cutoff = Date.now() - MAX_AGE_MS;
	for (const name of entries) {
		if (!name.endsWith('.json')) continue;
		const p = resolve(storeDir(), name);
		try {
			if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
		} catch {
			/* skip */
		}
	}
}
