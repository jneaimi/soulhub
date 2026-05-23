/** Phase 1 + Phase 2 smoke test for the scheduler core.
 *
 *  Run with:  npx tsx scripts/smoke-test-scheduler.ts
 *
 *  Phase 1 checks: register → cron-tick → recordRun → DB write →
 *  runNow → noOverlap → unregister.
 *
 *  Phase 2 checks: stale-row sweep on boot, catchup-on-boot,
 *  settings-driven reconcile (add/remove/update via task-types
 *  registry).
 *
 *  Cleans up after itself. Exits non-zero on any failure.
 */

import {
	register,
	unregister,
	list,
	getTask,
	runNow,
	runHistory,
	lastSuccessfulRun,
	hasActiveRun,
	destroyAllTasks,
	sweepStaleStartedRows,
	registerTaskHandler,
	getTaskHandler,
	_resetTaskHandlersForTests,
	reconcileFromSettings,
	_resetLifecycleForTests,
	catchupTask,
} from '../src/lib/scheduler/index.js';
import { shellScriptFactory } from '../src/lib/scheduler/handlers/shell-script.js';
import { getHeartbeatDb } from '../src/lib/channels/whatsapp/heartbeat-state.js';
import { ConfigSchema } from '../src/lib/config.schema.js';

const TASK_ID = '__smoke_test_scheduler__';
const OVERLAP_TASK_ID = '__smoke_test_overlap__';
const SWEEP_TASK_ID = '__smoke_test_sweep__';
const CATCHUP_TASK_ID = '__smoke_test_catchup__';
const RECONCILE_A = '__smoke_test_reconcile_a__';
const RECONCILE_B = '__smoke_test_reconcile_b__';
const SHELL_TASK_ID = '__smoke_test_shell__';
const SHELL_FAIL_TASK_ID = '__smoke_test_shell_fail__';

const ALL_TEST_TASK_IDS = [
	TASK_ID,
	OVERLAP_TASK_ID,
	SWEEP_TASK_ID,
	CATCHUP_TASK_ID,
	RECONCILE_A,
	RECONCILE_B,
	SHELL_TASK_ID,
	SHELL_FAIL_TASK_ID,
];

/** Wipe scheduler_runs rows for the test task IDs. Crashed prior runs
 *  leave `started` rows that mask hasActiveRun — Phase 2 sweep is the
 *  production fix; here we just reset the test fixture. */
function cleanTestRows(): void {
	const db = getHeartbeatDb();
	const placeholders = ALL_TEST_TASK_IDS.map(() => '?').join(',');
	db.prepare(`DELETE FROM scheduler_runs WHERE task_id IN (${placeholders})`)
		.run(...ALL_TEST_TASK_IDS);
}

function fail(msg: string): never {
	console.error(`[smoke] ✗ FAIL: ${msg}`);
	destroyAllTasks();
	_resetTaskHandlersForTests();
	_resetLifecycleForTests();
	process.exit(1);
}

