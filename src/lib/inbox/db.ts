/**
 * Inbox SQLite database — email cache with FTS5 search.
 *
 * Schema:
 *   accounts       — email account configs (credentials encrypted)
 *   oauth_clients  — reusable OAuth client identities (Connections)
 *   messages       — cached email headers + preview
 *   sync_state     — per-account/folder sync watermarks
 *   messages_fts   — FTS5 virtual table for search
 *
 * Uses WAL mode for concurrent SvelteKit reads + sync worker writes.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
	InboxAccount, InboxMessage, SyncState, InboxProvider, AccountStatus,
	OauthClient,
	FilterCategory, FilterRule, FilterRuleMatchType, FilterCacheEntry,
} from './types.js';
import { CATEGORY_TO_STATUS } from './types.js';
import { encrypt, decrypt } from './crypto.js';
import { soulHubDataDir } from '../paths.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	return resolve(soulHubDataDir(), 'inbox.db');
}

export function getInboxDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());

	// Performance pragmas for concurrent access
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('temp_store = MEMORY');
	db.pragma('busy_timeout = 5000');
	db.pragma('wal_autocheckpoint = 1000');

	// Run migrations
	migrate(db);

	return db;
}

export function closeInboxDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS accounts (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				provider TEXT NOT NULL,
				email TEXT NOT NULL,
				host TEXT,
				port INTEGER,
				encrypted_credential TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'disconnected',
				last_sync INTEGER,
				last_error TEXT,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				uid INTEGER NOT NULL,
				uid_validity INTEGER NOT NULL,
				folder TEXT NOT NULL,
				message_id TEXT,
				thread_id TEXT,
				in_reply_to TEXT,
				subject TEXT NOT NULL DEFAULT '',
				from_address TEXT NOT NULL DEFAULT '',
				from_name TEXT,
				to_address TEXT NOT NULL DEFAULT '',
				date_sent INTEGER,
				date_received INTEGER NOT NULL,
				flags TEXT NOT NULL DEFAULT '[]',
				has_attachments INTEGER NOT NULL DEFAULT 0,
				body_preview TEXT NOT NULL DEFAULT '',
				raw_size INTEGER NOT NULL DEFAULT 0,
				content_hash TEXT,
				synced_at INTEGER NOT NULL,
				UNIQUE(account_id, uid, folder, uid_validity)
			);

			CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
			CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_received DESC);
			CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id) WHERE message_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;

			CREATE TABLE IF NOT EXISTS sync_state (
				account_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				last_uid INTEGER NOT NULL DEFAULT 0,
				uid_validity INTEGER NOT NULL DEFAULT 0,
				last_sync INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY(account_id, folder)
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				subject, body_preview, from_address,
				content='messages',
				content_rowid='id'
			);

			-- Triggers to keep FTS in sync
			CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts(rowid, subject, body_preview, from_address)
				VALUES (new.id, new.subject, new.body_preview, new.from_address);
			END;

			CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, subject, body_preview, from_address)
				VALUES ('delete', old.id, old.subject, old.body_preview, old.from_address);
			END;

			CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, subject, body_preview, from_address)
				VALUES ('delete', old.id, old.subject, old.body_preview, old.from_address);
				INSERT INTO messages_fts(rowid, subject, body_preview, from_address)
				VALUES (new.id, new.subject, new.body_preview, new.from_address);
			END;
		`);
		db.pragma(`user_version = 1`);
	}

	if (version < 2) {
		db.exec(`
			ALTER TABLE accounts ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30;

			ALTER TABLE messages ADD COLUMN process_status TEXT NOT NULL DEFAULT 'new';
			ALTER TABLE messages ADD COLUMN attachments_meta TEXT NOT NULL DEFAULT '[]';
			ALTER TABLE messages ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE messages ADD COLUMN is_flagged INTEGER NOT NULL DEFAULT 0;

			CREATE INDEX IF NOT EXISTS idx_messages_status_date ON messages(process_status, date_received DESC);
			CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(is_flagged) WHERE is_flagged = 1;
		`);
		db.pragma(`user_version = 2`);
	}

	if (version < 3) {
		// UNIQUE (provider, email) belt-and-suspenders. The application-level
		// dedup in OAuth callbacks + POST handler is the primary UX path
		// (returns helpful "Use Reauthorize / Reset Password" messages).
		db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_email
			ON accounts(provider, email);
		`);
		db.pragma(`user_version = 3`);
	}

	if (version < 4) {
		// Migration #4 (per-account inline OAuth override) — see superseded
		// ADR 2026-05-11-per-account-oauth-clients. We still run it here so
		// any partial-deploy DBs that landed between migrations have the
		// columns to drop in migration #5. Migration #5 is the live model.
		db.exec(`
			ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT;
			ALTER TABLE accounts ADD COLUMN oauth_client_secret_encrypted TEXT;

			CREATE TABLE IF NOT EXISTS pending_oauth_clients (
				ephemeral_id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				client_id TEXT NOT NULL,
				client_secret_encrypted TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_pending_oauth_clients_created
				ON pending_oauth_clients(created_at);
		`);
		db.pragma(`user_version = 4`);
	}

	if (version < 5) {
		// Promote OAuth clients to first-class objects (Connections).
		// See ADR 2026-05-11-oauth-clients-as-first-class-connections.
		//
		// 1. CREATE oauth_clients
		// 2. ADD accounts.oauth_client_ref (FK)
		// 3. Seed Default Gmail client from process.env if present
		// 4. Backfill any inline overrides into oauth_clients rows + relink
		// 5. Default-link existing Gmail accounts at the seeded Default
		// 6. DROP pending_oauth_clients
		// 7. DROP accounts.oauth_client_id + oauth_client_secret_encrypted
		const tx = db.transaction(() => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS oauth_clients (
					id TEXT PRIMARY KEY,
					provider TEXT NOT NULL,
					label TEXT NOT NULL,
					client_id TEXT NOT NULL,
					client_secret_encrypted TEXT NOT NULL,
					is_default INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					last_used_at INTEGER
				);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_provider_client_id
					ON oauth_clients(provider, client_id);
				CREATE INDEX IF NOT EXISTS idx_oauth_clients_provider_default
					ON oauth_clients(provider, is_default);

				ALTER TABLE accounts ADD COLUMN oauth_client_ref TEXT REFERENCES oauth_clients(id);
			`);

			const now = Date.now();

			// Seed Default Gmail client from platform env, if present.
			const envClientId = process.env.GOOGLE_CLIENT_ID?.trim();
			const envClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
			let defaultGmailId: string | null = null;
			if (envClientId && envClientSecret) {
				defaultGmailId = randomUUID();
				db.prepare(`
					INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
					VALUES (?, 'gmail', 'Default', ?, ?, 1, ?)
				`).run(defaultGmailId, envClientId, encrypt(envClientSecret), now);
				console.log('[inbox-migration] Seeded Default Gmail OAuth client from platform env');
			}

			// Backfill inline overrides → oauth_clients rows.
			const inlineOverrideAccounts = db.prepare(`
				SELECT id, label, provider, oauth_client_id, oauth_client_secret_encrypted
				FROM accounts
				WHERE oauth_client_id IS NOT NULL AND oauth_client_secret_encrypted IS NOT NULL
			`).all() as Array<{
				id: string;
				label: string;
				provider: string;
				oauth_client_id: string;
				oauth_client_secret_encrypted: string;
			}>;

			for (const acc of inlineOverrideAccounts) {
				// Check if a row already exists for this (provider, client_id).
				const existing = db.prepare(
					`SELECT id FROM oauth_clients WHERE provider = ? AND client_id = ?`,
				).get(acc.provider, acc.oauth_client_id) as { id: string } | undefined;
				let ref: string;
				if (existing) {
					ref = existing.id;
				} else {
					ref = randomUUID();
					db.prepare(`
						INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
						VALUES (?, ?, ?, ?, ?, 0, ?)
					`).run(ref, acc.provider, `${acc.label} client`, acc.oauth_client_id, acc.oauth_client_secret_encrypted, now);
				}
				db.prepare(`UPDATE accounts SET oauth_client_ref = ? WHERE id = ?`).run(ref, acc.id);
				console.log(`[inbox-migration] Migrated inline OAuth override for account ${acc.id} → oauth_clients.${ref}`);
			}

			// Default-link existing Gmail accounts that have no override and
			// haven't been linked yet.
			if (defaultGmailId) {
				db.prepare(`
					UPDATE accounts
					SET oauth_client_ref = ?
					WHERE provider = 'gmail'
					  AND oauth_client_ref IS NULL
				`).run(defaultGmailId);
			}

			// Drop the legacy ephemeral table.
			db.exec(`DROP TABLE IF EXISTS pending_oauth_clients;`);

			// Drop the legacy inline columns. SQLite 3.35+ supports DROP COLUMN
			// directly; better-sqlite3 ships with SQLite ≥ 3.45.
			db.exec(`
				ALTER TABLE accounts DROP COLUMN oauth_client_id;
				ALTER TABLE accounts DROP COLUMN oauth_client_secret_encrypted;
			`);
		});
		tx();
		db.pragma(`user_version = 5`);
	}

	if (version < 6) {
		// Layer 2 inbox processing filter — categorize agent-relevant signal
		// from noise. See ADR 2026-05-11-inbox-processing-filter-layer.
		//
		// 1. Add classifier output columns to messages
		// 2. CREATE filter_rules (data-driven rule engine)
		// 3. CREATE filter_cache (per-(from, subject) memoization)
		// 4. Seed 13 system rules (header-based + sender-pattern + domain)
		const tx = db.transaction(() => {
			db.exec(`
				ALTER TABLE messages ADD COLUMN category TEXT;
				ALTER TABLE messages ADD COLUMN filter_reason TEXT;
				ALTER TABLE messages ADD COLUMN filtered_at INTEGER;
				ALTER TABLE messages ADD COLUMN header_signals TEXT;

				CREATE INDEX IF NOT EXISTS idx_messages_category_date
					ON messages(category, date_received DESC)
					WHERE process_status IN ('queued', 'processed');

				CREATE INDEX IF NOT EXISTS idx_messages_filtered_at
					ON messages(filtered_at)
					WHERE filtered_at IS NOT NULL;

				CREATE TABLE IF NOT EXISTS filter_rules (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					account_id TEXT,
					precedence INTEGER NOT NULL,
					match_type TEXT NOT NULL CHECK (match_type IN (
						'header_present',
						'header_value',
						'sender_domain',
						'sender_pattern',
						'subject_pattern'
					)),
					match_value TEXT NOT NULL,
					action_category TEXT NOT NULL CHECK (action_category IN (
						'personal','transactional','notification','promotional','bulk','unclassified'
					)),
					reason TEXT,
					created_at INTEGER NOT NULL,
					created_by TEXT NOT NULL DEFAULT 'user',
					enabled INTEGER NOT NULL DEFAULT 1
				);

				CREATE INDEX IF NOT EXISTS idx_filter_rules_precedence
					ON filter_rules(precedence) WHERE enabled = 1;

				CREATE TABLE IF NOT EXISTS filter_cache (
					signature TEXT PRIMARY KEY,
					category TEXT NOT NULL,
					reason TEXT,
					hit_count INTEGER NOT NULL DEFAULT 1,
					first_hit_at INTEGER NOT NULL,
					last_hit_at INTEGER NOT NULL,
					user_corrected INTEGER NOT NULL DEFAULT 0
				);

				CREATE INDEX IF NOT EXISTS idx_filter_cache_lastHit ON filter_cache(last_hit_at);
			`);

			// Seed system rules only if none exist — keeps rollback path
			// (DELETE FROM filter_rules WHERE created_by='system') idempotent.
			const sysCount = (db.prepare(
				`SELECT COUNT(*) AS c FROM filter_rules WHERE created_by = 'system'`,
			).get() as { c: number }).c;

			if (sysCount === 0) {
				const now = Date.now();
				const seed = db.prepare(`
					INSERT INTO filter_rules
						(precedence, match_type, match_value, action_category, reason, created_by, created_at, enabled)
					VALUES (?, ?, ?, ?, ?, 'system', ?, 1)
				`);

				const rules: Array<[number, string, string, string, string]> = [
					[100, 'header_present', 'List-Unsubscribe',  'promotional',  'List-Unsubscribe header indicates bulk mail (RFC 2369/8058)'],
					[110, 'header_value',   'Precedence:bulk',   'bulk',         'Precedence: bulk legacy indicator'],
					[120, 'header_value',   'Precedence:list',   'bulk',         'Precedence: list legacy indicator'],
					[130, 'header_present', 'List-ID',           'bulk',         'List-ID header indicates mailing list'],
					[200, 'sender_pattern', 'noreply@*',         'notification', 'noreply senders are typically automated service notifications'],
					[210, 'sender_pattern', 'do-not-reply@*',    'notification', 'do-not-reply senders are typically automated service notifications'],
					[220, 'sender_pattern', 'notifications@*',   'notification', 'notifications@ senders are typically automated service notifications'],
					[300, 'sender_domain',  'mailchimp.com',     'promotional',  'Mailchimp is a marketing email platform'],
					[300, 'sender_domain',  'mailgun.org',       'promotional',  'Mailgun is a transactional/marketing platform'],
					[300, 'sender_domain',  'sendgrid.net',      'promotional',  'SendGrid is a marketing email platform'],
					[300, 'sender_domain',  'klaviyo.com',       'promotional',  'Klaviyo is a marketing email platform'],
					[300, 'sender_domain',  'beehiiv.com',       'promotional',  'Beehiiv is a newsletter platform'],
					[300, 'sender_domain',  'substack.com',      'promotional',  'Substack is a newsletter platform'],
				];

				for (const [prec, mtype, mval, cat, reason] of rules) {
					seed.run(prec, mtype, mval, cat, reason, now);
				}
				console.log(`[inbox-migration] Seeded ${rules.length} Layer 2 system filter rules`);
			}
		});
		tx();
		db.pragma(`user_version = 6`);
	}

	if (version < 7) {
		// Layer 3 prep — track WHEN an agent processed a message, distinct
		// from when the row was synced or classified. Used by pruneOldMessages
		// to age the 365-day processed-retention from the action time rather
		// than from date_received (which could be years old at action time).
		db.exec(`
			ALTER TABLE messages ADD COLUMN processed_at INTEGER;
		`);
		db.pragma(`user_version = 7`);
	}

	if (version < 8) {
		// Layer 3 Stage 2 — structured extraction for transactional mail.
		// Per ADR 2026-05-11-inbox-agent-workflows-layer-3 §D3:
		//   • extracted_data: JSON-encoded TransactionalExtract (see extractor.ts)
		//   • extracted_at: epoch ms when extraction ran (success or cached failure)
		// Lazy by default — populated only when `inbox-extract-data` runs.
		// Eager mode (INBOX_TRANSACTIONAL_EAGER_EXTRACT=1) lands in a follow-up.
		//
		// Plus Guardrail 2 (§D7): agent_actions audit log. Every Layer 3 tool
		// invocation appends a row so we have a permanent trail of "agent did X".
		// message_id is nullable post-CASCADE so the audit row outlives the
		// pruned message.
		db.exec(`
			ALTER TABLE messages ADD COLUMN extracted_data TEXT;
			ALTER TABLE messages ADD COLUMN extracted_at INTEGER;

			CREATE TABLE IF NOT EXISTS agent_actions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp INTEGER NOT NULL,
				tool TEXT NOT NULL,
				message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
				actor TEXT NOT NULL,
				args TEXT,
				result TEXT,
				conversation_key TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_agent_actions_message ON agent_actions(message_id);
			CREATE INDEX IF NOT EXISTS idx_agent_actions_timestamp ON agent_actions(timestamp DESC);
		`);
		db.pragma(`user_version = 8`);
	}

	if (version < 9) {
		// Migration 9 — seed Default Outlook OAuth client from platform env,
		// mirroring migration #5 for Gmail. Inbox-plan Open #2 follow-up:
		// Outlook now uses the Connections system instead of reading env
		// at every auth-flow callsite. Existing Outlook accounts without an
		// oauth_client_ref get linked to the newly-seeded Default row.
		db.transaction(() => {
			const now = Date.now();
			const envClientId = process.env.AZURE_CLIENT_ID?.trim();
			const envClientSecret = process.env.AZURE_CLIENT_SECRET?.trim();

			// Skip if no env present OR a Default Outlook row already exists
			// (idempotent — re-running the migration must not duplicate).
			const existingDefault = db.prepare(
				`SELECT id FROM oauth_clients WHERE provider = 'outlook' AND is_default = 1 LIMIT 1`,
			).get() as { id: string } | undefined;

			let defaultOutlookId: string | null = existingDefault?.id ?? null;

			if (!defaultOutlookId && envClientId && envClientSecret) {
				defaultOutlookId = randomUUID();
				db.prepare(`
					INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
					VALUES (?, 'outlook', 'Default', ?, ?, 1, ?)
				`).run(defaultOutlookId, envClientId, encrypt(envClientSecret), now);
				console.log('[inbox-migration] Seeded Default Outlook OAuth client from platform env');
			}

			// Default-link existing Outlook accounts that haven't been
			// linked yet — only when a Default row is available.
			if (defaultOutlookId) {
				const linked = db.prepare(`
					UPDATE accounts
					SET oauth_client_ref = ?
					WHERE provider = 'outlook'
					  AND oauth_client_ref IS NULL
				`).run(defaultOutlookId);
				if (linked.changes > 0) {
					console.log(
						`[inbox-migration] Linked ${linked.changes} existing Outlook account(s) to Default Connection`,
					);
				}
			}
		})();
		db.pragma(`user_version = 9`);
	}

	if (version < 10) {
		// Migration 10 — replace the `folder='delta:<url>'` hack with a proper
		// `delta_link` column on sync_state. The old approach stored Microsoft
		// Graph's @odata.deltaLink in the folder name (PK component), which
		// leaked a new row on every successful poll because the watermark URL
		// changes each sync. Reads then returned an arbitrary row out of the
		// accumulating set. The column is the right home for it.
		db.transaction(() => {
			db.exec(`ALTER TABLE sync_state ADD COLUMN delta_link TEXT;`);

			// Copy the most-recent delta URL per account onto the INBOX row.
			// For Outlook accounts the INBOX row likely does not exist yet
			// (Outlook never wrote to it via upsertSyncState); INSERT creates
			// it. ON CONFLICT only touches delta_link, preserving any real
			// last_uid/uid_validity from IMAP-style sync.
			db.exec(`
				INSERT INTO sync_state (account_id, folder, last_uid, uid_validity, last_sync, delta_link)
				SELECT
					s.account_id, 'INBOX', 0, 0, s.last_sync, substr(s.folder, 7)
				FROM sync_state s
				JOIN (
					SELECT account_id, MAX(last_sync) AS max_sync
					FROM sync_state
					WHERE folder LIKE 'delta:%'
					GROUP BY account_id
				) latest ON latest.account_id = s.account_id AND latest.max_sync = s.last_sync
				WHERE s.folder LIKE 'delta:%'
				ON CONFLICT(account_id, folder) DO UPDATE SET
					delta_link = excluded.delta_link;
			`);

			const orphaned = db.prepare(`SELECT COUNT(*) AS c FROM sync_state WHERE folder LIKE 'delta:%'`)
				.get() as { c: number };
			db.exec(`DELETE FROM sync_state WHERE folder LIKE 'delta:%';`);
			if (orphaned.c > 0) {
				console.log(`[inbox-migration] Migrated delta-link cache: cleaned ${orphaned.c} legacy delta:% row(s)`);
			}
		})();
		db.pragma(`user_version = 10`);
	}
}

// ── Account CRUD ──

export function addAccount(
	account: Pick<InboxAccount, 'id' | 'label' | 'provider' | 'email' | 'host' | 'port'>,
	credential: string,
	oauthClientRef?: string | null,
): InboxAccount {
	const db = getInboxDb();
	const now = Date.now();
	const encrypted = encrypt(credential);

	// New accounts default to 90-day retention. The schema's column default
	// is still 30 from migration #2 (kept untouched to avoid disturbing
	// existing rows). Specifying it explicitly here makes the new-account
	// behavior independent of the schema default.
	db.prepare(`
		INSERT INTO accounts (id, label, provider, email, host, port, encrypted_credential, status, retention_days, oauth_client_ref, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'disconnected', 90, ?, ?)
	`).run(
		account.id,
		account.label,
		account.provider,
		account.email,
		account.host ?? null,
		account.port ?? null,
		encrypted,
		oauthClientRef ?? null,
		now,
	);

	return {
		...account,
		host: account.host,
		port: account.port,
		status: 'disconnected',
		lastSync: null,
		lastError: null,
		createdAt: now,
		retentionDays: 90,
		oauthClientRef: oauthClientRef ?? null,
	};
}

export function getAccount(id: string): InboxAccount | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToAccount(row);
}

export function listAccounts(): InboxAccount[] {
	const db = getInboxDb();
	const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as Record<string, unknown>[];
	return rows.map(rowToAccount);
}

export function removeAccount(id: string): boolean {
	const db = getInboxDb();
	const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
	// Cascade deletes messages + sync_state via FK
	return result.changes > 0;
}

export function updateAccountStatus(id: string, status: AccountStatus, error?: string | null): void {
	const db = getInboxDb();
	db.prepare('UPDATE accounts SET status = ?, last_error = ? WHERE id = ?')
		.run(status, error ?? null, id);
}

export function updateAccountLastSync(id: string): void {
	const db = getInboxDb();
	const now = Date.now();
	db.prepare('UPDATE accounts SET last_sync = ?, status = ? WHERE id = ?')
		.run(now, 'connected', id);
}

export function getAccountCredential(id: string): string | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT encrypted_credential FROM accounts WHERE id = ?').get(id) as { encrypted_credential: string } | undefined;
	if (!row) return null;
	return decrypt(row.encrypted_credential);
}

function rowToAccount(row: Record<string, unknown>): InboxAccount {
	return {
		id: row.id as string,
		label: row.label as string,
		provider: row.provider as InboxProvider,
		email: row.email as string,
		host: row.host as string | undefined,
		port: row.port as number | undefined,
		status: row.status as AccountStatus,
		lastSync: row.last_sync as number | null,
		lastError: row.last_error as string | null,
		createdAt: row.created_at as number,
		retentionDays: (row.retention_days as number) ?? 90,
		oauthClientRef: (row.oauth_client_ref as string | null) ?? null,
	};
}

// ── OAuth Client (Connections) CRUD ──

export function listOauthClients(provider?: InboxProvider): OauthClient[] {
	const db = getInboxDb();
	const rows = provider
		? db.prepare(`SELECT * FROM oauth_clients WHERE provider = ? ORDER BY is_default DESC, created_at`).all(provider)
		: db.prepare(`SELECT * FROM oauth_clients ORDER BY provider, is_default DESC, created_at`).all();
	return (rows as Record<string, unknown>[]).map(rowToOauthClient);
}

export function getOauthClient(id: string): OauthClient | null {
	const db = getInboxDb();
	const row = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToOauthClient(row);
}

export function getDefaultOauthClient(provider: InboxProvider): OauthClient | null {
	const db = getInboxDb();
	const row = db.prepare(
		`SELECT * FROM oauth_clients WHERE provider = ? AND is_default = 1 LIMIT 1`,
	).get(provider) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToOauthClient(row);
}

export function countAccountsUsingOauthClient(clientRef: string): number {
	const db = getInboxDb();
	const row = db.prepare(
		`SELECT COUNT(*) AS c FROM accounts WHERE oauth_client_ref = ?`,
	).get(clientRef) as { c: number };
	return row.c;
}

/**
 * Create a new OAuth client. If `isDefault=true`, any existing default for
 * the same provider is automatically un-defaulted.
 */
