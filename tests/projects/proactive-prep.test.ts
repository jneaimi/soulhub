/**
 * projects-graph ADR-019 — proactive prep action-layer tests.
 *
 * Pure-extractor tests with fake in-memory stores and resolver. DB-backed
 * stores are tested indirectly through heartbeat-state integration; this
 * file focuses on guardrail coverage without touching ops.db.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/proactive-prep.test.ts
 *
 * Guardrail coverage (done-criteria from ADR-019):
 *   ✓ opt-in OFF dispatches zero
 *   ✓ opt-in ON with no prep dispatches one  (second-encounter path)
 *   ✓ opt-in ON with existing prep dispatches zero  (dedup)
 *   ✓ first-observation is quiet (snapshot only, no dispatch)
 *   ✓ parked / superseded skipped
 *   ✓ AI-owned tasks skipped (waiting_on_you not eligible for ready_for_you prep)
 *   ✓ agent-selection: research → researcher, doc/report/brief → author, else skip
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	extractProactivePrepDispatches,
	agentForArtifact,
	isAiOwned,
	type PrepSnapshot,
	type PrepSnapshotStore,
	type PrepResolver,
} from '../../src/lib/scheduler/handlers/proactive-prep.ts';
import type { UnblockCandidate } from '../../src/lib/scheduler/handlers/vault-scout-unblock.ts';
import type { VaultNote } from '../../src/lib/vault/types.ts';

// ── Test doubles ─────────────────────────────────────────────────────────────

class FakePrepStore implements PrepSnapshotStore {
	private rows = new Map<string, PrepSnapshot>();

	get(taskPath: string): PrepSnapshot | null {
		return this.rows.get(taskPath) ?? null;
	}

	upsert(row: PrepSnapshot): void {
		this.rows.set(row.task_path, { ...row });
	}

	size(): number {
		return this.rows.size;
	}

	all(): PrepSnapshot[] {
		return [...this.rows.values()];
	}

	/** Seed a "first-observation" row (prep_path=null) as if from a prior run. */
	seedFirstObservation(taskPath: string, recordedAt = NOW - 1000): this {
		this.rows.set(taskPath, { task_path: taskPath, prep_path: null, recorded_at: recordedAt });
		return this;
	}

	/** Seed a "already dispatched" row as if from a prior dispatch. */
	seedDispatched(taskPath: string, dispatchedAt = NOW - 1000): this {
		this.rows.set(taskPath, {
			task_path: taskPath,
			prep_path: 'dispatched:' + String(dispatchedAt),
			recorded_at: dispatchedAt - 1000,
		});
		return this;
	}
}

class FakeResolver implements PrepResolver {
	private optedIn = new Set<string>();
	private notes = new Map<string, VaultNote>();

	addOptedIn(projectFolder: string): this {
		this.optedIn.add(projectFolder);
		return this;
	}

	addNote(note: VaultNote): this {
		this.notes.set(note.path, note);
		return this;
	}

	isProjectOptedIn(projectFolder: string): boolean {
		return this.optedIn.has(projectFolder);
	}

	getNote(path: string): VaultNote | undefined {
		return this.notes.get(path);
	}
}

function mkNote(path: string, meta: Record<string, unknown> = {}): VaultNote {
	return {
		path,
		title: path.split('/').pop()?.replace(/\.md$/i, '') ?? path,
		meta,
		content: '',
		links: [],
		backlinks: [],
		mtime: 0,
		size: 0,
	};
}

function mkCandidate(
	dependentPath: string,
	projectFolder: string,
	overrides: Partial<UnblockCandidate> = {},
): UnblockCandidate {
	const slug = dependentPath.split('/').pop()?.replace(/\.md$/i, '') ?? dependentPath;
	return {
		id: 'unblock-' + slug,
		dependentPath,
		dependentSlug: slug,
		projectFolder,
		blockerPaths: ['projects/' + projectFolder + '/adr-001.md'],
		triggerTrail: [
			{
				blockerPath: 'projects/' + projectFolder + '/adr-001.md',
				prevStatus: 'proposed',
				newStatus: 'shipped',
			},
		],
		blockerShippedOn: '2026-05-28',
		...overrides,
	};
}

