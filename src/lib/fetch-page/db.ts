/**
 * fetch_log database — instrumentation for the resurface trigger (ADR §D5).
 *
 * Dedicated `~/.soul-hub/data/fetch_page.db` per the ADR's one-DB-per-concern
 * decision. Mirrors `src/lib/crm/db.ts` shape exactly: lazy singleton, WAL +
 * foreign_keys=ON + busy_timeout pragmas, user_version-pragma migrations.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../paths.js';
import type { FailureClass } from './types.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	return resolve(soulHubDataDir(), 'fetch_page.db');
}

export function getFetchPageDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());

	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('temp_store = MEMORY');
	db.pragma('busy_timeout = 5000');
	db.pragma('wal_autocheckpoint = 1000');
	db.pragma('foreign_keys = ON');

	migrate(db);

	return db;
}

export function closeFetchPageDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS fetch_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				url TEXT NOT NULL,
				host TEXT NOT NULL,
				http_status INTEGER,
				content_length INTEGER,
				latency_ms INTEGER NOT NULL,
				failure_class TEXT,
				error TEXT,
				fetched_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_fetch_log_host ON fetch_log(host);
			CREATE INDEX IF NOT EXISTS idx_fetch_log_failure_class ON fetch_log(failure_class) WHERE failure_class IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_fetch_log_recent ON fetch_log(fetched_at DESC);
		`);
		db.pragma(`user_version = 1`);
	}
}

export interface FetchLogRow {
	url: string;
	host: string;
	httpStatus: number | null;
	contentLength: number | null;
	latencyMs: number;
	failureClass: FailureClass | null;
	error: string | null;
}

/** Append a row to fetch_log. Best-effort — if the DB write fails (disk
 *  full, locked, etc.) we log the secondary failure to console but never
 *  let it propagate. The fetch itself already succeeded or failed; the log
 *  is just instrumentation. */
export function recordFetch(row: FetchLogRow): void {
	try {
		const db = getFetchPageDb();
		db.prepare(`
			INSERT INTO fetch_log (url, host, http_status, content_length, latency_ms, failure_class, error, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			row.url,
			row.host,
			row.httpStatus,
			row.contentLength,
			row.latencyMs,
			row.failureClass,
			row.error,
			Date.now(),
		);
	} catch (err) {
		console.error('[fetch-page] recordFetch failed:', (err as Error).message);
	}
}

/**
 * Classify a fetch outcome into a failure_class. Returns NULL when the
 * fetch produced usable content.
 *
 * Heuristics from ADR §D5. Order matters — earlier checks are more
 * specific.
 */
export function classifyFailure(input: {
	httpStatus: number;
	contentType: string | null;
	rawHtml: string;
	extractedLength: number;
	title: string | null;
}): FailureClass | null {
	const { httpStatus, contentType, rawHtml, extractedLength, title } = input;

	// Non-HTML responses — PDFs, images, video share links, JSON APIs, etc.
	if (contentType && !contentType.toLowerCase().includes('text/html')) {
		return 'unsupported-mime';
	}

	// Auth walls — title or HTTP status indicates a sign-in page.
	if (httpStatus === 401 || httpStatus === 403) {
		// Distinguish bot-blocked from auth-required by markers.
		const lowerHtml = rawHtml.toLowerCase();
		const botMarkers = ['cloudflare', 'akamai', 'perimeterx', 'datadome', 'cf-ray', 'attention required', 'just a moment'];
		if (botMarkers.some((m) => lowerHtml.includes(m))) return 'bot-blocked';
		if (title && /sign in|log in|login|تسجيل الدخول/i.test(title)) return 'auth-required';
		// 403 without markers — assume bot-blocked.
		if (httpStatus === 403) return 'bot-blocked';
		return 'auth-required';
	}

	if (httpStatus === 429) return 'bot-blocked';

	// Empty content — Readability extracted very little.
	if (extractedLength < 200 && httpStatus >= 200 && httpStatus < 300) {
		// Distinguish JS-hydrated SPA from genuinely empty content.
		const spaMarkers = [
			'<div id="root"',
			'<div id="app"',
			'<div id="__next"',
			'<noscript>',
			'window.__NEXT_DATA__',
			'window.__NUXT__',
		];
		if (spaMarkers.some((m) => rawHtml.includes(m))) return 'js-required';
		return 'empty-content';
	}

	return null;
}