export function createOauthClient(input: {
	provider: InboxProvider;
	label: string;
	clientId: string;
	clientSecret: string;
	isDefault?: boolean;
}): OauthClient {
	const db = getInboxDb();
	const now = Date.now();
	const id = randomUUID();
	const isDefault = input.isDefault ? 1 : 0;

	const tx = db.transaction(() => {
		if (isDefault) {
			db.prepare(
				`UPDATE oauth_clients SET is_default = 0 WHERE provider = ? AND is_default = 1`,
			).run(input.provider);
		}
		db.prepare(`
			INSERT INTO oauth_clients (id, provider, label, client_id, client_secret_encrypted, is_default, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(id, input.provider, input.label, input.clientId, encrypt(input.clientSecret), isDefault, now);
	});
	tx();

	return {
		id,
		provider: input.provider,
		label: input.label,
		clientId: input.clientId,
		clientSecretEncrypted: encrypt(input.clientSecret),
		isDefault: !!input.isDefault,
		createdAt: now,
		lastUsedAt: null,
	};
}

/**
 * Update an OAuth client. `clientId` is immutable — to change the client_id,
 * create a new row. Pass `clientSecret` to rotate the secret. Pass
 * `isDefault=true` to promote; the previous default in the same provider is
 * automatically un-defaulted.
 */
export function updateOauthClient(
	id: string,
	patch: { label?: string; clientSecret?: string; isDefault?: boolean },
): boolean {
	const db = getInboxDb();
	const sets: string[] = [];
	const params: unknown[] = [];

	if (patch.label !== undefined) {
		sets.push('label = ?');
		params.push(patch.label);
	}
	if (patch.clientSecret !== undefined) {
		sets.push('client_secret_encrypted = ?');
		params.push(encrypt(patch.clientSecret));
	}

	const tx = db.transaction(() => {
		if (patch.isDefault === true) {
			const current = db.prepare(`SELECT provider FROM oauth_clients WHERE id = ?`).get(id) as
				| { provider: string }
				| undefined;
			if (current) {
				db.prepare(
					`UPDATE oauth_clients SET is_default = 0 WHERE provider = ? AND is_default = 1`,
				).run(current.provider);
				sets.push('is_default = 1');
			}
		} else if (patch.isDefault === false) {
			sets.push('is_default = 0');
		}

		if (sets.length === 0) return 0;
		params.push(id);
		const result = db.prepare(`UPDATE oauth_clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
		return result.changes;
	});
	return tx() > 0;
}

/**
 * Delete an OAuth client. Refuses if any account references it (returns
 * `{ deleted: false, reason: 'in_use', accountCount }`).
 */
export function deleteOauthClient(id: string): { deleted: boolean; reason?: 'in_use' | 'not_found'; accountCount?: number } {
	const db = getInboxDb();
	const inUse = countAccountsUsingOauthClient(id);
	if (inUse > 0) return { deleted: false, reason: 'in_use', accountCount: inUse };
	const result = db.prepare(`DELETE FROM oauth_clients WHERE id = ?`).run(id);
	if (result.changes === 0) return { deleted: false, reason: 'not_found' };
	return { deleted: true };
}

export function touchOauthClientUsage(id: string): void {
	const db = getInboxDb();
	db.prepare(`UPDATE oauth_clients SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
}

function rowToOauthClient(row: Record<string, unknown>): OauthClient {
	return {
		id: row.id as string,
		provider: row.provider as InboxProvider,
		label: row.label as string,
		clientId: row.client_id as string,
		clientSecretEncrypted: row.client_secret_encrypted as string,
		isDefault: (row.is_default as number) === 1,
		createdAt: row.created_at as number,
		lastUsedAt: (row.last_used_at as number | null) ?? null,
	};
}

// ── Message CRUD ──

export function upsertMessage(msg: Omit<InboxMessage, 'id'>): number {
	const db = getInboxDb();
	const result = db.prepare(`
		INSERT INTO messages (account_id, uid, uid_validity, folder, message_id, thread_id, in_reply_to,
			subject, from_address, from_name, to_address, date_sent, date_received, flags,
			has_attachments, body_preview, raw_size, content_hash, synced_at,
			process_status, attachments_meta, attachment_count, is_flagged)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, uid, folder, uid_validity) DO UPDATE SET
			flags = excluded.flags,
			is_flagged = excluded.is_flagged,
			synced_at = excluded.synced_at
	`).run(
		msg.accountId, msg.uid, msg.uidValidity, msg.folder,
		msg.messageId, msg.threadId, msg.inReplyTo,
		msg.subject, msg.fromAddress, msg.fromName, msg.toAddress,
		msg.dateSent, msg.dateReceived, JSON.stringify(msg.flags),
		msg.hasAttachments ? 1 : 0, msg.bodyPreview, msg.rawSize,
		null, // content_hash computed later if needed
		msg.syncedAt,
		msg.processStatus || 'new',
		JSON.stringify(msg.attachmentsMeta || []),
		msg.attachmentCount || 0,
		msg.isFlagged ? 1 : 0,
	);
	return Number(result.lastInsertRowid);
}

export function upsertMessages(messages: Omit<InboxMessage, 'id'>[]): void {
	const db = getInboxDb();
	const insert = db.prepare(`
		INSERT INTO messages (account_id, uid, uid_validity, folder, message_id, thread_id, in_reply_to,
			subject, from_address, from_name, to_address, date_sent, date_received, flags,
			has_attachments, body_preview, raw_size, content_hash, synced_at,
			process_status, attachments_meta, attachment_count, is_flagged)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, uid, folder, uid_validity) DO UPDATE SET
			flags = excluded.flags,
			is_flagged = excluded.is_flagged,
			synced_at = excluded.synced_at
	`);

	const tx = db.transaction((msgs: Omit<InboxMessage, 'id'>[]) => {
		for (const msg of msgs) {
			insert.run(
				msg.accountId, msg.uid, msg.uidValidity, msg.folder,
				msg.messageId, msg.threadId, msg.inReplyTo,
				msg.subject, msg.fromAddress, msg.fromName, msg.toAddress,
				msg.dateSent, msg.dateReceived, JSON.stringify(msg.flags),
				msg.hasAttachments ? 1 : 0, msg.bodyPreview, msg.rawSize,
				null, msg.syncedAt,
				msg.processStatus || 'new',
				JSON.stringify(msg.attachmentsMeta || []),
				msg.attachmentCount || 0,
				msg.isFlagged ? 1 : 0,
			);
		}
	});

	tx(messages);
}

export interface MessageListOptions {
	accountId?: string;
	folder?: string;
	limit?: number;
	offset?: number;
	search?: string;
	status?: string;
	/** Layer 2 filter — match exact category, e.g. 'transactional'. */
	category?: string;
	/** Layer 2 filter — only messages with date_received >= since (epoch ms). */
	since?: number;
}

export function listMessages(opts: MessageListOptions = {}): { messages: InboxMessage[]; total: number } {
	const db = getInboxDb();
	const limit = opts.limit ?? 50;
	const offset = opts.offset ?? 0;

	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.accountId) {
		conditions.push('m.account_id = ?');
		params.push(opts.accountId);
	}
	if (opts.folder) {
		conditions.push('m.folder = ?');
		params.push(opts.folder);
	}
	if (opts.status) {
		conditions.push('m.process_status = ?');
		params.push(opts.status);
	}
	if (opts.category) {
		conditions.push('m.category = ?');
		params.push(opts.category);
	}
	if (opts.since !== undefined) {
		conditions.push('m.date_received >= ?');
		params.push(opts.since);
	}

	let query: string;
	let countQuery: string;

	if (opts.search) {
		// FTS5 search
		query = `
			SELECT m.* FROM messages m
			INNER JOIN messages_fts fts ON fts.rowid = m.id
			WHERE messages_fts MATCH ?
			${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
			ORDER BY COALESCE(m.date_sent, m.date_received) DESC
			LIMIT ? OFFSET ?
		`;
		countQuery = `
			SELECT COUNT(*) as total FROM messages m
			INNER JOIN messages_fts fts ON fts.rowid = m.id
			WHERE messages_fts MATCH ?
			${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
		`;
		params.unshift(opts.search);
	} else {
		const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
		query = `
			SELECT m.* FROM messages m ${where}
			ORDER BY COALESCE(m.date_sent, m.date_received) DESC
			LIMIT ? OFFSET ?
		`;
		countQuery = `SELECT COUNT(*) as total FROM messages m ${where}`;
	}

	const rows = db.prepare(query).all(...params, limit, offset) as Record<string, unknown>[];
	const { total } = db.prepare(countQuery).get(...params) as { total: number };

	return {
		messages: rows.map(rowToMessage),
		total,
	};
}

export function getMessage(id: number): InboxMessage | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToMessage(row);
}

export function getMessageCount(accountId?: string): number {
	const db = getInboxDb();
	if (accountId) {
		const row = db.prepare('SELECT COUNT(*) as c FROM messages WHERE account_id = ?').get(accountId) as { c: number };
		return row.c;
	}
	const row = db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number };
	return row.c;
}

export function rowToMessage(row: Record<string, unknown>): InboxMessage {
	return {
		id: row.id as number,
		accountId: row.account_id as string,
		uid: row.uid as number,
		uidValidity: row.uid_validity as number,
		folder: row.folder as string,
		messageId: row.message_id as string | null,
		threadId: row.thread_id as string | null,
		inReplyTo: row.in_reply_to as string | null,
		subject: row.subject as string,
		fromAddress: row.from_address as string,
		fromName: row.from_name as string | null,
		toAddress: row.to_address as string,
		dateSent: row.date_sent as number | null,
		dateReceived: row.date_received as number,
		flags: JSON.parse((row.flags as string) || '[]'),
		hasAttachments: (row.has_attachments as number) === 1,
		bodyPreview: row.body_preview as string,
		rawSize: row.raw_size as number,
		syncedAt: row.synced_at as number,
		processStatus: (row.process_status as string) || 'new',
		attachmentsMeta: JSON.parse((row.attachments_meta as string) || '[]'),
		attachmentCount: (row.attachment_count as number) || 0,
		isFlagged: (row.is_flagged as number) === 1,
		category: (row.category as FilterCategory | null) ?? null,
		filterReason: (row.filter_reason as string | null) ?? null,
		filteredAt: (row.filtered_at as number | null) ?? null,
		headerSignals: (row.header_signals as string | null) ?? null,
		processedAt: (row.processed_at as number | null) ?? null,
		extractedData: (row.extracted_data as string | null) ?? null,
		extractedAt: (row.extracted_at as number | null) ?? null,
	};
}

// ── Layer 3 Stage 2 — extraction + audit (ADR 2026-05-11-inbox-agent-workflows-layer-3 §D3, §D7) ──

/** Return parsed extraction JSON or null if not yet extracted. Caller
 *  decides what to do on cache miss (run extractor + setExtractedData). */
export function getExtractedData<T = unknown>(messageId: number): T | null {
	const db = getInboxDb();
	const row = db
		.prepare('SELECT extracted_data FROM messages WHERE id = ?')
		.get(messageId) as { extracted_data: string | null } | undefined;
	if (!row || !row.extracted_data) return null;
	try {
		return JSON.parse(row.extracted_data) as T;
	} catch {
		return null;
	}
}

/** Cache an extraction result on the message row. Caller is responsible
 *  for shape validation — we store whatever JSON-serialisable value was
 *  passed (success OR failure stub like `{kind:'unknown',note}`). */
export function setExtractedData(messageId: number, extract: unknown): void {
	const db = getInboxDb();
	const json = JSON.stringify(extract);
	db.prepare(
		`UPDATE messages SET extracted_data = ?, extracted_at = ? WHERE id = ?`,
	).run(json, Date.now(), messageId);
}

export interface AgentActionInput {
	tool: string;
	messageId?: number | null;
	actor: 'orchestrator' | 'worker' | 'operator-direct';
	args?: unknown;
	result?: unknown;
	conversationKey?: string | null;
}

/** Count successful `inbox-mark-processed` actions in the audit log. Used
 *  by the L3 confirmation gate (ADR-L3 §D7 Guardrail 1) — until this count
 *  reaches 50, the tool returns a proposal instead of executing directly.
 *
 *  Cumulative from agent_actions (not per-process). The ADR's "resets on
 *  PM2 restart" phrasing is overridden by its own next sentence — "track
 *  in agent_actions log" — which makes the durable tally load-bearing.
 *  Operator forces the gate back on via `INBOX_MARK_PROCESSED_CONFIRM=always`. */
export function countConfirmedMarkProcessed(): number {
	try {
		const db = getInboxDb();
		const row = db
			.prepare(
				`SELECT COUNT(*) AS c FROM agent_actions
				 WHERE tool = 'inbox-mark-processed'
				   AND result LIKE '%"ok":true%'`,
			)
			.get() as { c: number };
		return row.c;
	} catch (err) {
		console.warn('[inbox/agent-actions] count failed:', (err as Error).message);
		return 0;
	}
}

/** Append a row to the agent_actions audit log. Never throws — failures
 *  are logged and swallowed so a logging error can't break the calling
 *  tool's reply path. */
export function recordAgentAction(input: AgentActionInput): void {
	try {
		const db = getInboxDb();
		db.prepare(
			`INSERT INTO agent_actions (timestamp, tool, message_id, actor, args, result, conversation_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			Date.now(),
			input.tool,
			input.messageId ?? null,
			input.actor,
			input.args === undefined ? null : JSON.stringify(input.args),
			input.result === undefined ? null : JSON.stringify(input.result),
			input.conversationKey ?? null,
		);
	} catch (err) {
		console.warn('[inbox/agent-actions] insert failed:', (err as Error).message);
	}
}

export interface AgentActionRow {
	id: number;
	timestamp: number;
	tool: string;
	messageId: number | null;
	actor: string;
	args: unknown;
	result: unknown;
	conversationKey: string | null;
}

/** Fetch agent_actions rows for a given message, newest first. Used by
 *  inbox-drill-down to show "what's the agent done with this row" —
 *  e.g. "anomaly-pushed at 07:25", "extract ran with body fallback".
 *  Args/result JSON is parsed so callers don't have to. */
export function listAgentActions(messageId: number, limit = 20): AgentActionRow[] {
	const db = getInboxDb();
	const rows = db
		.prepare(
			`SELECT id, timestamp, tool, message_id, actor, args, result, conversation_key
			 FROM agent_actions
			 WHERE message_id = ?
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(messageId, limit) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as number,
		timestamp: r.timestamp as number,
		tool: r.tool as string,
		messageId: r.message_id as number | null,
		actor: r.actor as string,
		args: safeJsonParse(r.args as string | null),
		result: safeJsonParse(r.result as string | null),
		conversationKey: r.conversation_key as string | null,
	}));
}

function safeJsonParse(s: string | null): unknown {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

export interface AgentActionsQuery {
	tool?: string;
	messageId?: number;
	actor?: string;
	since?: number;
	confirmedOnly?: boolean;
	limit?: number;
	offset?: number;
}

export interface AgentActionsResult {
	actions: AgentActionRow[];
	total: number;
	byTool: Record<string, number>;
}

/** Generalized agent_actions query — supports the L3 audit-log surface
 *  (ADR-L3 §D7 G2). Mirrors `listAgentActions(messageId)` but accepts
 *  any combination of filters and returns a total count + per-tool
 *  histogram so the UI doesn't have to issue follow-up queries. */
export function queryAgentActions(opts: AgentActionsQuery = {}): AgentActionsResult {
	const db = getInboxDb();
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const offset = Math.max(opts.offset ?? 0, 0);

	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.tool) {
		where.push('tool = ?');
		params.push(opts.tool);
	}
	if (opts.messageId !== undefined) {
		where.push('message_id = ?');
		params.push(opts.messageId);
	}
	if (opts.actor) {
		where.push('actor = ?');
		params.push(opts.actor);
	}
	if (opts.since !== undefined) {
		where.push('timestamp >= ?');
		params.push(opts.since);
	}
	if (opts.confirmedOnly) {
		where.push(`result LIKE '%"ok":true%'`);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

	const rows = db
		.prepare(
			`SELECT id, timestamp, tool, message_id, actor, args, result, conversation_key
			 FROM agent_actions
			 ${whereSql}
			 ORDER BY id DESC
			 LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset) as Record<string, unknown>[];

	const total = (
		db.prepare(`SELECT COUNT(*) AS c FROM agent_actions ${whereSql}`).get(...params) as { c: number }
	).c;

	const byToolRows = db
		.prepare(
			`SELECT tool, COUNT(*) AS c
			 FROM agent_actions
			 ${whereSql}
			 GROUP BY tool
			 ORDER BY c DESC`,
		)
		.all(...params) as { tool: string; c: number }[];
	const byTool: Record<string, number> = {};
	for (const r of byToolRows) byTool[r.tool] = r.c;

	const actions = rows.map((r) => ({
		id: r.id as number,
		timestamp: r.timestamp as number,
		tool: r.tool as string,
		messageId: r.message_id as number | null,
		actor: r.actor as string,
		args: safeJsonParse(r.args as string | null),
		result: safeJsonParse(r.result as string | null),
		conversationKey: r.conversation_key as string | null,
	}));
	return { actions, total, byTool };
}

// ── Sync State ──

export function getSyncState(accountId: string, folder: string): SyncState | null {
	const db = getInboxDb();
	const row = db.prepare('SELECT * FROM sync_state WHERE account_id = ? AND folder = ?')
		.get(accountId, folder) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		accountId: row.account_id as string,
		folder: row.folder as string,
		lastUid: row.last_uid as number,
		uidValidity: row.uid_validity as number,
		lastSync: row.last_sync as number,
	};
}

