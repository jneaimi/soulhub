/**
 * Naseej audit DB — `~/.soul-hub/data/naseej.db`.
 *
 * Tables (per ADR-021):
 *   - naseej_runs          — one row per recipe run (lifecycle: running → success/failed/cancelled)
 *   - naseej_publish_log   — one row per POST /api/components attempt (passed/failed)
 *
 * Owns DDL only. DML lives in `./audit.ts` — same split as
 * `src/lib/channels/whatsapp/heartbeat-state.ts` (DDL) +
 * `src/lib/agents/runs.ts` (DML).
 *
 * Distinct from `heartbeat.db` (whatsapp/agents) so a future ADR-009
 * artefact-versioning table can land here without crowding the heartbeat
 * schema. Naseej runs are scheduler-adjacent but conceptually separate.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../paths.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	const dir = soulHubDataDir();
	mkdirSync(dir, { recursive: true });
	return resolve(dir, 'naseej.db');
}

export function getNaseejDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('busy_timeout = 5000');

	migrate(db);
	return db;
}

export function closeNaseejDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		// ADR-021 Track 1 — audit-trail v1 schema.
		// run_id is UNIQUE: runner.ts uses randomUUID().slice(0,8) so collisions
		// are vanishingly unlikely; UNIQUE makes the start-hook idempotent
		// (re-issuing the insert on retry would 19/SQLITE_CONSTRAINT, caller logs
		// + moves on rather than double-inserting).
		// status enum is enforced in the query layer, not at the DB level — keeps
		// migrations forward-compatible when ADR-011 adds `paused`.
		db.exec(`
			CREATE TABLE IF NOT EXISTS naseej_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL UNIQUE,
				recipe          TEXT    NOT NULL,
				recipe_version  TEXT    NOT NULL,
				project         TEXT    NOT NULL,
				status          TEXT    NOT NULL,
				started_at      INTEGER NOT NULL,
				finished_at     INTEGER,
				duration_ms     INTEGER,
				mode            TEXT    NOT NULL DEFAULT 'production',
				source          TEXT    NOT NULL DEFAULT 'api',
				steps_json      TEXT,
				error           TEXT,
				failed_step     TEXT,
				cost_usd        REAL
			);
			CREATE INDEX IF NOT EXISTS idx_naseej_runs_recipe_started
				ON naseej_runs(recipe, started_at DESC);
			CREATE INDEX IF NOT EXISTS idx_naseej_runs_status_started
				ON naseej_runs(status, started_at DESC);

			CREATE TABLE IF NOT EXISTS naseej_publish_log (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				component       TEXT    NOT NULL,
				version         TEXT,
				published_at    INTEGER NOT NULL,
				status          TEXT    NOT NULL,
				checks_json     TEXT    NOT NULL,
				duration_ms     INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_naseej_publish_component_published
				ON naseej_publish_log(component, published_at DESC);
		`);
		db.pragma('user_version = 1');
	}
}
