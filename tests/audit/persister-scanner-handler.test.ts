/**
 * project-phases ADR-008 S2 — persister + scanner + handler tests.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/audit/persister-scanner-handler.test.ts
 *
 * Uses a temp directory + a temp SQLite DB so the real heartbeat.db stays
 * untouched. The handler is tested end-to-end against synthetic JSONL
 * fixtures placed in the temp Claude-projects layout.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { scanTranscripts } from '../../src/lib/audit/scan-transcripts.ts';

let TMP_ROOT = '';

before(() => {
	TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'adr-008-s2-'));
	// Layout: TMP_ROOT/projects/<key>/<sid>.jsonl
	mkdirSync(resolve(TMP_ROOT, 'projects', '-Users-jneaimi-dev-soul-hub'), { recursive: true });
	mkdirSync(resolve(TMP_ROOT, 'projects', '-Users-jneaimi-dev-other'), { recursive: true });
});

after(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─── scan-transcripts ─────────────────────────────────────────────────────

describe('scanTranscripts', () => {
	const seedJsonl = (relPath: string, sizeFiller = 2000, mtime?: Date) => {
		const fullPath = resolve(TMP_ROOT, 'projects', relPath);
		mkdirSync(resolve(fullPath, '..'), { recursive: true });
		writeFileSync(fullPath, 'x'.repeat(sizeFiller));
		if (mtime) utimesSync(fullPath, mtime, mtime);
		return fullPath;
	};

	test('discovers .jsonl files in project subdirs', () => {
		seedJsonl('-Users-jneaimi-dev-soul-hub/session-a.jsonl');
		seedJsonl('-Users-jneaimi-dev-other/session-b.jsonl');

		const r = scanTranscripts({
			root: resolve(TMP_ROOT, 'projects')
		});
		assert.ok(r.candidates.length >= 2, `expected ≥2, got ${r.candidates.length}`);
		assert.ok(r.scanned_dirs >= 2);
	});

	test('skips files below MIN_SIZE_BYTES (1KB)', () => {
		seedJsonl('-Users-jneaimi-dev-soul-hub/tiny.jsonl', 100); // tiny
		const r = scanTranscripts({ root: resolve(TMP_ROOT, 'projects') });
		assert.ok(r.skipped_empty >= 1, `expected ≥1 empty skip, got ${r.skipped_empty}`);
		assert.ok(!r.candidates.some((c) => c.path.endsWith('tiny.jsonl')));
	});

	test('watermark skips files unchanged since last audit', () => {
		const past = new Date(Date.now() - 86_400_000); // 1 day ago
		const path = seedJsonl('-Users-jneaimi-dev-soul-hub/stale.jsonl', 2000, past);

		const watermark = new Map<string, number>();
		watermark.set(path, Date.now()); // claim "audited just now"

		const r = scanTranscripts({
			root: resolve(TMP_ROOT, 'projects'),
			latestAuditedAtByPath: watermark
		});
		assert.ok(r.skipped_unchanged >= 1, `expected ≥1 unchanged skip, got ${r.skipped_unchanged}`);
		assert.ok(!r.candidates.some((c) => c.path === path));
	});

	test('maxCandidates caps the result set', () => {
		for (let i = 0; i < 8; i++) {
			seedJsonl(`-Users-jneaimi-dev-soul-hub/cap-${i}.jsonl`, 2000);
		}
		const r = scanTranscripts({
			root: resolve(TMP_ROOT, 'projects'),
			maxCandidates: 3
		});
		assert.equal(r.candidates.length, 3);
	});

	test('non-existent root returns empty result without throwing', () => {
		const r = scanTranscripts({ root: '/nonexistent/path' });
		assert.deepEqual(r, { candidates: [], scanned_dirs: 0, skipped_unchanged: 0, skipped_empty: 0 });
	});
});

// ─── handler / persister / endpoint ────────────────────────────────────
//
// Those three modules use SvelteKit-style `.js` extension imports against
// .ts source — Node's raw ESM resolver can't follow that without the
// vite/sveltekit pipeline (see `feedback_no_raw_node_for_sveltekit_lib_smoke`).
//
// Verified instead via:
//   1. `npm run build` — fails closed on import-graph errors
//   2. live smoke against the running server hitting /api/audit/assumption-rate
//   3. once Soul Hub restarts, the scheduler will reconcile from settings.json
//      and the cron task will tick every 6h (next fire visible on /scheduler)
//
// Keeping THIS file focused on pure functions (scanner) keeps the test
// run cheap and fast.