const NOW = Date.UTC(2026, 4, 28, 12, 0, 0); // 2026-05-28

// ── agentForArtifact ──────────────────────────────────────────────────────────

describe('agentForArtifact', () => {
	test('work_type: research → researcher', () => {
		assert.equal(agentForArtifact({ work_type: 'research' }), 'researcher');
	});

	test('work_type: writing → author', () => {
		assert.equal(agentForArtifact({ work_type: 'writing' }), 'author');
	});

	test('work_type: doc → author', () => {
		assert.equal(agentForArtifact({ work_type: 'doc' }), 'author');
	});

	test('work_type: report → author', () => {
		assert.equal(agentForArtifact({ work_type: 'report' }), 'author');
	});

	test('work_type: brief → author', () => {
		assert.equal(agentForArtifact({ work_type: 'brief' }), 'author');
	});

	test('type: research → researcher (fallback)', () => {
		assert.equal(agentForArtifact({ type: 'research' }), 'researcher');
	});

	test('type: doc → author (fallback)', () => {
		assert.equal(agentForArtifact({ type: 'doc' }), 'author');
	});

	test('type: brief → author (fallback)', () => {
		assert.equal(agentForArtifact({ type: 'brief' }), 'author');
	});

	test('type: decision → null (no prep agent for plain ADRs)', () => {
		assert.equal(agentForArtifact({ type: 'decision' }), null);
	});

	test('work_type takes precedence over type', () => {
		// work_type: research beats type: doc
		assert.equal(agentForArtifact({ work_type: 'research', type: 'doc' }), 'researcher');
	});

	test('neither field set → null', () => {
		assert.equal(agentForArtifact({}), null);
	});
});

// ── isAiOwned ─────────────────────────────────────────────────────────────────

describe('isAiOwned', () => {
	test('known agent slugs are AI-owned', () => {
		assert.equal(isAiOwned('researcher'), true);
		assert.equal(isAiOwned('author'), true);
		assert.equal(isAiOwned('soul-hub-implementer'), true);
		assert.equal(isAiOwned('developer'), true);
	});

	test('human names are not AI-owned', () => {
		assert.equal(isAiOwned('jasem'), false);
		assert.equal(isAiOwned(''), false);
	});

	test('null / undefined / non-string → false', () => {
		assert.equal(isAiOwned(null), false);
		assert.equal(isAiOwned(undefined), false);
		assert.equal(isAiOwned(42), false);
	});

	test('case-insensitive comparison', () => {
		assert.equal(isAiOwned('Researcher'), true);
		assert.equal(isAiOwned('AUTHOR'), true);
	});
});

// ── Guardrail 1: opt-in gate ──────────────────────────────────────────────────

describe('guardrail 1 — opt-in gate', () => {
	test('non-opted-in project produces zero dispatches', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver(); // no projects added to opted-in

		const candidate = mkCandidate('projects/p1/adr-019.md', 'p1');
		resolver.addNote(mkNote('projects/p1/adr-019.md', { type: 'research', status: 'accepted' }));

		const { dispatches, stats } = extractProactivePrepDispatches([candidate], resolver, store, NOW);

		assert.equal(dispatches.length, 0, 'zero dispatches on non-opted-in project');
		assert.equal(stats.skippedNotOptedIn, 1);
		assert.equal(store.size(), 0, 'no snapshot written for non-opted-in project');
	});

	test('opted-in project can produce dispatches', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/adr-019.md', 'p1');
		resolver.addNote(mkNote('projects/p1/adr-019.md', { type: 'research', status: 'accepted' }));

		// First run: first-observation (quiet). Verify snapshot is written.
		const run1 = extractProactivePrepDispatches([candidate], resolver, store, NOW);
		assert.equal(run1.dispatches.length, 0);
		assert.equal(store.size(), 1, 'snapshot row inserted for opted-in project');
	});
});

// ── Guardrail 3: quiet first-observation ─────────────────────────────────────

