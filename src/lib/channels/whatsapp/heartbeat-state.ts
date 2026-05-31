/** Shared ops persistence — better-sqlite3 at
 *  `~/.soul-hub/data/ops/ops.db` (relocated from `data/whatsapp/heartbeat.db`
 *  in ADR-001 P4; a boot-time shim moves the legacy file on first access).
 *  Tables:
 *
 *   - proactive_log   — every tick (sent / ack / gated / skipped / error)
 *   - daily_counter   — per-target, per-day count for the maxPerDay gate
 *   - task_state      — per-task lastRunAt for the per-task interval gate
 *   - commitments     — Slice 5 inferred follow-ups, scoped to (channel, target)
 *   - scheduler_runs  — Phase 1 scheduler run history (owned by scheduler/)
 *   - voice_acks      — Phase 4 voice-queue acks (per ADR-003 amended)
 *
 *  Mirrors the lazy-singleton + WAL pattern from `src/lib/inbox/db.ts`.
 *  Distinct DB from inbox.db (which is the Outlook email cache, unrelated).
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../../paths.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	const dir = soulHubDataDir('ops');
	mkdirSync(dir, { recursive: true });
	const dest = resolve(dir, 'ops.db');
	relocateLegacyDb(dest);
	return dest;
}

/** One-time relocation (ADR-001 P4): move the shared ops DB from its legacy
 *  WhatsApp-scoped home to `data/ops/`. Idempotent — fires only when the legacy
 *  file exists and the new one does not. Moves the WAL + shm sidecars before the
 *  main `.db` so an interrupted move retries cleanly instead of orphaning the
 *  un-checkpointed WAL. */
function relocateLegacyDb(dest: string): void {
	const legacy = resolve(soulHubDataDir('whatsapp'), 'heartbeat.db');
	if (!existsSync(legacy) || existsSync(dest)) return;
	for (const suffix of ['-wal', '-shm', '']) {
		const from = legacy + suffix;
		if (existsSync(from)) renameSync(from, dest + suffix);
	}
}

export function getHeartbeatDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('busy_timeout = 5000');

	migrate(db);
	return db;
}

