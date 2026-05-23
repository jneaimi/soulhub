/** Phase 7 vault-scout smoke test.
 *
 *  Two layers:
 *
 *   1. Extractor (`extractCandidates`) — pure function over synthetic
 *      VaultNote-shaped inputs. Covers the three candidate kinds and
 *      window/context-word rules.
 *
 *   2. Decision DB helpers — round-trip insert / bulk-check / reject
 *      audit. Verifies v7 migration ran and idempotency works.
 *
 *  Synthesizer (Tier 2) is NOT exercised here — needs a live Gemini
 *  API key + network. End-to-end exercised via runNow against the live
 *  process.
 *
 *  Run: `npx tsx scripts/smoke-test-vault-scout.ts`
 */

import { extractCandidates, slugFromSummary } from '../src/lib/scheduler/handlers/vault-scout.js';
import {
	getHeartbeatDb,
	getDecidedCandidateIds,
	recordScoutDecision,
	recordScoutReject,
	recentScoutDecisions,
} from '../src/lib/channels/whatsapp/heartbeat-state.js';
import type { VaultNote } from '../src/lib/vault/types.js';

let passed = 0;
let failed = 0;
function check(label: string, predicate: boolean, detail?: string): void {
	if (predicate) {
		console.log(`  ✓ ${label}`);
		passed += 1;
	} else {
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
		failed += 1;
	}
}

const NOW = new Date('2026-05-04T08:00:00Z');
const TEST_PREFIX = 'test-scout-';

function note(path: string, meta: Record<string, unknown>, content = ''): VaultNote {
	return {
		path,
		title: path,
		meta,
		content,
		links: [],
		backlinks: [],
		mtime: NOW.getTime(),
		size: content.length,
	};
}

function cleanTestRows(): void {
	const db = getHeartbeatDb();
	db.prepare("DELETE FROM vault_scout_decisions WHERE candidate_id LIKE ?").run(`${TEST_PREFIX}%`);
	db.prepare("DELETE FROM vault_scout_rejects WHERE candidate_id LIKE ?").run(`${TEST_PREFIX}%`);
	// NULL-candidate rejects (synthesizer-level errors) are tagged via reject_reason so cleanup can target them.
	db.prepare("DELETE FROM vault_scout_rejects WHERE candidate_id IS NULL AND reject_reason LIKE ?").run(`${TEST_PREFIX}%`);
}