describe('guardrail 3 — quiet first-observation', () => {
	test('first encounter: snapshot only, no dispatch', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-001.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-001.md', { type: 'research', status: 'accepted' }),
		);

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 0, 'no dispatch on first observation');
		assert.equal(stats.skippedFirstObservation, 1);
		assert.equal(store.size(), 1, 'snapshot row inserted');
		assert.equal(store.get('projects/p1/task-001.md')?.prep_path, null, 'prep_path is null');
	});

	test('second encounter (snapshot row with prep_path=null): DISPATCH fires', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-001.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-001.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-001.md', { type: 'research', status: 'accepted' }),
		);

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 1, 'dispatch fires on second encounter');
		assert.equal(stats.dispatched, 1);
		assert.equal(dispatches[0].taskPath, 'projects/p1/task-001.md');
		assert.equal(dispatches[0].agentId, 'researcher');
	});

	test('second encounter updates snapshot prep_path to non-null', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-001.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-001.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-001.md', { type: 'research', status: 'accepted' }),
		);

		extractProactivePrepDispatches([candidate], resolver, store, NOW);

		const row = store.get('projects/p1/task-001.md');
		assert.ok(row?.prep_path !== null, 'prep_path is set after dispatch');
		assert.ok(row?.prep_path?.startsWith('dispatched:'), 'prep_path has dispatched: prefix');
	});
});

// ── Guardrail 2: dedup (one prep per task) ─────────────────────────────────

describe('guardrail 2 — one prep per task (dedup)', () => {
	test('opt-in ON with existing prep dispatches zero', () => {
		const store = new FakePrepStore().seedDispatched('projects/p1/task-002.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-002.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-002.md', { type: 'research', status: 'accepted' }),
		);

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 0, 'dedup: already dispatched');
		assert.equal(stats.skippedDedup, 1);
	});

	test('two candidates for same task only dispatches once (idempotency)', () => {
		// Pre-seed first-observation so the second call can dispatch
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-003.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-003.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-003.md', { type: 'research', status: 'accepted' }),
		);

		// First call: dispatches once (second-encounter path since we seeded)
		const run1 = extractProactivePrepDispatches([candidate], resolver, store, NOW);
		assert.equal(run1.dispatches.length, 1);

		// Second call: snapshot now has prep_path set → dedup
		const run2 = extractProactivePrepDispatches([candidate], resolver, store, NOW + 1000);
		assert.equal(run2.dispatches.length, 0, 'dedup on re-presentation');
		assert.equal(run2.stats.skippedDedup, 1);
	});
});

// ── Guardrail 4: terminal states ─────────────────────────────────────────────

describe('guardrail 4 — terminal status skip', () => {
	for (const status of ['parked', 'superseded']) {
		test(`status: ${status} → skipped`, () => {
			const store = new FakePrepStore();
			const resolver = new FakeResolver().addOptedIn('p1');

			const candidate = mkCandidate('projects/p1/task-004.md', 'p1');
			resolver.addNote(
				mkNote('projects/p1/task-004.md', { type: 'research', status }),
			);

			const { dispatches, stats } = extractProactivePrepDispatches(
				[candidate],
				resolver,
				store,
				NOW,
			);

			assert.equal(dispatches.length, 0, `${status} task must be skipped`);
			assert.equal(stats.skippedTerminalStatus, 1);
			assert.equal(store.size(), 0, 'no snapshot for terminal task');
		});
	}
});

// ── Guardrail 5: AI-owned (waiting_on_you not eligible) ────────────────────

describe('guardrail 5 — AI-owned tasks (ready_for_ai, not ready_for_you)', () => {
	test('assignee: researcher → skipped (AI-owned)', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-005.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-005.md', {
				type: 'research',
				status: 'accepted',
				assignee: 'researcher',
			}),
		);

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 0, 'AI-owned task must be skipped');
		assert.equal(stats.skippedAiOwned, 1);
	});

	test('assignee: soul-hub-implementer → skipped', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/adr-020.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/adr-020.md', {
				type: 'research',
				status: 'accepted',
				assignee: 'soul-hub-implementer',
			}),
		);

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 0);
		assert.equal(stats.skippedAiOwned, 1);
	});

	test('human assignee → not skipped by AI-owned filter', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-006.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-006.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-006.md', {
				type: 'research',
				status: 'accepted',
				assignee: 'jasem',
			}),
		);

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);
		assert.equal(dispatches.length, 1, 'human-assigned task gets prep dispatch');
	});

	test('unassigned task (no assignee) → not skipped', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-007.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/task-007.md', 'p1');
		resolver.addNote(
			mkNote('projects/p1/task-007.md', { type: 'research', status: 'accepted' }),
		);

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);
		assert.equal(dispatches.length, 1, 'unassigned task gets prep dispatch');
	});
});