export function upsertSyncState(state: SyncState): void {
	const db = getInboxDb();
	db.prepare(`
		INSERT INTO sync_state (account_id, folder, last_uid, uid_validity, last_sync)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(account_id, folder) DO UPDATE SET
			last_uid = excluded.last_uid,
			uid_validity = excluded.uid_validity,
			last_sync = excluded.last_sync
	`).run(state.accountId, state.folder, state.lastUid, state.uidValidity, state.lastSync);
}

// ── Stats ──

/**
 * Delete all messages for (account, folder), optionally filtered to a specific
 * `uid_validity`. Used by the sync worker when the server reports a UIDVALIDITY
 * change — the old uid <-> message mapping is invalid and the existing rows
 * would otherwise show up in the inbox UI as orphans.
 */
export function deleteMessagesByFolder(
	accountId: string,
	folder: string,
	uidValidity?: number,
): number {
	const db = getInboxDb();
	let sql = 'DELETE FROM messages WHERE account_id = ? AND folder = ?';
	const params: (string | number)[] = [accountId, folder];
	if (uidValidity !== undefined) {
		sql += ' AND uid_validity = ?';
		params.push(uidValidity);
	}
	const result = db.prepare(sql).run(...params);
	if (result.changes > 0) {
		console.log(
			`[inbox:${accountId}] Deleted ${result.changes} messages from ${folder}` +
				(uidValidity !== undefined ? ` (uid_validity=${uidValidity})` : ''),
		);
	}
	return result.changes;
}

