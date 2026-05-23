/** Phase 6 daily-focus smoke test — exercises the pure picker logic
 *  without an initialised vault. Synthetic VaultNote-like inputs cover:
 *
 *   - dual-file rule (project.md status wins over index.md)
 *   - active vs in-progress both qualify
 *   - non-active statuses excluded
 *   - Slot A/B threshold boundaries
 *   - same project doesn't land in both slots
 *   - empty result when no projects qualify
 *
 *  Run: `npx tsx scripts/smoke-test-daily-focus.ts`
 */

import { pickSlots } from '../src/lib/scheduler/handlers/daily-focus.js';
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
const DAY_MS = 24 * 60 * 60 * 1000;

function note(path: string, mtimeDaysAgo: number, status?: string): VaultNote {
	return {
		path,
		title: path,
		meta: status ? { status } : {},
		content: '',
		links: [],
		backlinks: [],
		mtime: NOW.getTime() - mtimeDaysAgo * DAY_MS,
		size: 0,
	};
}

function main(): void {
	console.log('— picker logic —');

	// Case 1: single fresh active project → Slot A populated, Slot B empty.
	{
		const notes = [note('projects/alpha/project.md', 1, 'active')];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('1 fresh active → Slot A=alpha, Slot B=null', r.slotA?.folder === 'alpha' && r.slotB === null);
		check('1 fresh active → idleDays=1', r.slotA?.idleDays === 1, `got ${r.slotA?.idleDays}`);
	}

	// Case 2: dual-file disagreement — project.md wins.
	{
		const notes = [
			note('projects/beta/index.md', 2, 'paused'),
			note('projects/beta/project.md', 2, 'active'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('dual-file: project.md (active) wins over index.md (paused)', r.slotA?.folder === 'beta');
	}

	// Case 3: in-progress also qualifies.
	{
		const notes = [note('projects/gamma/project.md', 0, 'in-progress')];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check("'in-progress' status counts as active", r.slotA?.folder === 'gamma');
	}

	// Case 4: non-active excluded.
	{
		const notes = [
			note('projects/delta/project.md', 1, 'paused'),
			note('projects/epsilon/project.md', 1, 'archived'),
			note('projects/zeta/index.md', 1, 'complete'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('paused/archived/complete excluded', r.slotA === null && r.slotB === null);
		check('candidatesActive=0 when no active', r.candidatesActive === 0);
	}

	// Case 5: stalled active → Slot B populated, Slot A empty.
	{
		const notes = [note('projects/eta/project.md', 12, 'active')];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('12d-stalled → Slot B', r.slotB?.folder === 'eta' && r.slotA === null);
	}

	// Case 6: too old (>30d) — excluded from Slot B.
	{
		const notes = [note('projects/theta/project.md', 45, 'active')];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('45d-stalled excluded (past stalledMaxDays)', r.slotA === null && r.slotB === null);
		check('still counted as active candidate', r.candidatesActive === 1);
	}

	// Case 7: gap zone (8d > freshDays=7, < stalledMinDays=8 — boundary
	// case where idleDays=7 is fresh; idleDays=8 is stalled).
	{
		const notes = [
			note('projects/iota/project.md', 7, 'active'), // exactly 7d
			note('projects/kappa/project.md', 8, 'active'), // exactly 8d
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('7d → fresh (Slot A)', r.slotA?.folder === 'iota');
		check('8d → stalled (Slot B)', r.slotB?.folder === 'kappa');
	}

	// Case 8: multiple fresh — pick freshest by max mtime.
	{
		const notes = [
			note('projects/lambda/project.md', 3, 'active'),
			note('projects/mu/project.md', 0, 'active'), // freshest
			note('projects/nu/project.md', 5, 'active'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('freshest of 3 picked for Slot A', r.slotA?.folder === 'mu');
	}

	// Case 9: multiple stalled — pick oldest.
	{
		const notes = [
			note('projects/xi/project.md', 10, 'active'),
			note('projects/omicron/project.md', 25, 'active'), // oldest
			note('projects/pi/project.md', 15, 'active'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('oldest of 3 stalled picked for Slot B', r.slotB?.folder === 'omicron');
	}

	// Case 10: max mtime across files in folder used.
	{
		const notes = [
			note('projects/rho/project.md', 20, 'active'),
			note('projects/rho/decisions/some-adr.md', 1, 'paused'), // recent file in same folder, status irrelevant for non-project.md
			note('projects/rho/notes/scratch.md', 12, 'paused'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		// max mtime = 1d → Slot A
		check('max mtime across folder used (recent decision file pulls project to fresh)', r.slotA?.folder === 'rho');
		check('  idleDays = 1 (freshest file in folder)', r.slotA?.idleDays === 1);
	}

	// Case 11: candidatesActive count matches all active aggregates regardless of slot eligibility.
	{
		const notes = [
			note('projects/a1/project.md', 0, 'active'),
			note('projects/a2/project.md', 100, 'active'), // too old for either slot
			note('projects/a3/project.md', 12, 'active'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('candidatesActive counts all active', r.candidatesActive === 3, `got ${r.candidatesActive}`);
		check('Slot A picked (a1)', r.slotA?.folder === 'a1');
		check('Slot B picked (a3, in 8-30d range)', r.slotB?.folder === 'a3');
	}

	// Case 12: ignore non-projects/ paths.
	{
		const notes = [
			note('inbox/2026-05-04-something.md', 0, 'active'),
			note('knowledge/cooking/recipe.md', 1, 'active'),
		];
		const r = pickSlots(notes, NOW, 7, 8, 30);
		check('non-projects paths ignored', r.candidatesActive === 0);
	}

	// Case 13: same project would not land in both slots (defensive — shouldn't happen with disjoint thresholds).
	{
		// Force-construct with overlapping window: freshDays=10, stalledMin=5.
		// Project at 7d falls in BOTH ranges. Slot B should be null since
		// it's already Slot A.
		const notes = [note('projects/sigma/project.md', 7, 'active')];
		const r = pickSlots(notes, NOW, 10, 5, 30);
		check('overlap defense: same project not in both slots', r.slotA?.folder === 'sigma' && r.slotB === null);
	}

	console.log(`\n${passed} passed / ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main();