export function closeHeartbeatDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS proactive_log (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				ts          INTEGER NOT NULL,
				target      TEXT    NOT NULL,
				task_name   TEXT,
				status      TEXT    NOT NULL,
				text        TEXT,
				tokens_in   INTEGER,
				tokens_out  INTEGER,
				model       TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_proactive_log_ts ON proactive_log(ts DESC);
			CREATE INDEX IF NOT EXISTS idx_proactive_log_target ON proactive_log(target);

			CREATE TABLE IF NOT EXISTS daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);

			CREATE TABLE IF NOT EXISTS task_state (
				task_name    TEXT PRIMARY KEY,
				last_run_at  INTEGER NOT NULL
			);
		`);
		db.pragma('user_version = 1');
	}

	if (version < 2) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS commitments (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				channel         TEXT    NOT NULL,
				target          TEXT    NOT NULL,
				suggested_text  TEXT    NOT NULL,
				due_after_ts    INTEGER NOT NULL,
				status          TEXT    NOT NULL DEFAULT 'pending',
				source_msg_id   TEXT,
				confidence      REAL    NOT NULL,
				created_at      INTEGER NOT NULL,
				surfaced_at     INTEGER,
				dismissed_at    INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_commitments_due
				ON commitments(channel, target, status, due_after_ts);
			CREATE INDEX IF NOT EXISTS idx_commitments_created
				ON commitments(created_at DESC);
		`);
		db.pragma('user_version = 2');
	}

	if (version < 3) {
		// `/img` per-target daily cap. Kept distinct from `daily_counter`
		// (which is the heartbeat budget) so the two budgets don't collide.
		db.exec(`
			CREATE TABLE IF NOT EXISTS img_daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);
		`);
		db.pragma('user_version = 3');
	}

	if (version < 4) {
		// scheduler_runs is owned by `src/lib/scheduler/` (domain-agnostic
		// task registry). It lives in this DB per ADR-002 so future tables
		// (e.g. voice_acks in Phase 4) can join transactionally with run
		// history. The schema definition stays here because heartbeat-state
		// is the single migration owner for this file.
		db.exec(`
			CREATE TABLE IF NOT EXISTS scheduler_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				task_id         TEXT    NOT NULL,
				scheduled_for   TEXT    NOT NULL,
				started_at      TEXT    NOT NULL,
				finished_at     TEXT,
				status          TEXT    NOT NULL,
				duration_ms     INTEGER,
				error_message   TEXT,
				output_summary  TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_scheduler_runs_task_id_started
				ON scheduler_runs(task_id, started_at DESC);
		`);
		db.pragma('user_version = 4');
	}

	if (version < 5) {
		// voice_acks — heartbeat consumer's record of which inbox notes
		// it has already surfaced. Per ADR-003 amended, ack_method = 'auto'
		// on successful delivery. Reply-based ack ('done'/'skip'/'later')
		// lands in Phase 4.5 via UPDATEs to ack_method.
		//
		// note_path is the PK because each inbox note has a stable vault-
		// relative path that uniquely identifies it across reindex events.
		// If the note is later deleted from the vault, the row stays —
		// cheap, and the daily voice_acks cleanup task (TBD) prunes by age.
		db.exec(`
			CREATE TABLE IF NOT EXISTS voice_acks (
				note_path   TEXT    PRIMARY KEY,
				acked_at    INTEGER NOT NULL,
				ack_method  TEXT    NOT NULL DEFAULT 'auto'
			);
			CREATE INDEX IF NOT EXISTS idx_voice_acks_acked_at
				ON voice_acks(acked_at DESC);
		`);
		db.pragma('user_version = 5');
	}

	if (version < 6) {
		// Phase 4.5 — `cooldown_until` supports the `reply-later` ack
		// method. A row with `cooldown_until > now` is treated as acked
		// (won't re-fire). Once the cooldown passes, the row is treated
		// as NOT acked — the note becomes eligible for the next tick to
		// surface again. NULL = no cooldown (auto / reply-done /
		// reply-skip are permanent acks within the inbox 30-day archive
		// window).
		db.exec(`
			ALTER TABLE voice_acks ADD COLUMN cooldown_until INTEGER;
		`);
		db.pragma('user_version = 6');
	}

	if (version < 7) {
		// Phase 7 — Vault-Scout idempotency + audit. Owned conceptually
		// by `src/lib/scheduler/handlers/vault-scout.ts` per ADR-007;
		// schema lives here for the same reason scheduler_runs / voice_acks
		// do (single migration owner per DB file).
		//
		// vault_scout_decisions: per-candidate decision record. PK on
		// candidate_id ensures each candidate is decided AT MOST ONCE
		// (re-running the scout same-day with the same candidates is a
		// no-op). decision = 'queued' | 'skipped' | 'deferred'. note_path
		// is set only for 'queued' decisions.
		//
		// vault_scout_rejects: audit log for synthesizer outputs that
		// failed validation (bad date, missing required field, etc.).
		// Not user-visible; useful for debugging prompt drift.
		db.exec(`
			CREATE TABLE IF NOT EXISTS vault_scout_decisions (
				candidate_id  TEXT    PRIMARY KEY,
				decision      TEXT    NOT NULL,
				decided_at    INTEGER NOT NULL,
				note_path     TEXT,
				model_used    TEXT,
				reason        TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_decisions_decided_at
				ON vault_scout_decisions(decided_at DESC);

			CREATE TABLE IF NOT EXISTS vault_scout_rejects (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				candidate_id      TEXT,
				raw_synth_output  TEXT,
				reject_reason     TEXT NOT NULL,
				recorded_at       INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_rejects_recorded_at
				ON vault_scout_rejects(recorded_at DESC);
		`);
		db.pragma('user_version = 7');
	}

	if (version < 8) {
		// Phase 5 of soul-hub-agents — `agent_runs` registry. Owned conceptually
		// by `src/lib/agents/runs.ts`; schema lives here for the same single-
		// migration-owner reason as `scheduler_runs` / `voice_acks`. Schema
		// derives from soul-hub-whatsapp ADR-005 with two Soul-Hub-agents
		// extensions: `mode` (production|test — keeps test-runner blips out
		// of lifetime stats) and `backend`/`provider`/`model` for analytics.
		// `jid` and `source_message` stay nullable — only WhatsApp dispatch
		// (ADR-005) populates them; UI/API dispatches leave them NULL.
		db.exec(`
			CREATE TABLE IF NOT EXISTS agent_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL,
				agent_id        TEXT    NOT NULL,
				backend         TEXT    NOT NULL,
				model           TEXT,
				provider        TEXT,
				mode            TEXT    NOT NULL DEFAULT 'production',
				task_spec       TEXT    NOT NULL,
				source_message  TEXT,
				jid             TEXT,
				started_at      INTEGER NOT NULL,
				finished_at     INTEGER,
				duration_ms     INTEGER,
				status          TEXT    NOT NULL,
				cost_usd        REAL    NOT NULL DEFAULT 0,
				num_turns       INTEGER NOT NULL DEFAULT 0,
				result_excerpt  TEXT,
				error_message   TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
				ON agent_runs(agent_id, started_at DESC);
			CREATE INDEX IF NOT EXISTS idx_agent_runs_run_id
				ON agent_runs(run_id);
			CREATE INDEX IF NOT EXISTS idx_agent_runs_jid_started
				ON agent_runs(jid, started_at DESC) WHERE jid IS NOT NULL;
		`);
		db.pragma('user_version = 8');
	}

	if (version < 9) {
		// ADR-012 — `youtubeFetch` per-target daily cap for the Gemini
		// transcript tier. Free transcript paths from server IPs are
		// 429-blocked (validated 2026-05-07), so Gemini is the only
		// reliable path. Per-target cap so one user's share-spam can't
		// burn the global budget.
		db.exec(`
			CREATE TABLE IF NOT EXISTS youtube_daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);
		`);
		db.pragma('user_version = 9');
	}

	if (version < 10) {
		// ADR-024 — `tiktokFetch` per-target daily cap for the Gemini
		// summary tier. Same shape as youtube_daily_counter; kept distinct
		// so a heavy YouTube-summary day doesn't lock out TikTok summaries
		// and vice versa.
		db.exec(`
			CREATE TABLE IF NOT EXISTS tiktok_daily_counter (
				target  TEXT NOT NULL,
				ymd     TEXT NOT NULL,
				count   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (target, ymd)
			);
		`);
		db.pragma('user_version = 10');
	}

	if (version < 11) {
		// ADR-025 — `scheduleReminder` tool. Adds a `source` discriminator to
		// commitments so user-explicit reminders set via the orchestrator can
		// coexist with extractor-inferred follow-ups in the same table. The
		// heartbeat reads them as two separate slices with independent caps;
		// future hygiene queries can split user-explicit from inferred without
		// joining on `source_msg_id IS NULL`.
		//
		// Default 'extractor' is correct: every row predating this migration
		// came from `commitments-extractor.ts`.
		db.exec(`
			ALTER TABLE commitments ADD COLUMN source TEXT NOT NULL DEFAULT 'extractor';
			CREATE INDEX IF NOT EXISTS idx_commitments_source
				ON commitments(channel, target, source, status, due_after_ts);
		`);
		db.pragma('user_version = 11');
	}

	if (version < 12) {
		// project-phases ADR-008 S1 — assumption-rate audit. One row per
		// scored transcript; `linked_projects` stored as JSON-array TEXT
		// (mirrors intent_log's `tags`/`context_keys` convention from
		// ADR-023). Project-filtered queries JSON-decode in app layer.
		// Layer A signals + sample_claims also JSON-encoded TEXT; Layer B
		// LLM fields nullable (added pre-S3). `dismissed_*` columns let
		// operator mark false positives (F4 tracking).
		db.exec(`
			CREATE TABLE IF NOT EXISTS assumption_audits (
				id                   INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id           TEXT    NOT NULL,
				transcript_path      TEXT    NOT NULL,
				audited_at           INTEGER NOT NULL,
				score                INTEGER NOT NULL,
				deterministic_score  INTEGER NOT NULL,
				llm_score            INTEGER,
				signals              TEXT    NOT NULL,
				sample_claims        TEXT    NOT NULL,
				linked_projects      TEXT    NOT NULL DEFAULT '[]',
				dismissed_at         INTEGER,
				dismissed_reason     TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_assumption_audits_audited_at
				ON assumption_audits(audited_at DESC);
			CREATE INDEX IF NOT EXISTS idx_assumption_audits_session
				ON assumption_audits(session_id);
			CREATE INDEX IF NOT EXISTS idx_assumption_audits_score
				ON assumption_audits(score DESC);
		`);
		db.pragma('user_version = 12');
	}

	if (version < 13) {
		// project-phases ADR-008 post-S2 hardening — separate audit
		// performance time from transcript mtime. v12 conflated them,
		// which made the dashboard's default `?since=30d` filter behave
		// surprisingly: it filtered by SESSION recency, not AUDIT
		// recency. The scanner watermark still wants the file mtime, but
		// the operator dashboard wants the audit time.
		//
		// Backfill: existing rows have `audited_at == file.mtime` (the
		// old conflated semantic), so transcript_mtime = audited_at is
		// the correct historical value. Going forward, saveAudit writes
		// audited_at=Date.now() and transcript_mtime=file.mtime; the
		// watermark query reads MAX(transcript_mtime) per path.
		db.exec(`
			ALTER TABLE assumption_audits ADD COLUMN transcript_mtime INTEGER NOT NULL DEFAULT 0;
			UPDATE assumption_audits SET transcript_mtime = audited_at WHERE transcript_mtime = 0;
			CREATE INDEX IF NOT EXISTS idx_assumption_audits_transcript_mtime
				ON assumption_audits(transcript_path, transcript_mtime DESC);
		`);
		db.pragma('user_version = 13');
	}

	if (version < 14) {
		// project-phases ADR-008 S3 — Layer B Haiku 4.5 LLM grader.
		// `llm_claims` stores the LLM's classification list as JSON
		// (each entry: {text, classification: 'verified'|'inferred'|'assumed'}).
		// `llm_cost_usd` is the per-audit measured cost — used by F2
		// (cost stays under $0.05/audit).
		db.exec(`
			ALTER TABLE assumption_audits ADD COLUMN llm_claims TEXT;
			ALTER TABLE assumption_audits ADD COLUMN llm_cost_usd REAL;
			ALTER TABLE assumption_audits ADD COLUMN llm_model TEXT;
		`);
		db.pragma('user_version = 14');
	}

	if (version < 15) {
		// project-phases ADR-008 S4 — Telegram nudge dedup. Set when an
		// audit is included in a nudge message so subsequent nudges
		// don't re-surface the same row. Distinct from dismissed_at
		// (which is operator-action); a nudged audit can still be
		// dismissed later.
		db.exec(`
			ALTER TABLE assumption_audits ADD COLUMN nudged_at INTEGER;
			CREATE INDEX IF NOT EXISTS idx_assumption_audits_nudge_candidates
				ON assumption_audits(score DESC, audited_at DESC)
				WHERE dismissed_at IS NULL AND nudged_at IS NULL;
		`);
		db.pragma('user_version = 15');
	}

	if (version < 16) {
		// project-phases ADR-009 S1 — vault-scout unblock-watch snapshot
		// table. One row per (dependent, blocker) pair. The scout's
		// per-run extractor diffs the live `meta.status` of each blocker
		// against the snapshotted status; transitions to shipped/superseded
		// drive unblock candidate emission. First observation of a pair is
		// quiet (INSERT only), so first post-deploy run produces zero
		// alerts even when 30+ blocked_by relationships already exist.
		// Lives in this file (not vault-scout.ts) for the same single-
		// migration-owner reason as vault_scout_decisions (v7).
		db.exec(`
			CREATE TABLE IF NOT EXISTS vault_scout_blocker_snapshots (
				dependent_path  TEXT    NOT NULL,
				blocker_path    TEXT    NOT NULL,
				blocker_status  TEXT    NOT NULL,
				recorded_at     INTEGER NOT NULL,
				PRIMARY KEY (dependent_path, blocker_path)
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_blocker_snapshots_dep
				ON vault_scout_blocker_snapshots(dependent_path);
		`);
		db.pragma('user_version = 16');
	}

	if (version < 17) {
		// projects-graph ADR-006 — vault-scout edge-stale snapshot table.
		// One row per (producer, consumer) edge with a rich-form destination.
		// Per-run extractor probes `edge-flow.ts` for each destination,
		// records newest mtime, and emits `kind: 'edge-stale'` candidates
		// when (now - last_flow_mtime) exceeds the declared falsifier
		// window. Mirrors v16's snapshot convention exactly — first
		// observation is QUIET (INSERT only). Single-migration-owner per
		// the v7/v16 precedent.
		db.exec(`
			CREATE TABLE IF NOT EXISTS vault_scout_edge_snapshots (
				producer_slug    TEXT    NOT NULL,
				consumer_slug    TEXT    NOT NULL,
				destination      TEXT    NOT NULL,
				last_flow_mtime  INTEGER,
				last_check_at    INTEGER NOT NULL,
				PRIMARY KEY (producer_slug, consumer_slug)
			);
			CREATE INDEX IF NOT EXISTS idx_vault_scout_edge_snapshots_prod
				ON vault_scout_edge_snapshots(producer_slug);
		`);
		db.pragma('user_version = 17');
	}

	if (version < 18) {
		// soul-hub-agents ADR-002 Layer 1 — persist Claude Code's session UUID
		// per run so the JSONL transcript stays locatable for replay/audit long
		// after the in-process dispatch context is gone. Nullable: rows predating
		// this migration have no recorded transcript id, and non-PTY backends may
		// not set one. The `claude-pty` dispatcher sets a deterministic
		// `--session-id`; `run_id` is its 8-char prefix.
		db.exec(`
			ALTER TABLE agent_runs ADD COLUMN claude_session_id TEXT;
			CREATE INDEX IF NOT EXISTS idx_agent_runs_claude_session
				ON agent_runs(claude_session_id) WHERE claude_session_id IS NOT NULL;
		`);
		db.pragma('user_version = 18');
	}

	if (version < 19) {
		// soul-hub-hygiene ADR-003 P6 — persist Telegram callback escalation state
		// so a PM2 reload between sending an inline-button and the operator tapping
		// it no longer orphans the action. Replaces seven in-memory `Map`s in
		// channels/telegram/callback.ts. `kind` namespaces the surfaces (proposal /
		// youtube / intent-batch / intent-proposal / project-hygiene / vault-hygiene
		// / fix-batch) so they stay logically separate (ADR-043) while sharing one
		// table. `payload` is the row JSON minus the timestamps; `expires_at` carries
		// each surface's own TTL so the sweep is a single indexed delete.
		db.exec(`
			CREATE TABLE IF NOT EXISTS pending_callbacks (
				kind        TEXT    NOT NULL,
				id          TEXT    NOT NULL,
				payload     TEXT    NOT NULL,
				created_at  INTEGER NOT NULL,
				expires_at  INTEGER NOT NULL,
				PRIMARY KEY (kind, id)
			);
			CREATE INDEX IF NOT EXISTS idx_pending_callbacks_expires
				ON pending_callbacks(expires_at);
		`);
		db.pragma('user_version = 19');
	}

	if (version < 20) {
		// projects-graph ADR-018 S2b — link an agent run to the vault artifact it
		// is working on, so the Handoff Workbench `in_flight` lane can surface
		// running dispatches cross-session (a page reload no longer loses the
		// "working" state). Nullable: orchestrator/CI runs leave it unset.
		db.exec(`ALTER TABLE agent_runs ADD COLUMN subject_path TEXT;`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_agent_runs_subject_running
				ON agent_runs(subject_path) WHERE finished_at IS NULL;
		`);
		db.pragma('user_version = 20');
	}

	if (version < 21) {
		// projects-graph ADR-026 D3 — persist the raw hand-back ```json``` block
		// untruncated so the Handoff Workbench review card can always parse
		// gate_results, summary, and follow_ups — even when the full run output
		// exceeds the 800-char result_excerpt limit. The block is typically
		// ≤ 1 KB so no separate BLOB column is needed. Nullable: rows predating
		// this migration have no stored hand-back; the worklist falls back to
		// result_excerpt for back-compat. Idempotent: ALTER TABLE is a no-op on
		// re-run if the column already exists (SQLite ignores duplicate ADD COLUMN
		// wrapped in `IF NOT EXISTS`-equivalent try/catch at the call site — but
		// the version guard above is the real idempotency mechanism).
		db.exec(`ALTER TABLE agent_runs ADD COLUMN handback TEXT;`);
		db.pragma('user_version = 21');
	}

	if (version < 22) {
		// projects-graph ADR-031 P1 — persist the dispatcher's resolved
		// `effectiveRepo` per run so ship-merge and review-handoff can operate
		// git in the run's repo rather than hardcoded soul-hub.
		// null = legacy/soul-hub (null-default is backward compatible: every row
		// predating this migration reads as soul-hub via the ?? fallback in the
		// endpoint layer). The stored value is the expanded absolute path written
		// by the dispatcher at dispatch time (expandHome applied).
		db.exec(`ALTER TABLE agent_runs ADD COLUMN repo TEXT;`);
		db.pragma('user_version = 22');
	}

	if (version < 23) {
		// projects-graph ADR-019 — proactive prep snapshot table.
		// One row per task_path that the proactive prep action layer has
		// encountered. prep_path=null means first-observation recorded (quiet,
		// dispatch not yet emitted); prep_path non-null means a dispatch was
		// emitted for this task (dedup lock). Mirrors the v16 blocker-snapshot
		// convention exactly — first observation is QUIET so the first
		// post-deploy run is noise-free even with a backlog of unblocked tasks.
		// Single-migration-owner per the v7/v16/v17 precedent.
		db.exec(`
			CREATE TABLE IF NOT EXISTS proactive_prep_snapshots (
				task_path    TEXT    NOT NULL PRIMARY KEY,
				prep_path    TEXT,
				recorded_at  INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_proactive_prep_snapshots_recorded
				ON proactive_prep_snapshots(recorded_at DESC);
		`);
		db.pragma('user_version = 23');
	}

	if (version < 24) {
		// soul-hub-agents ADR-020 P1 — phase-tagged runs.  Conventional values
		// (descriptive, not validated): 'initial' | 'P1' | 'P2' | 'finish' |
		// 'falsifier' | 'iterate-N' — the operator/dispatcher sets it.  null =
		// pre-migration runs, treated as 'initial' at read time.  The drawer's
		// per-ADR run-history strip groups by phase + sums cumulative cost,
		// which is the foundation for ADR-020 P2 (resume) and P3 (cumulative
		// budget gate) to compose on top.
		db.exec(`ALTER TABLE agent_runs ADD COLUMN phase TEXT;`);
		db.pragma('user_version = 24');
	}

	if (version < 25) {
		// soul-hub-agents ADR-020 P4 — mid-run path-scope enforcement.
		// `scope_json` snapshots the ADR's `scope: { allowed_paths, forbidden_paths }`
		// at dispatch start so the dispatch-scope-guard.sh PreToolUse hook can
		// look it up by claude_session_id and refuse out-of-scope writes.  null =
		// no enforcement (backward-compat for legacy runs + ADRs without
		// `scope:`).  `dispatch_scope_blocks` records every blocked attempt so
		// the operator gets an audit trail of the agent's blocked tool calls.
		db.exec(`ALTER TABLE agent_runs ADD COLUMN scope_json TEXT;`);
		db.exec(`
			CREATE TABLE dispatch_scope_blocks (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id            TEXT    NOT NULL,
				claude_session_id TEXT,
				tool_name         TEXT    NOT NULL,
				target_path       TEXT    NOT NULL,
				reason            TEXT    NOT NULL,
				blocked_at        INTEGER NOT NULL
			);
			CREATE INDEX idx_dispatch_scope_blocks_session
				ON dispatch_scope_blocks(claude_session_id);
			CREATE INDEX idx_dispatch_scope_blocks_run
				ON dispatch_scope_blocks(run_id);
		`);
		db.pragma('user_version = 25');
	}
}

/** Heartbeat run statuses logged to `proactive_log`. */
export type HeartbeatStatus =
	| 'sent'
	| 'ack'
	| 'skipped_empty'
	| 'gated_active_hours'
	| 'gated_cap'
	| 'gated_mute'
	| 'error';

export interface LogEntry {
	ts: number;
	target: string;
	taskName?: string;
	status: HeartbeatStatus;
	text?: string;
	tokensIn?: number;
	tokensOut?: number;
	model?: string;
}

export function appendLog(entry: LogEntry): void {
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO proactive_log (ts, target, task_name, status, text, tokens_in, tokens_out, model)
		 VALUES (@ts, @target, @taskName, @status, @text, @tokensIn, @tokensOut, @model)`,
	);
	stmt.run({
		ts: entry.ts,
		target: entry.target,
		taskName: entry.taskName ?? null,
		status: entry.status,
		text: entry.text ?? null,
		tokensIn: entry.tokensIn ?? null,
		tokensOut: entry.tokensOut ?? null,
		model: entry.model ?? null,
	});
}

export function recentLog(limit = 20): LogEntry[] {
	const rows = getHeartbeatDb()
		.prepare(
			`SELECT ts, target, task_name as taskName, status, text, tokens_in as tokensIn, tokens_out as tokensOut, model
			 FROM proactive_log ORDER BY ts DESC LIMIT ?`,
		)
		.all(limit) as LogEntry[];
	return rows;
}

/** YYYY-MM-DD in the given IANA timezone. Used for the per-day cap key
 *  so the day boundary follows the user's wall clock, not UTC. */
export function ymdInTimezone(timezone: string, at = Date.now()): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date(at));
}