/**
 * Layer 2 status-aware retention (see ADR 2026-05-11-inbox-processing-filter-layer §D6).
 *
 * - skipped:   14 days hardcoded (promotional/bulk — aggressive prune)
 * - queued:    per-account retention_days (operator-configurable)
 * - processed: 365 days hardcoded (agent-handled, long audit trail)
 * - new:       never pruned, BUT a 7-day "stuck-new" safety net promotes them
 *              to category='unclassified' + process_status='queued' so they
 *              surface to agents instead of rotting silently if the worker dies.
 *
 * `is_flagged = 1` rows are preserved across all statuses (existing semantics).
 *
 * Returns total messages affected (deleted + promoted).
 */
export function pruneOldMessages(accountId: string, retentionDays: number, opts?: { queuedNoMatchDays?: number }): number {
	const db = getInboxDb();
	const now = Date.now();
	let total = 0;

	const tx = db.transaction(() => {
		// 1. skipped — 14 days
		const skippedCutoff = now - 14 * 24 * 60 * 60 * 1000;
		const skipped = db.prepare(`
			DELETE FROM messages
			WHERE account_id = ?
			  AND process_status = 'skipped'
			  AND date_received < ?
			  AND is_flagged = 0
		`).run(accountId, skippedCutoff);
		total += skipped.changes;

		// 2a. queued + L3-evaluated + no rule match — tight retention.
		// These are messages the auto-route worker SAW and chose NOT to act
		// on (no agent_actions row at all, or only failed attempts). Keeping
		// them for 30/90 days bloats the candidate query and doesn't help
		// the operator. Personal is exempt — humans curate it themselves.
		// `unknown` is exempt — the operator may want to manually classify.
		if (opts?.queuedNoMatchDays && opts.queuedNoMatchDays > 0) {
			const noMatchCutoff = now - opts.queuedNoMatchDays * 24 * 60 * 60 * 1000;
			const noMatch = db.prepare(`
				DELETE FROM messages
				WHERE account_id = ?
				  AND process_status = 'queued'
				  AND category IN ('transactional', 'notification')
				  AND date_received < ?
				  AND is_flagged = 0
				  AND NOT EXISTS (
				    SELECT 1 FROM agent_actions a
				    WHERE a.message_id = messages.id
				      AND a.tool = 'inbox-route-to-vault'
				      AND json_extract(a.result, '$.ok') = 1
				  )
			`).run(accountId, noMatchCutoff);
			total += noMatch.changes;
			if (noMatch.changes > 0) {
				console.log(
					`[inbox-prune:${accountId}] Deleted ${noMatch.changes} queued no-match rows (>${opts.queuedNoMatchDays}d old)`,
				);
			}
		}

		// 2b. queued — operator-configured retention (the legacy long window)
		// catches personal mail + unclassified that bypassed the 2a cutoff.
		if (retentionDays > 0) {
			const queuedCutoff = now - retentionDays * 24 * 60 * 60 * 1000;
			const queued = db.prepare(`
				DELETE FROM messages
				WHERE account_id = ?
				  AND process_status = 'queued'
				  AND date_received < ?
				  AND is_flagged = 0
			`).run(accountId, queuedCutoff);
			total += queued.changes;
		}

		// 3. processed — 365 days from the agent action (processed_at).
		// COALESCE falls back to date_received for any pre-migration-#7 rows
		// that lack a processed_at stamp — keeps the retention window from
		// growing unbounded if a row gets marked processed by a code path
		// that bypassed markMessageProcessed.
		const processedCutoff = now - 365 * 24 * 60 * 60 * 1000;
		const processed = db.prepare(`
			DELETE FROM messages
			WHERE account_id = ?
			  AND process_status = 'processed'
			  AND COALESCE(processed_at, date_received) < ?
			  AND is_flagged = 0
		`).run(accountId, processedCutoff);
		total += processed.changes;

		// 4. 7-day stuck-new safety net (per-account-bounded for parity with prune scope)
		const stuckCutoff = now - 7 * 24 * 60 * 60 * 1000;
		const promoted = db.prepare(`
			UPDATE messages
			SET category = 'unclassified',
			    process_status = 'queued',
			    filter_reason = 'stuck-new-fallback',
			    filtered_at = ?
			WHERE account_id = ?
			  AND process_status = 'new'
			  AND synced_at < ?
		`).run(now, accountId, stuckCutoff);
		total += promoted.changes;

		if (promoted.changes > 0) {
			console.log(
				`[inbox-prune:${accountId}] Promoted ${promoted.changes} stuck-new messages to unclassified/queued`,
			);
		}
	});
	tx();

	if (total > 0) {
		console.log(`[inbox-prune:${accountId}] Pruned/promoted ${total} messages (retention=${retentionDays}d for queued)`);
	}
	return total;
}

