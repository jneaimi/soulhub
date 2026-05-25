/** Persistent backing store for Telegram inline-button callback state
 *  (soul-hub-hygiene ADR-003 P6). Each surface registers a short_id → payload
 *  mapping when it sends a keyboard; the callback handler resolves the short_id
 *  back to the payload when the operator taps. Previously these lived in
 *  in-memory `Map`s in `callback.ts`, so a PM2 reload between send and tap
 *  orphaned the pending action — fine for the 1h conversational flows, but the
 *  hygiene escalations sit for days waiting on a human decision.
 *
 *  One generic table (`pending_callbacks` in the shared ops.db) keyed by
 *  `(kind, id)`. `kind` namespaces the surfaces so they stay logically separate
 *  (ADR-043's anti-abstraction call) while sharing storage mechanics + the TTL
 *  sweep. The SHA-1 short_id scheme in `callback.ts` is unchanged — only the
 *  storage moves. */

import { getHeartbeatDb } from '../whatsapp/heartbeat-state.js';

/** Logical namespace for a pending-callback surface. Mirrors the seven maps
 *  the migration replaced; add a member when a new keyboard surface appears. */
export type PendingKind =
	| 'proposal'
	| 'youtube'
	| 'intent-batch'
	| 'intent-proposal'
	| 'project-hygiene'
	| 'vault-hygiene'
	| 'fix-batch'
	| 'budget-approval'
	| 'budget-velocity';

/** Upsert a pending-callback row. `payload` is serialised to JSON; pass the row
 *  WITHOUT its `createdAt` field — the timestamps are columns. Re-registering an
 *  existing (kind, id) refreshes the payload and resets the TTL window. */
export function putPending(kind: PendingKind, id: string, payload: unknown, ttlMs: number): void {
	const now = Date.now();
	getHeartbeatDb()
		.prepare(
			`INSERT INTO pending_callbacks (kind, id, payload, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(kind, id) DO UPDATE SET
			   payload = excluded.payload,
			   created_at = excluded.created_at,
			   expires_at = excluded.expires_at`,
		)
		.run(kind, id, JSON.stringify(payload), now, now + ttlMs);
}

/** Resolve a short_id back to its payload. Returns `null` when the row is
 *  missing OR expired; an expired row is deleted on read so it can't linger. */
export function getPending<T>(kind: PendingKind, id: string): T | null {
	const db = getHeartbeatDb();
	const row = db
		.prepare(`SELECT payload, expires_at FROM pending_callbacks WHERE kind = ? AND id = ?`)
		.get(kind, id) as { payload: string; expires_at: number } | undefined;
	if (!row) return null;
	if (row.expires_at <= Date.now()) {
		deletePending(kind, id);
		return null;
	}
	return JSON.parse(row.payload) as T;
}

/** Remove a pending-callback row (called after the operator acts on it). */
export function deletePending(kind: PendingKind, id: string): void {
	getHeartbeatDb().prepare(`DELETE FROM pending_callbacks WHERE kind = ? AND id = ?`).run(kind, id);
}

/** Delete every expired row across all surfaces. Called opportunistically on
 *  registration (replacing the per-map inline sweep loops) — one indexed delete
 *  instead of iterating a Map. */
export function sweepExpiredPending(): void {
	getHeartbeatDb().prepare(`DELETE FROM pending_callbacks WHERE expires_at <= ?`).run(Date.now());
}

/** A persistent drop-in for the `Map<string, T>`s that `callback.ts` used to
 *  hold pending-button state. Exposes the `.set / .get / .delete` subset those
 *  call sites actually used, so migrating a map is a one-line declaration swap.
 *  `set` bakes in the surface's TTL and opportunistically sweeps expired rows
 *  (replacing the old inline `for…of` sweep loops); `get` returns `undefined`
 *  for missing OR expired rows, matching `Map.get` semantics. */
export interface PendingStore<T> {
	set(id: string, row: T): void;
	get(id: string): T | undefined;
	delete(id: string): void;
}

export function makePendingStore<T>(kind: PendingKind, ttlMs: number): PendingStore<T> {
	return {
		set(id, row) {
			putPending(kind, id, row, ttlMs);
			sweepExpiredPending();
		},
		get(id) {
			return getPending<T>(kind, id) ?? undefined;
		},
		delete(id) {
			deletePending(kind, id);
		},
	};
}