export function getDailyCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementDailyCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

/** Per-target `/img` count for the current day (in the user's wall-clock
 *  timezone). Distinct from `daily_counter`, which tracks the heartbeat. */
export function getImgCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM img_daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementImgCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO img_daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

/** Per-target `youtubeFetch` Gemini-tier count for the current day (in the
 *  user's wall-clock timezone). Distinct from `img_daily_counter` so the
 *  two budgets don't collide — a heavy image-gen day shouldn't lock out
 *  YouTube transcripts and vice versa. */
export function getYoutubeCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM youtube_daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementYoutubeCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO youtube_daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

/** Per-target `tiktokFetch` Gemini-tier count for the current day (in the
 *  user's wall-clock timezone). Only increments on successful Tier C calls
 *  (Tier A metadata + Tier B local whisper are free and uncounted). */
export function getTiktokCount(target: string, ymd: string): number {
	const row = getHeartbeatDb()
		.prepare('SELECT count FROM tiktok_daily_counter WHERE target = ? AND ymd = ?')
		.get(target, ymd) as { count: number } | undefined;
	return row?.count ?? 0;
}

export function incrementTiktokCount(target: string, ymd: string): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO tiktok_daily_counter (target, ymd, count) VALUES (?, ?, 1)
			 ON CONFLICT(target, ymd) DO UPDATE SET count = count + 1`,
		)
		.run(target, ymd);
}

export function getTaskLastRun(taskName: string): number | undefined {
	const row = getHeartbeatDb()
		.prepare('SELECT last_run_at FROM task_state WHERE task_name = ?')
		.get(taskName) as { last_run_at: number } | undefined;
	return row?.last_run_at;
}

export function setTaskLastRun(taskName: string, at = Date.now()): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO task_state (task_name, last_run_at) VALUES (?, ?)
			 ON CONFLICT(task_name) DO UPDATE SET last_run_at = excluded.last_run_at`,
		)
		.run(taskName, at);
}