export function updateAccountSettings(
	id: string,
	settings: { label?: string; retentionDays?: number; oauthClientRef?: string | null },
): boolean {
	const db = getInboxDb();
	const sets: string[] = [];
	const params: unknown[] = [];

	if (settings.label !== undefined) {
		sets.push('label = ?');
		params.push(settings.label);
	}
	// retentionDays = 0 is the "never delete" sentinel — pruneOldMessages
	// already short-circuits on retentionDays <= 0. Accept 0..365.
	if (
		settings.retentionDays !== undefined &&
		settings.retentionDays >= 0 &&
		settings.retentionDays <= 365
	) {
		sets.push('retention_days = ?');
		params.push(settings.retentionDays);
	}
	if (settings.oauthClientRef !== undefined) {
		sets.push('oauth_client_ref = ?');
		params.push(settings.oauthClientRef);
	}
	if (sets.length === 0) return false;

	params.push(id);
	const result = db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
	return result.changes > 0;
}

export function updateAccountCredential(id: string, credential: string): boolean {
	const db = getInboxDb();
	const encrypted = encrypt(credential);
	const result = db.prepare(`
		UPDATE accounts
		SET encrypted_credential = ?, status = 'disconnected', last_error = NULL
		WHERE id = ?
	`).run(encrypted, id);
	return result.changes > 0;
}