// ── Guardrail 6: agent selection ─────────────────────────────────────────────

describe('guardrail 6 — agent selection per task type', () => {
	function runWithType(noteType: string, workType?: string): { dispatches: ReturnType<typeof extractProactivePrepDispatches>['dispatches']; stats: ReturnType<typeof extractProactivePrepDispatches>['stats'] } {
		const store = new FakePrepStore().seedFirstObservation(`projects/p1/task-type-${noteType}.md`);
		const resolver = new FakeResolver().addOptedIn('p1');

		const meta: Record<string, unknown> = { type: noteType, status: 'accepted' };
		if (workType) meta.work_type = workType;

		const candidate = mkCandidate(`projects/p1/task-type-${noteType}.md`, 'p1');
		resolver.addNote(mkNote(`projects/p1/task-type-${noteType}.md`, meta));

		return extractProactivePrepDispatches([candidate], resolver, store, NOW);
	}

	test('type: research → researcher', () => {
		const { dispatches } = runWithType('research');
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].agentId, 'researcher');
	});

	test('type: doc → author', () => {
		const { dispatches } = runWithType('doc');
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].agentId, 'author');
	});

	test('type: report → author', () => {
		const { dispatches } = runWithType('report');
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].agentId, 'author');
	});

	test('type: brief → author', () => {
		const { dispatches } = runWithType('brief');
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].agentId, 'author');
	});

	test('type: decision → skip (no matching agent)', () => {
		const { dispatches, stats } = runWithType('decision');
		assert.equal(dispatches.length, 0, 'plain decision ADRs have no prep agent');
		assert.equal(stats.skippedNoAgent, 1);
	});

	test('type: task → skip (no matching agent)', () => {
		const { dispatches, stats } = runWithType('task');
		assert.equal(dispatches.length, 0);
		assert.equal(stats.skippedNoAgent, 1);
	});

	test('work_type: research overrides type: doc → researcher', () => {
		const { dispatches } = runWithType('doc', 'research');
		assert.equal(dispatches.length, 1);
		assert.equal(dispatches[0].agentId, 'researcher');
	});

	test('no type field → skip', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/no-type.md');
		const resolver = new FakeResolver().addOptedIn('p1');

		const candidate = mkCandidate('projects/p1/no-type.md', 'p1');
		resolver.addNote(mkNote('projects/p1/no-type.md', { status: 'accepted' }));

		const { dispatches, stats } = extractProactivePrepDispatches(
			[candidate],
			resolver,
			store,
			NOW,
		);
		assert.equal(dispatches.length, 0);
		assert.equal(stats.skippedNoAgent, 1);
	});
});

// ── Candidate-trail in DispatchIntent ────────────────────────────────────────

describe('candidate-trail correctness', () => {
	test('trigger trail is passed through to DispatchIntent unchanged', () => {
		const trail = [
			{ blockerPath: 'projects/p1/adr-001.md', prevStatus: 'accepted', newStatus: 'shipped' },
			{ blockerPath: 'projects/p1/adr-002.md', prevStatus: 'proposed', newStatus: 'shipped' },
		];
		const candidate = mkCandidate('projects/p1/task-trail.md', 'p1', { triggerTrail: trail });

		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-trail.md');
		const resolver = new FakeResolver().addOptedIn('p1');
		resolver.addNote(
			mkNote('projects/p1/task-trail.md', { type: 'research', status: 'accepted' }),
		);

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);

		assert.equal(dispatches.length, 1);
		assert.deepStrictEqual(dispatches[0].candidateTrail, trail);
	});

	test('dispatch prompt mentions the task path', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-prompt.md');
		const resolver = new FakeResolver().addOptedIn('p1');
		resolver.addNote(
			mkNote('projects/p1/task-prompt.md', { type: 'research', status: 'accepted' }),
		);
		const candidate = mkCandidate('projects/p1/task-prompt.md', 'p1');

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);

		assert.ok(dispatches[0].prompt.includes('projects/p1/task-prompt'), 'prompt references artifact path');
	});

	test('dispatch prompt contains fire-and-forget instruction (no ask_operator)', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-faf.md');
		const resolver = new FakeResolver().addOptedIn('p1');
		resolver.addNote(
			mkNote('projects/p1/task-faf.md', { type: 'research', status: 'accepted' }),
		);
		const candidate = mkCandidate('projects/p1/task-faf.md', 'p1');

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);

		assert.ok(
			dispatches[0].prompt.toLowerCase().includes('fire-and-forget') ||
			dispatches[0].prompt.toLowerCase().includes('ask_operator'),
			'prompt instructs fire-and-forget behavior',
		);
	});
});