function ok(msg: string): void {
	console.log(`[smoke] ✓ ${msg}`);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
	console.log('[smoke] starting scheduler smoke test');
	console.log('[smoke] this will take ~25s (waiting for cron ticks)');

	cleanTestRows();
	ok('cleaned stale test rows');

	// 1. Register a fast-firing task.
	let tickCount = 0;
	register({
		id: TASK_ID,
		cron: '*/5 * * * * *', // every 5s (6-field crontab)
		description: 'Smoke test fast tick',
		fn: async () => {
			tickCount += 1;
			return { tickCount, at: new Date().toISOString() };
		},
	});
	ok(`registered ${TASK_ID}`);

	// 2. list() and getTask() should reflect the registration.
	const tasks = list();
	if (!tasks.find((t) => t.id === TASK_ID)) fail('list() missing registered task');
	ok(`list() returns the task — count=${tasks.length}`);

	const info = getTask(TASK_ID);
	if (!info) fail('getTask() returned null');
	if (info.cron !== '*/5 * * * * *') fail(`cron mismatch: ${info.cron}`);
	if (!info.nextRunAt) fail('nextRunAt should be populated for an active cron');
	ok(`getTask().nextRunAt = ${info.nextRunAt}`);

	// 3. Wait ~13s — at least 2 cron ticks.
	console.log('[smoke] waiting 13s for ~2 cron ticks…');
	await sleep(13_000);

	if (tickCount < 2) fail(`expected ≥2 ticks, got ${tickCount}`);
	ok(`callback fired ${tickCount} times`);

	// 4. DB should reflect those ticks.
	const history = runHistory(TASK_ID, 10);
	const successes = history.filter((r) => r.status === 'success');
	if (successes.length < 2) fail(`expected ≥2 success rows, got ${successes.length}`);
	ok(`runHistory has ${history.length} rows (${successes.length} success)`);

	const lastSuccess = lastSuccessfulRun(TASK_ID);
	if (!lastSuccess) fail('lastSuccessfulRun returned null');
	if (lastSuccess.outputSummary === null) fail('outputSummary should be persisted');
	ok(`lastSuccessfulRun: id=${lastSuccess.id}, durationMs=${lastSuccess.durationMs}`);

	// 5. runNow() should fire immediately and succeed.
	const beforeRunNow = tickCount;
	const result = await runNow(TASK_ID);
	if (result.status !== 'success') fail(`runNow status: ${result.status} (error: ${result.error})`);
	if (tickCount !== beforeRunNow + 1) fail('runNow did not increment tickCount');
	ok(`runNow status=success, durationMs=${result.durationMs}`);

	// 6. noOverlap: register a task that takes longer than its cron interval.
	let overlapInflight = false;
	let overlapEntries = 0;
	register({
		id: OVERLAP_TASK_ID,
		cron: '*/2 * * * * *', // every 2s
		noOverlap: true,
		description: 'Smoke test overlap',
		fn: async () => {
			overlapEntries += 1;
			if (overlapInflight) {
				throw new Error('noOverlap violated — fn entered while another in flight');
			}
			overlapInflight = true;
			await sleep(5_000); // longer than cron interval
			overlapInflight = false;
			return { entries: overlapEntries };
		},
	});

	console.log('[smoke] waiting 8s to test noOverlap…');
	await sleep(8_000);

	const overlapHistory = runHistory(OVERLAP_TASK_ID, 20);
	const skipped = overlapHistory.filter((r) => r.status === 'overlap-skipped');
	if (skipped.length === 0) fail('expected ≥1 overlap-skipped row');
	if (overlapEntries > 2) fail(`fn entered too many times: ${overlapEntries}`);
	ok(`noOverlap working: ${skipped.length} skipped, ${overlapEntries} entries`);

	// 7. Unregister overlap task and wait for the in-flight fn to drain
	//    before asserting hasActiveRun is clear.
	if (!unregister(OVERLAP_TASK_ID)) fail('unregister overlap returned false');
	console.log('[smoke] waiting up to 6s for in-flight overlap run to drain…');
	for (let i = 0; i < 12; i += 1) {
		if (!hasActiveRun(OVERLAP_TASK_ID)) break;
		await sleep(500);
	}
	if (hasActiveRun(OVERLAP_TASK_ID)) fail('hasActiveRun stayed true after fn finished');
	ok('hasActiveRun=false after fn drains');

	// 8. Unregister the fast task and confirm getTask returns null.
	if (!unregister(TASK_ID)) fail('unregister returned false');
	if (getTask(TASK_ID) !== null) fail('getTask should be null after unregister');
	ok('unregister works');

	// 9. Verify nothing keeps firing after unregister.
	const tickAfterUnregister = tickCount;
	console.log('[smoke] waiting 7s post-unregister to verify silence…');
	await sleep(7_000);
	if (tickCount !== tickAfterUnregister) fail('task fired after unregister');
	ok('no ticks after unregister');

	cleanTestRows();
	ok('cleaned test rows post-run (phase 1)');

	// ─── Phase 2 checks ──────────────────────────────────────────────

	console.log('\n[smoke] phase 2: stale-sweep + catchup + reconcile');

	// 10. Stale-row sweep: insert a synthetic started row from the past
	//     and verify sweep closes it.
	{
		const db = getHeartbeatDb();
		const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
		db.prepare(
			`INSERT INTO scheduler_runs (task_id, scheduled_for, started_at, status)
			 VALUES (?, ?, ?, 'started')`,
		).run(SWEEP_TASK_ID, oldIso, oldIso);

		const sweep = sweepStaleStartedRows(30 * 60 * 1000); // 30 min cutoff
		if (sweep.swept < 1) fail(`sweep should have closed ≥1 row, got ${sweep.swept}`);

		const rows = db
			.prepare(`SELECT status, error_message FROM scheduler_runs WHERE task_id = ?`)
			.all(SWEEP_TASK_ID) as { status: string; error_message: string | null }[];
		if (rows[0]?.status !== 'error') fail(`stale row should be 'error', got '${rows[0]?.status}'`);
		if (!rows[0]?.error_message?.includes('process-crashed')) {
			fail(`error_message missing process-crashed: ${rows[0]?.error_message}`);
		}
		ok(`sweep closed ${sweep.swept} stale row(s) as error: process-crashed`);
	}

	// 11. Catchup: insert an old success that's older than the previous
	//     scheduled fire, register the task, run catchupTask, verify it
	//     fires.
	{
		const db = getHeartbeatDb();
		// Cron `*/1 * * * *` fires every minute; previous fire is at most
		// 60s ago. Insert a success older than that — should trigger
		// catchup.
		const oldIso = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min ago
		db.prepare(
			`INSERT INTO scheduler_runs
				(task_id, scheduled_for, started_at, finished_at, status, duration_ms)
			 VALUES (?, ?, ?, ?, 'success', 1)`,
		).run(CATCHUP_TASK_ID, oldIso, oldIso, oldIso);

		let catchupFired = 0;
		register({
			id: CATCHUP_TASK_ID,
			cron: '*/1 * * * *', // every minute
			description: 'Smoke catchup',
			fn: async () => {
				catchupFired += 1;
				return { fired: true };
			},
		});

		const info = getTask(CATCHUP_TASK_ID);
		if (!info) fail('catchup task missing from registry');
		const outcome = await catchupTask(info);
		if (!outcome.fired) fail(`catchup should fire, got reason: ${outcome.reason}`);
		if (catchupFired !== 1) fail(`catchup fn should run once, ran ${catchupFired}x`);

		// Run again — last success is now fresh, should NOT fire.
		const outcome2 = await catchupTask(info);
		if (outcome2.fired) fail('catchup should not re-fire after success is fresh');
		if (outcome2.reason !== 'caught-up') {
			fail(`expected reason 'caught-up', got '${outcome2.reason}'`);
		}

		unregister(CATCHUP_TASK_ID);
		ok(`catchup fires once when behind, no-ops when fresh (reason=${outcome2.reason})`);
	}

	// 12. Settings-driven reconcile: register two task handlers, build a
	//     synthetic snapshot, verify reconcile creates them; mutate the
	//     snapshot, verify update + removal.
	{
		_resetTaskHandlersForTests();
		_resetLifecycleForTests();

		let aFired = 0;
		let bFired = 0;
		registerTaskHandler('smoke-noop-a', () => async () => {
			aFired += 1;
		});
		registerTaskHandler('smoke-noop-b', () => async () => {
			bFired += 1;
		});

		const baseSnapshot = ConfigSchema.parse({}).scheduler;
		const snap1 = {
			...baseSnapshot,
			tasks: [
				{
					id: RECONCILE_A,
					type: 'smoke-noop-a',
					cron: '*/5 * * * * *',
					enabled: true,
					noOverlap: true,
					params: {},
				},
				{
					id: RECONCILE_B,
					type: 'smoke-noop-b',
					cron: '*/10 * * * * *',
					enabled: true,
					noOverlap: true,
					params: {},
				},
			],
		};

		const r1 = reconcileFromSettings(snap1);
		if (r1.registered.length !== 2) fail(`expected 2 registered, got ${r1.registered.length}`);
		if (!getTask(RECONCILE_A) || !getTask(RECONCILE_B)) fail('reconciled tasks not in registry');
		ok(`reconcile add: ${r1.registered.length} registered`);

		// Idempotent: same snapshot → no changes.
		const r2 = reconcileFromSettings(snap1);
		if (r2.registered.length !== 0 || r2.updated.length !== 0) {
			fail(`reconcile should be idempotent, got registered=${r2.registered.length} updated=${r2.updated.length}`);
		}
		if (r2.unchanged.length !== 2) fail(`expected 2 unchanged, got ${r2.unchanged.length}`);
		ok('reconcile idempotent: 2 unchanged on re-apply');

		// Update A's cron, remove B → expect 1 updated, 1 unregistered.
		const snap2 = {
			...snap1,
			tasks: [{ ...snap1.tasks[0], cron: '*/3 * * * * *' }],
		};
		const r3 = reconcileFromSettings(snap2);
		if (r3.updated.length !== 1) fail(`expected 1 updated, got ${r3.updated.length}`);
		if (r3.unregistered.length !== 1) fail(`expected 1 unregistered, got ${r3.unregistered.length}`);
		if (getTask(RECONCILE_B)) fail('reconcile_b should be unregistered');
		const aInfo = getTask(RECONCILE_A);
		if (aInfo?.cron !== '*/3 * * * * *') fail(`reconcile_a cron not updated: ${aInfo?.cron}`);
		ok('reconcile mutate: 1 updated (cron), 1 unregistered');

		// Skip path: snapshot referencing an unknown type.
		const snap3 = {
			...baseSnapshot,
			tasks: [
				{
					id: RECONCILE_A,
					type: 'does-not-exist',
					cron: '*/5 * * * * *',
					enabled: true,
					noOverlap: true,
					params: {},
				},
			],
		};
		const r4 = reconcileFromSettings(snap3);
		if (r4.skipped.length !== 1) fail(`expected 1 skipped, got ${r4.skipped.length}`);
		if (!r4.skipped[0]?.reason.includes('unknown task type')) {
			fail(`skip reason wrong: ${r4.skipped[0]?.reason}`);
		}
		ok('reconcile skip: unknown type marked skipped, not crashed');

		// Disabled scheduler tears everything down.
		const snap4 = { ...baseSnapshot, enabled: false, tasks: [] };
		reconcileFromSettings(snap4);
		if (list().length !== 0) fail('disabled scheduler should leave registry empty');
		ok('reconcile disabled: registry emptied');

		_resetTaskHandlersForTests();
		_resetLifecycleForTests();
	}

	cleanTestRows();
	ok('cleaned test rows post-run (phase 2)');

	// ─── Phase 3 checks (shell-script handler) ───────────────────────

	console.log('\n[smoke] phase 3: shell-script handler');

	// 13. Happy path: echo runs, captures stdout, success.
	{
		const fn = shellScriptFactory({ command: ['echo', 'phase-3-ok'] });
		register({
			id: SHELL_TASK_ID,
			cron: '0 0 1 1 *', // never (Jan 1 00:00) — we drive via runNow
			description: 'shell-script echo',
			fn,
		});
		const result = await runNow(SHELL_TASK_ID);
		if (result.status !== 'success') fail(`shell-script echo failed: ${result.error}`);
		const output = result.output as { stdoutTail?: string; exitCode?: number } | undefined;
		if (!output?.stdoutTail?.includes('phase-3-ok')) {
			fail(`stdoutTail missing marker: ${JSON.stringify(output)}`);
		}
		if (output?.exitCode !== 0) fail(`exitCode should be 0, got ${output?.exitCode}`);
		unregister(SHELL_TASK_ID);
		ok(`shell-script happy path: stdoutTail captured, exitCode=0`);
	}

	// 14. Sad path: false (exit 1) → run lands as error with stderr captured.
	{
		const fn = shellScriptFactory({ command: ['sh', '-c', 'echo to-stderr 1>&2; exit 1'] });
		register({
			id: SHELL_FAIL_TASK_ID,
			cron: '0 0 1 1 *',
			description: 'shell-script failure',
			fn,
		});
		const result = await runNow(SHELL_FAIL_TASK_ID);
		if (result.status !== 'error') fail(`expected error status, got ${result.status}`);
		if (!result.error?.includes('exit 1')) fail(`error msg should mention exit 1: ${result.error}`);
		unregister(SHELL_FAIL_TASK_ID);
		ok(`shell-script sad path: non-zero exit recorded as error`);
	}

	// 15. Handler registry contains 'shell-script' (registered by hooks).
	//     Test-only resets above cleared this — re-register to verify.
	{
		_resetTaskHandlersForTests();
		registerTaskHandler('shell-script', shellScriptFactory);
		const h = getTaskHandler('shell-script');
		if (!h) fail('shell-script handler should be registered');
		ok('shell-script handler registered + retrievable');
		_resetTaskHandlersForTests();
	}

	cleanTestRows();
	ok('cleaned test rows post-run (phase 3)');

	console.log('\n[smoke] ALL CHECKS PASSED');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('[smoke] unhandled error:', err);
		destroyAllTasks();
		process.exit(1);
	});