export function getInboxStats(): { accounts: number; messages: number; lastSync: number | null } {
	const db = getInboxDb();
	const accounts = (db.prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number }).c;
	const messages = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
	const lastSync = (db.prepare('SELECT MAX(last_sync) as ls FROM accounts').get() as { ls: number | null }).ls;
	return { accounts, messages, lastSync };
}

// ── Layer 2 Filter — rules, cache, classification ──
// See ADR 2026-05-11-inbox-processing-filter-layer.

export function listFilterRules(opts: { enabledOnly?: boolean; accountId?: string | null } = {}): FilterRule[] {
	const db = getInboxDb();
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (opts.enabledOnly) {
		conditions.push('enabled = 1');
	}
	if (opts.accountId === null) {
		conditions.push('account_id IS NULL');
	} else if (opts.accountId !== undefined) {
		conditions.push('(account_id IS NULL OR account_id = ?)');
		params.push(opts.accountId);
	}
	const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
	const rows = db.prepare(
		`SELECT * FROM filter_rules ${where} ORDER BY precedence ASC, created_at ASC`,
	).all(...params) as Record<string, unknown>[];
	return rows.map(rowToFilterRule);
}

export function getFilterRule(id: number): FilterRule | null {
	const db = getInboxDb();
	const row = db.prepare(`SELECT * FROM filter_rules WHERE id = ?`).get(id) as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	return rowToFilterRule(row);
}