// ── Multi-candidate run ───────────────────────────────────────────────────────

describe('multi-candidate run', () => {
	test('multiple candidates from same opted-in project processed independently', () => {
		const store = new FakePrepStore()
			.seedFirstObservation('projects/p1/task-a.md')
			.seedFirstObservation('projects/p1/task-b.md');

		const resolver = new FakeResolver().addOptedIn('p1');
		resolver
			.addNote(mkNote('projects/p1/task-a.md', { type: 'research', status: 'accepted' }))
			.addNote(mkNote('projects/p1/task-b.md', { type: 'doc', status: 'accepted' }));

		const candidates = [
			mkCandidate('projects/p1/task-a.md', 'p1'),
			mkCandidate('projects/p1/task-b.md', 'p1'),
		];

		const { dispatches } = extractProactivePrepDispatches(candidates, resolver, store, NOW);

		assert.equal(dispatches.length, 2, 'two independent dispatches');
		const agents = dispatches.map((d) => d.agentId).sort();
		assert.deepEqual(agents, ['author', 'researcher']);
	});

	test('mixed opted-in and non-opted-in projects: only opted-in dispatches', () => {
		const store = new FakePrepStore()
			.seedFirstObservation('projects/p1/task-a.md') // opted-in
			.seedFirstObservation('projects/p2/task-b.md'); // NOT opted-in

		const resolver = new FakeResolver().addOptedIn('p1'); // only p1
		resolver
			.addNote(mkNote('projects/p1/task-a.md', { type: 'research', status: 'accepted' }))
			.addNote(mkNote('projects/p2/task-b.md', { type: 'research', status: 'accepted' }));

		const candidates = [
			mkCandidate('projects/p1/task-a.md', 'p1'),
			mkCandidate('projects/p2/task-b.md', 'p2'),
		];

		const { dispatches, stats } = extractProactivePrepDispatches(
			candidates,
			resolver,
			store,
			NOW,
		);

		assert.equal(dispatches.length, 1, 'only opted-in project dispatches');
		assert.equal(dispatches[0].projectFolder, 'p1');
		assert.equal(stats.skippedNotOptedIn, 1);
	});

	test('empty candidates → zero dispatches, zero snapshot rows', () => {
		const store = new FakePrepStore();
		const resolver = new FakeResolver();

		const { dispatches, stats } = extractProactivePrepDispatches([], resolver, store, NOW);

		assert.equal(dispatches.length, 0);
		assert.equal(store.size(), 0);
		assert.equal(stats.candidatesReceived, 0);
	});
});

// ── Dispatch ID stability ─────────────────────────────────────────────────────

describe('dispatch ID', () => {
	test('dispatch ID contains "prep-" prefix', () => {
		const store = new FakePrepStore().seedFirstObservation('projects/p1/task-id.md');
		const resolver = new FakeResolver().addOptedIn('p1');
		resolver.addNote(
			mkNote('projects/p1/task-id.md', { type: 'research', status: 'accepted' }),
		);
		const candidate = mkCandidate('projects/p1/task-id.md', 'p1');

		const { dispatches } = extractProactivePrepDispatches([candidate], resolver, store, NOW);

		assert.ok(dispatches[0].id.startsWith('prep-'), 'ID has prep- prefix');
	});
});