// ─── Commitments (Slice 5) ─────────────────────────────────────────────

export type CommitmentStatus = 'pending' | 'surfaced' | 'dismissed';

export type CommitmentSource = 'extractor' | 'user-explicit' | 'crm-followup';

export interface CommitmentRow {
	id: number;
	channel: string;
	target: string;
	suggestedText: string;
	dueAfterTs: number;
	status: CommitmentStatus;
	sourceMsgId: string | null;
	confidence: number;
	source: CommitmentSource;
	createdAt: number;
	surfacedAt: number | null;
	dismissedAt: number | null;
}

export interface InsertCommitmentInput {
	channel: string;
	target: string;
	suggestedText: string;
	dueAfterTs: number;
	sourceMsgId: string | null;
	confidence: number;
	/** ADR-025 — discriminates extractor-inferred vs user-explicit (set via
	 *  the `scheduleReminder` orchestrator tool). Defaults to 'extractor'
	 *  in the column DDL; pass explicitly to disambiguate at the call site. */
	source?: CommitmentSource;
}

export function insertCommitment(input: InsertCommitmentInput): number {
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO commitments (channel, target, suggested_text, due_after_ts, status, source_msg_id, confidence, source, created_at)
		 VALUES (@channel, @target, @suggestedText, @dueAfterTs, 'pending', @sourceMsgId, @confidence, @source, @createdAt)`,
	);
	const result = stmt.run({
		channel: input.channel,
		target: input.target,
		suggestedText: input.suggestedText,
		dueAfterTs: input.dueAfterTs,
		sourceMsgId: input.sourceMsgId,
		confidence: input.confidence,
		source: input.source ?? 'extractor',
		createdAt: Date.now(),
	});
	return Number(result.lastInsertRowid);
}

const COMMITMENT_SELECT = `
	id, channel, target,
	suggested_text  AS suggestedText,
	due_after_ts    AS dueAfterTs,
	status,
	source_msg_id   AS sourceMsgId,
	confidence,
	source,
	created_at      AS createdAt,
	surfaced_at     AS surfacedAt,
	dismissed_at    AS dismissedAt
`;

/** Pending commitments whose due time has arrived, scoped to one
 *  conversation so a commitment from chat A never leaks to chat B.
 *  Optionally filtered by `source` so the heartbeat can cap extractor
 *  vs user-explicit rows independently (ADR-025). */
export function getDueCommitments(
	channel: string,
	target: string,
	opts: { now?: number; source?: CommitmentSource } = {},
): CommitmentRow[] {
	const now = opts.now ?? Date.now();
	if (opts.source) {
		return getHeartbeatDb()
			.prepare(
				`SELECT ${COMMITMENT_SELECT} FROM commitments
				 WHERE channel = ? AND target = ? AND source = ? AND status = 'pending' AND due_after_ts <= ?
				 ORDER BY due_after_ts ASC, id ASC`,
			)
			.all(channel, target, opts.source, now) as CommitmentRow[];
	}
	return getHeartbeatDb()
		.prepare(
			`SELECT ${COMMITMENT_SELECT} FROM commitments
			 WHERE channel = ? AND target = ? AND status = 'pending' AND due_after_ts <= ?
			 ORDER BY due_after_ts ASC, id ASC`,
		)
		.all(channel, target, now) as CommitmentRow[];
}

/** Mark commitments as surfaced. Called after the heartbeat tick that
 *  included them — prevents the same commitment from being repeatedly
 *  re-included until the user/agent dismisses it. */
export function markCommitmentsSurfaced(ids: number[], at = Date.now()): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => '?').join(',');
	getHeartbeatDb()
		.prepare(
			`UPDATE commitments SET status = 'surfaced', surfaced_at = ?
			 WHERE id IN (${placeholders})`,
		)
		.run(at, ...ids);
}

export function dismissCommitment(id: number, at = Date.now()): boolean {
	const result = getHeartbeatDb()
		.prepare(
			`UPDATE commitments SET status = 'dismissed', dismissed_at = ?
			 WHERE id = ? AND status != 'dismissed'`,
		)
		.run(at, id);
	return result.changes > 0;
}

/** All non-dismissed commitments for a (channel, target) pair — used by
 *  `/commitments list` slash command. Bounded to keep replies short. */
export function listCommitmentsForTarget(channel: string, target: string, limit = 20): CommitmentRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT ${COMMITMENT_SELECT} FROM commitments
			 WHERE channel = ? AND target = ? AND status != 'dismissed'
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.all(channel, target, limit) as CommitmentRow[];
}

/** All recent commitments across every target/channel, ALL statuses
 *  (including dismissed) — the operator-global read feed for the
 *  /orchestration/heartbeat inbox (ADR-003 P1). Read-only; no scoping by
 *  sender because the inbox is the operator's own view. */
export function recentCommitments(limit = 50): CommitmentRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT ${COMMITMENT_SELECT} FROM commitments
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.all(limit) as CommitmentRow[];
}

// ─── Voice acks (Phase 4) ──────────────────────────────────────────────

export type VoiceAckMethod = 'auto' | 'reply-done' | 'reply-skip' | 'reply-later';

/** True if the heartbeat has already surfaced this inbox note AND it's
 *  not in an expired cooldown. Voice-queue scanner uses this to filter
 *  out already-surfaced items per ADR-003. A row with `cooldown_until`
 *  in the past is treated as no-longer-acked (the `reply-later` 4-hour
 *  window has elapsed and the note becomes eligible again). */
export function isVoiceAcked(notePath: string, now = Date.now()): boolean {
	const row = getHeartbeatDb()
		.prepare(
			`SELECT cooldown_until FROM voice_acks
			 WHERE note_path = ? LIMIT 1`,
		)
		.get(notePath) as { cooldown_until: number | null } | undefined;
	if (!row) return false;
	// No cooldown set → permanent ack. Cooldown in the future → still acked.
	// Cooldown in the past → expired, treat as not-acked.
	if (row.cooldown_until === null) return true;
	return row.cooldown_until > now;
}

/** Soft-auto-ack window: silent delivery is treated as "seen" for this
 *  long, then the note becomes eligible to re-surface. Reasoning: a
 *  permanent ack on send means anything you don't reply to disappears
 *  forever — bad UX for items that genuinely need a reminder. 24h gives
 *  the user a daily second-chance without re-pinging the same item every
 *  tick. Replies still upgrade the row: 'done'/'skip' cleared to NULL
 *  (permanent), 'later' bumped to a 4h cooldown. */
const SOFT_AUTO_ACK_MS = 24 * 60 * 60 * 1000;

/** Mark one or more notes as acked. For `method='auto'`, the row carries
 *  a 24h `cooldown_until` so silently-delivered items re-surface tomorrow.
 *  For explicit reply-* methods, callers go through `applyReplyAck` (which
 *  UPDATEs an existing auto row), so this path is effectively auto-only.
 *
 *  ON CONFLICT DO UPDATE preserves any reply-* state (the WHERE clause
 *  only touches rows still in `auto` state) — so if the user already said
 *  'done', a subsequent silent re-ack on the same path won't overwrite it.
 *  For auto-only re-surfaces (path was previously soft-acked, cooldown
 *  expired, re-presented this tick), it bumps `acked_at` + `cooldown_until`
 *  forward — keeps the reply-ack 4h window measured from the most recent
 *  surface. */
export function markVoiceAcked(notePaths: string[], method: VoiceAckMethod = 'auto', at = Date.now()): void {
	if (notePaths.length === 0) return;
	const cooldownUntil = method === 'auto' ? at + SOFT_AUTO_ACK_MS : null;
	const stmt = getHeartbeatDb().prepare(
		`INSERT INTO voice_acks (note_path, acked_at, ack_method, cooldown_until)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(note_path) DO UPDATE SET
		   acked_at = excluded.acked_at,
		   cooldown_until = excluded.cooldown_until
		 WHERE voice_acks.ack_method = 'auto'`,
	);
	const tx = getHeartbeatDb().transaction((paths: string[]) => {
		for (const p of paths) stmt.run(p, at, method, cooldownUntil);
	});
	tx(notePaths);
}

/** Bulk fetch — voice-queue scanner queries with ~50 inbox-note paths per
 *  tick. One round-trip beats N round-trips. Honours `cooldown_until`:
 *  a row whose cooldown has expired is omitted from the set, so the
 *  scanner re-surfaces the note. */
export function getAckedPaths(notePaths: string[], now = Date.now()): Set<string> {
	if (notePaths.length === 0) return new Set();
	const placeholders = notePaths.map(() => '?').join(',');
	const rows = getHeartbeatDb()
		.prepare(
			`SELECT note_path, cooldown_until FROM voice_acks
			 WHERE note_path IN (${placeholders})
			   AND (cooldown_until IS NULL OR cooldown_until > ?)`,
		)
		.all(...notePaths, now) as { note_path: string; cooldown_until: number | null }[];
	return new Set(rows.map((r) => r.note_path));
}

/** Phase 4.5 — apply a reply-ack to recently auto-acked rows. Called from
 *  the inbound dispatcher when the user replies "done", "skip", or "later"
 *  within the reply-ack window (default 4h — covers normal mobile-reply
 *  latency; the original 30-min "one tick" target was too tight for real
 *  WhatsApp use, where replies arrive whenever the user checks their phone).
 *
 *  Returns the number of rows updated. Zero means "no recent voice surface
 *  to ack" — the dispatcher falls through to normal intent routing so a
 *  bare word like "done" still flows to vault-chat in conversation context.
 *
 *  - reply-done / reply-skip: permanent ack. cooldown_until cleared to NULL.
 *  - reply-later: 4-hour cooldown. Note becomes re-eligible after that.
 *
 *  Only updates rows currently `ack_method = 'auto'` — avoids overwriting
 *  prior reply-acks. Edge: upgrading 'reply-later' → 'reply-done' is not
 *  supported in v1; deferred until a real use case emerges.
 */
export type ReplyAckMethod = 'reply-done' | 'reply-skip' | 'reply-later';

const REPLY_LATER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const REPLY_ACK_WINDOW_MS = 4 * 60 * 60 * 1000;

export function applyReplyAck(
	method: ReplyAckMethod,
	withinMs = REPLY_ACK_WINDOW_MS,
	now = Date.now(),
): number {
	const cutoff = now - withinMs;
	const cooldown = method === 'reply-later' ? now + REPLY_LATER_COOLDOWN_MS : null;
	const result = getHeartbeatDb()
		.prepare(
			`UPDATE voice_acks
			 SET ack_method = ?, cooldown_until = ?
			 WHERE ack_method = 'auto' AND acked_at >= ?`,
		)
		.run(method, cooldown, cutoff);
	return result.changes;
}

/** Phase 4.6 — read-only inverse of `applyReplyAck`. Returns the most
 *  recent auto-acked note paths within the reply-ack window. Used by the
 *  inbound dispatcher's `more` reply: list the items currently eligible
 *  for done/skip/later so the user can read them at the source. No
 *  side-effects — does not mutate ack state. */
export function getRecentVoiceSurface(
	withinMs = REPLY_ACK_WINDOW_MS,
	now = Date.now(),
): { notePath: string; ackedAt: number }[] {
	const cutoff = now - withinMs;
	return getHeartbeatDb()
		.prepare(
			`SELECT note_path AS notePath, acked_at AS ackedAt FROM voice_acks
			 WHERE ack_method = 'auto' AND acked_at >= ?
			 ORDER BY acked_at DESC`,
		)
		.all(cutoff) as { notePath: string; ackedAt: number }[];
}

/** Daily cleanup hook — drop ack rows older than `maxAgeMs`. The note
 *  itself ages out via inbox/CLAUDE.md's 30-day archive rule, but the
 *  ack row would otherwise grow forever. Default 30 days matches inbox
 *  archive cadence. */
export function pruneOldVoiceAcks(maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()): number {
	const cutoff = now - maxAgeMs;
	const result = getHeartbeatDb()
		.prepare('DELETE FROM voice_acks WHERE acked_at < ?')
		.run(cutoff);
	return result.changes;
}

// ─── Vault-Scout decisions (Phase 7) ───────────────────────────────────

export type ScoutDecision = 'queued' | 'skipped' | 'deferred';

export interface ScoutDecisionRow {
	candidate_id: string;
	decision: ScoutDecision;
	decided_at: number;
	note_path: string | null;
	model_used: string | null;
	reason: string | null;
}

/** Bulk-check which candidate ids have already been decided. Vault-Scout
 *  uses this before sending candidates to the synthesizer — already-
 *  decided candidates are filtered out so we don't re-evaluate (cost +
 *  duplicate output prevention). */
export function getDecidedCandidateIds(candidateIds: string[]): Set<string> {
	if (candidateIds.length === 0) return new Set();
	const placeholders = candidateIds.map(() => '?').join(',');
	const rows = getHeartbeatDb()
		.prepare(`SELECT candidate_id FROM vault_scout_decisions WHERE candidate_id IN (${placeholders})`)
		.all(...candidateIds) as { candidate_id: string }[];
	return new Set(rows.map((r) => r.candidate_id));
}

export interface InsertScoutDecision {
	candidateId: string;
	decision: ScoutDecision;
	notePath?: string | null;
	modelUsed?: string | null;
	reason?: string | null;
}

/** Idempotent INSERT — the UNIQUE constraint on candidate_id rejects
 *  duplicates, so concurrent runs with the same candidate are safe.
 *  Returns true on first insert, false if the candidate was already
 *  decided. */
export function recordScoutDecision(input: InsertScoutDecision, at = Date.now()): boolean {
	const result = getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_decisions (candidate_id, decision, decided_at, note_path, model_used, reason)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(candidate_id) DO NOTHING`,
		)
		.run(
			input.candidateId,
			input.decision,
			at,
			input.notePath ?? null,
			input.modelUsed ?? null,
			input.reason ?? null,
		);
	return result.changes > 0;
}