export function insertFilterRule(input: {
	accountId?: string | null;
	precedence: number;
	matchType: FilterRuleMatchType;
	matchValue: string;
	actionCategory: FilterCategory;
	reason?: string | null;
	createdBy?: 'system' | 'user' | 'agent';
	enabled?: boolean;
}): number {
	const db = getInboxDb();
	const result = db.prepare(`
		INSERT INTO filter_rules
			(account_id, precedence, match_type, match_value, action_category, reason, created_by, created_at, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		input.accountId ?? null,
		input.precedence,
		input.matchType,
		input.matchValue,
		input.actionCategory,
		input.reason ?? null,
		input.createdBy ?? 'user',
		Date.now(),
		input.enabled === false ? 0 : 1,
	);
	return Number(result.lastInsertRowid);
}

export function setFilterRuleEnabled(id: number, enabled: boolean): boolean {
	const db = getInboxDb();
	const result = db.prepare(`UPDATE filter_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	return result.changes > 0;
}

/**
 * Delete a filter rule. Refuses on system-seeded rows — operators can disable
 * them (setFilterRuleEnabled(id, false)) but not delete. Prevents accidental
 * loss of the curated defaults shipped via migration #6.
 */
export function deleteFilterRule(id: number): { deleted: boolean; reason?: 'system_rule_protected' | 'not_found' } {
	const db = getInboxDb();
	const existing = db.prepare(`SELECT created_by FROM filter_rules WHERE id = ?`).get(id) as
		| { created_by: string }
		| undefined;
	if (!existing) return { deleted: false, reason: 'not_found' };
	if (existing.created_by === 'system') return { deleted: false, reason: 'system_rule_protected' };
	const result = db.prepare(`DELETE FROM filter_rules WHERE id = ?`).run(id);
	return { deleted: result.changes > 0 };
}

export function getFilterCache(signature: string): FilterCacheEntry | null {
	const db = getInboxDb();
	const row = db.prepare(`SELECT * FROM filter_cache WHERE signature = ?`).get(signature) as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	return rowToFilterCache(row);
}

/**
 * Upsert a cache entry. New rows: first_hit_at = last_hit_at = now, hit_count = 1.
 * Existing rows: bump hit_count, refresh last_hit_at, leave first_hit_at, and
 * overwrite category/reason/user_corrected (the caller's whole point of
 * upserting is to update the cached decision).
 */
export function setFilterCache(input: {
	signature: string;
	category: FilterCategory;
	reason?: string | null;
	userCorrected?: boolean;
}): void {
	const db = getInboxDb();
	const now = Date.now();
	db.prepare(`
		INSERT INTO filter_cache (signature, category, reason, hit_count, first_hit_at, last_hit_at, user_corrected)
		VALUES (?, ?, ?, 1, ?, ?, ?)
		ON CONFLICT(signature) DO UPDATE SET
			category = excluded.category,
			reason = excluded.reason,
			user_corrected = excluded.user_corrected,
			hit_count = filter_cache.hit_count + 1,
			last_hit_at = excluded.last_hit_at
	`).run(
		input.signature,
		input.category,
		input.reason ?? null,
		now,
		now,
		input.userCorrected ? 1 : 0,
	);
}

/** Touch hit_count / last_hit_at without rewriting category — for cache:hit reads. */
export function bumpFilterCacheHit(signature: string): void {
	const db = getInboxDb();
	db.prepare(
		`UPDATE filter_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE signature = ?`,
	).run(Date.now(), signature);
}

/**
 * Apply a classification to a message. Sets category, derives process_status
 * via CATEGORY_TO_STATUS, writes filter_reason + filtered_at = now.
 * Optionally accepts pre-parsed header_signals JSON to persist alongside.
 *
 * `preserveProcessed` (default false): when the source row is already
 * `processed` (agent acted on it), the status is NOT overwritten. Used by
 * the correction path so user reclassification doesn't undo agent work or
 * re-queue rows the heartbeat already handled. Default-false keeps the
 * Layer 2 classifier callers (cache/rule/LLM hits on `new` rows) unchanged.
 */
export function applyClassification(
	messageId: number,
	input: {
		category: FilterCategory;
		reason: string;
		headerSignalsJson?: string | null;
		preserveProcessed?: boolean;
	},
): boolean {
	const db = getInboxDb();
	let status: string = CATEGORY_TO_STATUS[input.category];
	if (input.preserveProcessed) {
		const current = db
			.prepare('SELECT process_status FROM messages WHERE id = ?')
			.get(messageId) as { process_status: string } | undefined;
		if (current?.process_status === 'processed') status = 'processed';
	}
	const sets = ['category = ?', 'process_status = ?', 'filter_reason = ?', 'filtered_at = ?'];
	const params: unknown[] = [input.category, status, input.reason, Date.now()];
	if (input.headerSignalsJson !== undefined) {
		sets.push('header_signals = ?');
		params.push(input.headerSignalsJson);
	}
	params.push(messageId);
	const result = db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
	return result.changes > 0;
}

/** Persist parsed header signals without re-classifying. Used by cold-start. */
export function setMessageHeaderSignals(messageId: number, headerSignalsJson: string): boolean {
	const db = getInboxDb();
	const result = db.prepare(`UPDATE messages SET header_signals = ? WHERE id = ?`).run(
		headerSignalsJson,
		messageId,
	);
	return result.changes > 0;
}

export function markMessageProcessed(messageId: number): boolean {
	const db = getInboxDb();
	const result = db.prepare(`
		UPDATE messages
		SET process_status = 'processed', processed_at = ?
		WHERE id = ? AND process_status = 'queued'
	`).run(Date.now(), messageId);
	return result.changes > 0;
}

/**
 * List messages awaiting classification. Two modes:
 *   - cold-start: pass workerStartTs → only rows with synced_at < workerStartTs - 5s,
 *     filtered_at IS NULL, process_status='new'. Idempotent across crashes.
 *   - steady-state: pass workerStartTs=undefined → just rows with process_status='new'
 *     and filtered_at IS NULL. limit defaults to 50.
 */
export function listMessagesForFiltering(opts: { workerStartTs?: number; limit?: number } = {}): InboxMessage[] {
	const db = getInboxDb();
	const limit = opts.limit ?? 50;
	const conditions = [`process_status = 'new'`, `filtered_at IS NULL`];
	const params: unknown[] = [];
	if (opts.workerStartTs !== undefined) {
		conditions.push(`synced_at < ?`);
		params.push(opts.workerStartTs - 5_000);
	}
	const rows = db.prepare(
		`SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY account_id, synced_at LIMIT ?`,
	).all(...params, limit) as Record<string, unknown>[];
	return rows.map(rowToMessage);
}

/**
 * Re-classify all messages matching a cache signature. Used by the correction
 * loop: when a user/agent corrects the cache, all `new` + `skipped` rows
 * sharing the signature are updated in one transaction. `queued`/`processed`
 * rows are LEFT ALONE (agents may have acted on them).
 *
 * `excludeMessageId` (optional): the source row of the correction is
 * normally updated by the caller via `applyClassification` BEFORE this
 * function runs. Passing the source id here excludes it from the sibling
 * count so the returned number is the true count of OTHER rows reclassified.
 *
 * Returns the count of sibling rows whose state changed.
 */
export function reclassifyBySignature(
	signature: string,
	category: FilterCategory,
	reason: string,
	signatureOf: (msg: { fromAddress: string; subject: string }) => string,
	excludeMessageId?: number,
): number {
	const db = getInboxDb();
	const status = CATEGORY_TO_STATUS[category];
	const now = Date.now();

	// Find candidate rows. Recomputing the signature in JS is cheaper than a
	// SQL signature predicate (no DB-side hash). We bound to status IN
	// ('new','skipped') here — applying corrections to in-flight queued mail
	// or already-processed rows creates inconsistency (see ADR §D4).
	const candidates = db.prepare(`
		SELECT id, from_address, subject FROM messages
		WHERE process_status IN ('new','skipped')
	`).all() as Array<{ id: number; from_address: string; subject: string }>;

	let updated = 0;
	const upd = db.prepare(`
		UPDATE messages
		SET category = ?, process_status = ?, filter_reason = ?, filtered_at = ?
		WHERE id = ?
	`);
	const tx = db.transaction(() => {
		for (const row of candidates) {
			if (excludeMessageId !== undefined && row.id === excludeMessageId) continue;
			const sig = signatureOf({ fromAddress: row.from_address, subject: row.subject });
			if (sig === signature) {
				const r = upd.run(category, status, reason, now, row.id);
				updated += r.changes;
			}
		}
	});
	tx();
	return updated;
}

/** Aggregated stats for the settings UI / stats endpoint. */
export function getFilterStats(): {
	ruleCount: number;
	systemRuleCount: number;
	userRuleCount: number;
	cacheSize: number;
	queuedCount: number;
	skippedCount: number;
	newCount: number;
	processedCount: number;
	byCategory: Record<string, number>;
} {
	const db = getInboxDb();
	const ruleRow = db.prepare(
		`SELECT COUNT(*) AS total, SUM(CASE WHEN created_by='system' THEN 1 ELSE 0 END) AS sys FROM filter_rules`,
	).get() as { total: number; sys: number | null };
	const cacheSize = (db.prepare(`SELECT COUNT(*) AS c FROM filter_cache`).get() as { c: number }).c;
	const queuedCount = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE process_status='queued'`).get() as { c: number }).c;
	const skippedCount = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE process_status='skipped'`).get() as { c: number }).c;
	const newCount = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE process_status='new'`).get() as { c: number }).c;
	const processedCount = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE process_status='processed'`).get() as { c: number }).c;
	const catRows = db.prepare(
		`SELECT category, COUNT(*) AS c FROM messages WHERE category IS NOT NULL GROUP BY category`,
	).all() as Array<{ category: string; c: number }>;
	const byCategory: Record<string, number> = {};
	for (const r of catRows) byCategory[r.category] = r.c;
	return {
		ruleCount: ruleRow.total,
		systemRuleCount: ruleRow.sys ?? 0,
		userRuleCount: (ruleRow.total ?? 0) - (ruleRow.sys ?? 0),
		cacheSize,
		queuedCount,
		skippedCount,
		newCount,
		processedCount,
		byCategory,
	};
}

function rowToFilterRule(row: Record<string, unknown>): FilterRule {
	return {
		id: row.id as number,
		accountId: (row.account_id as string | null) ?? null,
		precedence: row.precedence as number,
		matchType: row.match_type as FilterRuleMatchType,
		matchValue: row.match_value as string,
		actionCategory: row.action_category as FilterCategory,
		reason: (row.reason as string | null) ?? null,
		createdAt: row.created_at as number,
		createdBy: (row.created_by as 'system' | 'user' | 'agent') ?? 'user',
		enabled: (row.enabled as number) === 1,
	};
}

function rowToFilterCache(row: Record<string, unknown>): FilterCacheEntry {
	return {
		signature: row.signature as string,
		category: row.category as FilterCategory,
		reason: (row.reason as string | null) ?? null,
		hitCount: row.hit_count as number,
		firstHitAt: row.first_hit_at as number,
		lastHitAt: row.last_hit_at as number,
		userCorrected: (row.user_corrected as number) === 1,
	};
}