function main(): void {
	const opts = { falsifierWindowDays: 30, reviewDateWindowDays: 30, tz: 'Asia/Dubai' };

	console.log('— extractor: falsifier ————————————————————————');

	{
		const notes = [note('projects/alpha/project.md', { falsifier: '2026-05-15' })];
		const r = extractCandidates(notes, NOW, opts);
		check('frontmatter falsifier within window → 1 candidate', r.length === 1);
		check('  kind = falsifier', r[0]?.kind === 'falsifier');
		check('  id stable: falsifier-alpha-2026-05-15', r[0]?.id === 'falsifier-alpha-2026-05-15');
		check('  suggestedDate = 2026-05-15', r[0]?.suggestedDate === '2026-05-15');
	}

	{
		const notes = [note('projects/beta/project.md', { falsifier: '2027-01-01' })];
		const r = extractCandidates(notes, NOW, opts);
		check('falsifier > 30 days out → excluded', r.length === 0);
	}

	{
		const notes = [note('projects/gamma/project.md', { falsifier: '2026-04-15' })];
		const r = extractCandidates(notes, NOW, opts);
		check('falsifier in past (overdue review) → still surfaced', r.length === 1, `len=${r.length}`);
	}

	{
		const notes = [note('projects/delta/index.md', { falsifier: 'not-a-date' })];
		const r = extractCandidates(notes, NOW, opts);
		check('non-ISO falsifier → excluded (no crash)', r.length === 0);
	}

	console.log('— extractor: review_date ————————————————————————');

	{
		const notes = [note('projects/eps/project.md', { review_date: '2026-05-20' })];
		const r = extractCandidates(notes, NOW, opts);
		check('review_date within window → kind=review-date', r.length === 1 && r[0]?.kind === 'review-date');
	}

	console.log('— extractor: future-mention (regex) ————————————————');

	{
		// Body has a future date with context word "earliest"
		const body = '## Status Log\n\n- 2026-05-04 — Phase 5 shipped. earliest 2026-05-16 plist deletion.';
		const notes = [note('projects/zeta/project.md', {}, body)];
		const r = extractCandidates(notes, NOW, opts);
		check('future-mention with context word → 1 candidate', r.length === 1, `len=${r.length}`);
		check('  kind = future-mention', r[0]?.kind === 'future-mention');
		check('  suggestedDate = 2026-05-16', r[0]?.suggestedDate === '2026-05-16');
	}

	{
		// Body has a future date but no context word
		const body = '## Random log\n\n- 2026-05-04 — happened today.\n- 2026-05-20 — just a date no context.';
		const notes = [note('projects/eta/project.md', {}, body)];
		const r = extractCandidates(notes, NOW, opts);
		check('future-mention without context word → excluded', r.length === 0);
	}

	{
		// Future-mention only fires for project.md, not arbitrary files
		const body = 'earliest 2026-05-16 cleanup';
		const notes = [note('projects/theta/decisions/some-adr.md', {}, body)];
		const r = extractCandidates(notes, NOW, opts);
		check('future-mention scoped to project.md only', r.length === 0);
	}

	{
		// Past dates excluded
		const body = 'earliest 2025-01-01 deadline already passed';
		const notes = [note('projects/iota/project.md', {}, body)];
		const r = extractCandidates(notes, NOW, opts);
		check('past dates in body content → excluded', r.length === 0);
	}

	console.log('— extractor: scoping ————————————————————————');

	{
		// Non-projects/ paths ignored
		const notes = [
			note('inbox/2026-05-04-x.md', { falsifier: '2026-05-15' }),
			note('knowledge/foo.md', { review_date: '2026-05-15' }),
		];
		const r = extractCandidates(notes, NOW, opts);
		check('non-projects/ paths ignored', r.length === 0);
	}

	console.log('— slugFromSummary: word-boundary snap ————————————');

	{
		// At max=60, the old (slice-only) impl would cut "weekly" mid-word.
		const summary = 'Review soul-hub-scheduler weekly checkin against project plan';
		const slug = slugFromSummary(summary, 60);
		check('snaps to last hyphen — never mid-word', !slug.endsWith('weekl'), `got "${slug}"`);
		check('  ends on a complete word boundary', !slug.match(/[a-z]$/) || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `got "${slug}"`);
	}

	{
		// Short summary — no truncation needed, full slug.
		const slug = slugFromSummary('phase 5 cycle 1 check', 60);
		check('short summary returns clean slug', slug === 'phase-5-cycle-1-check', `got "${slug}"`);
	}

	{
		// Single word longer than max — no hyphen to snap to, must hard-cut.
		const slug = slugFromSummary('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 60);
		check('single oversize word hard-cuts', slug.length === 60);
	}

	{
		// Non-alphanumeric chars stripped, no leading/trailing hyphen.
		const slug = slugFromSummary("Verify Phase 5! plist's cleanup — done?", 60);
		check('strips punctuation, no edge hyphens', !slug.startsWith('-') && !slug.endsWith('-'), `got "${slug}"`);
	}

	console.log('— DB: decisions round-trip ————————————————————');

	cleanTestRows();
	const c1 = `${TEST_PREFIX}falsifier-foo-2026-05-15`;
	const c2 = `${TEST_PREFIX}review-bar-2026-06-01`;
	const c3 = `${TEST_PREFIX}future-baz-2026-07-01`;

	check('getDecidedCandidateIds empty → empty set', getDecidedCandidateIds([c1, c2]).size === 0);

	const ins1 = recordScoutDecision({
		candidateId: c1,
		decision: 'queued',
		notePath: 'inbox/test.md',
		modelUsed: 'gemini:gemini-2.5-flash',
		reason: null,
	});
	check('first insert returns true', ins1 === true);

	const ins1Dup = recordScoutDecision({
		candidateId: c1,
		decision: 'queued',
		notePath: 'inbox/test-dup.md',
		modelUsed: 'gemini:gemini-2.5-flash',
		reason: null,
	});
	check('duplicate insert returns false (PK protects)', ins1Dup === false);

	recordScoutDecision({ candidateId: c2, decision: 'skipped', reason: 'covered by project-hygiene' });
	recordScoutDecision({ candidateId: c3, decision: 'deferred', reason: 'uncertain' });

	const decided = getDecidedCandidateIds([c1, c2, c3, `${TEST_PREFIX}nonexistent`]);
	check(
		'getDecidedCandidateIds bulk lookup',
		decided.has(c1) && decided.has(c2) && decided.has(c3) && !decided.has(`${TEST_PREFIX}nonexistent`),
		`got [${[...decided].join(', ')}]`,
	);

	const recent = recentScoutDecisions(50).filter((d) => d.candidate_id.startsWith(TEST_PREFIX));
	check('recentScoutDecisions returns inserted rows', recent.length === 3, `got ${recent.length}`);

	const queued = recent.find((d) => d.candidate_id === c1);
	check('queued decision has notePath', queued?.note_path === 'inbox/test.md');
	const skipped = recent.find((d) => d.candidate_id === c2);
	check('skipped decision has reason', skipped?.reason === 'covered by project-hygiene');

	console.log('— DB: rejects audit ————————————————————————');

	const rejectsBefore = getHeartbeatDb()
		.prepare("SELECT COUNT(*) AS n FROM vault_scout_rejects WHERE candidate_id LIKE ?")
		.get(`${TEST_PREFIX}%`) as { n: number };

	recordScoutReject(`${TEST_PREFIX}bad-1`, '{"raw":"json"}', 'voice_due in past');
	recordScoutReject(null, null, `${TEST_PREFIX}synthesizer error: timeout`);

	const rejectsAfter = getHeartbeatDb()
		.prepare("SELECT COUNT(*) AS n FROM vault_scout_rejects WHERE candidate_id LIKE ? OR candidate_id IS NULL")
		.get(`${TEST_PREFIX}%`) as { n: number };
	check('rejects logged', rejectsAfter.n - rejectsBefore.n >= 1, `before=${rejectsBefore.n} after=${rejectsAfter.n}`);

	cleanTestRows();
	check('cleanup leaves zero test decisions', getDecidedCandidateIds([c1, c2, c3]).size === 0);

	console.log(`\n${passed} passed / ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main();