/** Audit-only — records a synthesizer output that failed validation
 *  (bad date, missing required field, parse error). Not surfaced to the
 *  user; useful for `[vault-scout] N rejects this run` log lines and
 *  for diagnosing prompt drift. */
export function recordScoutReject(
	candidateId: string | null,
	rawOutput: string | null,
	reason: string,
	at = Date.now(),
): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_rejects (candidate_id, raw_synth_output, reject_reason, recorded_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(candidateId, rawOutput, reason, at);
}

export function recentScoutDecisions(limit = 50): ScoutDecisionRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT candidate_id, decision, decided_at, note_path, model_used, reason
			 FROM vault_scout_decisions
			 ORDER BY decided_at DESC LIMIT ?`,
		)
		.all(limit) as ScoutDecisionRow[];
}

// ── ADR-009 vault-scout unblock-watch snapshots ──────────────────────

export interface BlockerSnapshotRow {
	dependent_path: string;
	blocker_path: string;
	blocker_status: string;
	recorded_at: number;
}

export function getBlockerSnapshot(
	dependentPath: string,
	blockerPath: string,
): BlockerSnapshotRow | null {
	const row = getHeartbeatDb()
		.prepare(
			`SELECT dependent_path, blocker_path, blocker_status, recorded_at
			 FROM vault_scout_blocker_snapshots
			 WHERE dependent_path = ? AND blocker_path = ?`,
		)
		.get(dependentPath, blockerPath) as BlockerSnapshotRow | undefined;
	return row ?? null;
}

export function upsertBlockerSnapshot(input: BlockerSnapshotRow): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_blocker_snapshots
				(dependent_path, blocker_path, blocker_status, recorded_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(dependent_path, blocker_path)
			 DO UPDATE SET blocker_status = excluded.blocker_status,
			               recorded_at    = excluded.recorded_at`,
		)
		.run(input.dependent_path, input.blocker_path, input.blocker_status, input.recorded_at);
}

export function allBlockerSnapshotsForDependent(
	dependentPath: string,
): BlockerSnapshotRow[] {
	return getHeartbeatDb()
		.prepare(
			`SELECT dependent_path, blocker_path, blocker_status, recorded_at
			 FROM vault_scout_blocker_snapshots
			 WHERE dependent_path = ?`,
		)
		.all(dependentPath) as BlockerSnapshotRow[];
}

// ── projects-graph ADR-006 vault-scout edge-stale snapshots ─────────

export interface EdgeSnapshotRow {
	producer_slug: string;
	consumer_slug: string;
	destination: string;
	/** null when the destination has never resolved to any file (broken
	 *  edge from day zero) — the watcher still records the check so we
	 *  don't endlessly re-probe. */
	last_flow_mtime: number | null;
	last_check_at: number;
}

export function getEdgeSnapshot(
	producerSlug: string,
	consumerSlug: string,
): EdgeSnapshotRow | null {
	const row = getHeartbeatDb()
		.prepare(
			`SELECT producer_slug, consumer_slug, destination, last_flow_mtime, last_check_at
			 FROM vault_scout_edge_snapshots
			 WHERE producer_slug = ? AND consumer_slug = ?`,
		)
		.get(producerSlug, consumerSlug) as EdgeSnapshotRow | undefined;
	return row ?? null;
}

export function upsertEdgeSnapshot(input: EdgeSnapshotRow): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO vault_scout_edge_snapshots
				(producer_slug, consumer_slug, destination, last_flow_mtime, last_check_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(producer_slug, consumer_slug)
			 DO UPDATE SET destination     = excluded.destination,
			               last_flow_mtime = excluded.last_flow_mtime,
			               last_check_at   = excluded.last_check_at`,
		)
		.run(
			input.producer_slug,
			input.consumer_slug,
			input.destination,
			input.last_flow_mtime,
			input.last_check_at,
		);
}

// ── projects-graph ADR-019 proactive prep snapshots ──────────────────────

export interface PrepSnapshotRow {
	task_path: string;
	/** null = first-observation recorded (quiet). Non-null = dispatch was
	 *  emitted; value is 'dispatched:<ms epoch>'. */
	prep_path: string | null;
	recorded_at: number;
}

export function getPrepSnapshot(taskPath: string): PrepSnapshotRow | null {
	const row = getHeartbeatDb()
		.prepare(
			`SELECT task_path, prep_path, recorded_at
			 FROM proactive_prep_snapshots
			 WHERE task_path = ?`,
		)
		.get(taskPath) as PrepSnapshotRow | undefined;
	return row ?? null;
}

export function upsertPrepSnapshot(input: PrepSnapshotRow): void {
	getHeartbeatDb()
		.prepare(
			`INSERT INTO proactive_prep_snapshots (task_path, prep_path, recorded_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(task_path)
			 DO UPDATE SET prep_path   = excluded.prep_path,
			               recorded_at = excluded.recorded_at`,
		)
		.run(input.task_path, input.prep_path, input.recorded_at);
}
