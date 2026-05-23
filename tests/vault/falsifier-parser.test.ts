/**
 * falsifier-parser tests — inline real-prose fixtures from production ADRs +
 * project indexes plus synthetic edge cases. Per project-phases ADR-004 F1:
 * ≥8 real fixtures + ≥6 synthetic.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseFalsifiers } from '../../src/lib/vault/falsifier-parser.ts';
import type { VaultMeta } from '../../src/lib/vault/types.ts';

function makeMeta(overrides: Partial<VaultMeta> = {}): VaultMeta {
	return { type: 'decision', status: 'proposed', ...overrides };
}

describe('falsifier-parser — Shape A (new `**F<N>**` canonical)', () => {
	test('real fixture: naseej ADR-007 with closed F1 + pending F2-F5', () => {
		// Real prose: definitions in `## Falsifiers`, closure in `## Status`
		// inside a `**Falsifier scorecard after S3**:` block.
		const body = `
## Status

**S3 SHIPPED 2026-05-17** commit \`6e25597\` — peer-brief naseej port

**Falsifier scorecard after S3**:

- ✅ F1 — closed 2026-05-17 (recipe runs end-to-end on demand against 2026-05-15: status=success, 23:29, 971KB PDF, commit \`6e25597\`)
- ⏳ F2 — pending (5/5 clean shadow runs, S4)
- ⏳ F3 — pending (PDF parity criteria, S4)
- ⏳ F4 — pending (legacy archived, S4)
- ⏳ F5 — pending (per-step \`mode\` shipped and exercised, S5)

## Falsifiers

- **F1** Recipe runs end-to-end on demand
- **F2** 5/5 clean shadow runs on consecutive weekdays
- **F3** PDF parity criteria met
- **F4** Legacy archived
- **F5** Per-step mode shipped and exercised
`;
		const { falsifiers, warnings } = parseFalsifiers({
			sourcePath: 'projects/naseej/adr-007-peer-brief-naseej-port.md',
			body,
			meta: makeMeta({ status: 'accepted', falsifier_date: '2026-06-17' }),
			sourceKind: 'adr-body',
		});

		assert.equal(falsifiers.length, 5, 'F1-F5 detected');
		assert.equal(warnings.length, 0, 'no warnings');

		const f1 = falsifiers.find((f) => f.id === 'F1')!;
		assert.equal(f1.shape, 'A');
		assert.equal(f1.status, 'closed');
		assert.equal(f1.closed_at, '2026-05-17');
		assert.equal(f1.commit, '6e25597');
		assert.ok(f1.evidence?.includes('971KB PDF'));
		assert.equal(f1.deadline, '2026-06-17', 'inherits falsifier_date');

		const f2 = falsifiers.find((f) => f.id === 'F2')!;
		assert.equal(f2.status, 'open');
		assert.equal(f2.closed_at, undefined);
	});

	test('real fixture: project-phases ADR-003 with all-open Shape A', () => {
		const body = `
## Falsifiers

- **F1** Endpoint shipped + integration tests
- **F2** At least one AI consumer wired
- **F3** Three operator-driven slice closures
- **F4** Zero detectable drift events
- **F5** Audit log entries show actor: projectShipSlice
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/project-phases/adr-003-atomic-ship-slice-api.md',
			body,
			meta: makeMeta({ falsifier_date: '2026-07-17' }),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 5);
		assert.deepEqual(
			falsifiers.map((f) => f.status),
			['open', 'open', 'open', 'open', 'open'],
		);
		assert.equal(falsifiers[0].ordinal, 1);
		assert.equal(falsifiers[4].ordinal, 5);
	});

	test('real fixture: naseej ADR-006 all-open Shape A', () => {
		const body = `
## Falsifiers

Deadline 2026-06-17 (same window as ADR-005).

- **F1** All 5 existing v1 smoke recipes pass without modification.
- **F2** A new v2 smoke recipe runs end-to-end.
- **F3** A templating typo is blocked at POST /api/recipes
- **F4** shell-exec@1.0.0 BLOCK.md + tests green
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/naseej/adr-006-engine-templating-and-tier-model.md',
			body,
			meta: makeMeta({ status: 'shipped', falsifier_date: '2026-06-17' }),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 4);
		assert.ok(falsifiers[0].description.includes('smoke recipes pass'));
		// No closure markers → all open (status from definition list, not from frontmatter)
		assert.deepEqual(
			falsifiers.map((f) => f.status),
			['open', 'open', 'open', 'open'],
		);
	});

	test('multi-scorecard latest-wins: F2 closed in `after S3` overrides `after S2` pending', () => {
		const body = `
## Status

**S2 SHIPPED 2026-05-15** commit \`aaa1111\`

**Falsifier scorecard after S2**:

- ✅ F1 — closed 2026-05-15 (initial close)
- ⏳ F2 — pending (S3)

**S3 SHIPPED 2026-05-17** commit \`bbb2222\`

**Falsifier scorecard after S3**:

- ✅ F1 — closed 2026-05-15 (initial close)
- ✅ F2 — closed 2026-05-17 (now done)

## Falsifiers

- **F1** Initial close criterion
- **F2** Later close criterion
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		const f2 = falsifiers.find((f) => f.id === 'F2')!;
		assert.equal(f2.status, 'closed', 'latest scorecard wins');
		assert.equal(f2.closed_at, '2026-05-17');
	});

	test('Shape A inside-code fences are ignored (pedagogical example)', () => {
		const body = `
## Falsifiers

- **F1** Real falsifier

\`\`\`markdown
- **F2** This is just documentation, not a real F
\`\`\`
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 1);
		assert.equal(falsifiers[0].id, 'F1');
	});
});

describe('falsifier-parser — Shape D (numbered inline markers)', () => {
	test('real fixture: naseej ADR-005 numbered with inline ✅/⏳', () => {
		const body = `
## Falsifier

By **2026-06-17** (30 days). Status after CP1+CP2+CP3 (all shipped 2026-05-17) in **bold**.

1. **✅ closed CP2 (2026-05-17).** Naseej recipes declare \`agent:\` steps and run end-to-end via the runner.
2. **⏳ open — CP4 target.** At least one production-grade recipe in PM2 cron.
3. **✅ closed CP2 (2026-05-17).** POST /api/recipes rejects unknown agents with agents_exist.status: 'failed'.
4. **✅ closed CP2 (2026-05-17).** agent_runs table shows recipe-dispatched runs.
5. **✅ closed CP3 (2026-05-17).** Cancellation works.
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/naseej/adr-005-orchestrator-v2-agent-dispatch-fold.md',
			body,
			meta: makeMeta({ status: 'shipped', falsifier_date: '2026-06-17' }),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 5);
		assert.equal(falsifiers[0].shape, 'D');
		assert.equal(falsifiers[0].status, 'closed');
		assert.equal(falsifiers[0].closed_at, '2026-05-17');
		assert.equal(falsifiers[1].status, 'open');
		// Ordinals follow list position
		assert.equal(falsifiers[0].ordinal, 1);
		assert.equal(falsifiers[4].ordinal, 5);
	});
});

describe('falsifier-parser — Shape E (named bold-prose IDs)', () => {
	test('real fixture: soul-hub-brain index named falsifiers', () => {
		const body = `
## Falsifiers

- **Smart router**: if 30 days of logs show <70 % accuracy or <40 % regex hit-rate, redesign or roll back.
- **Multimodal captions**: if "find that thing" queries fail more than 20 % of the time after 30 days, build Slice 3.
- **Heartbeat usefulness**: if user mutes more often than not over 30 days, tune the prompt or kill schedules.
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/soul-hub-brain/index.md',
			body,
			meta: { type: 'index' } as VaultMeta,
			sourceKind: 'project-index',
		});
		assert.equal(falsifiers.length, 3);
		assert.equal(falsifiers[0].shape, 'E');
		assert.equal(falsifiers[0].id, 'smart-router', 'slugified bold name');
		assert.equal(falsifiers[1].id, 'multimodal-captions');
		assert.equal(falsifiers[2].id, 'heartbeat-usefulness');
		// Project-index falsifiers default open (no frontmatter status mapping)
		assert.equal(falsifiers[0].status, 'open');
		assert.equal(falsifiers[0].source_kind, 'project-index');
	});
});

describe('falsifier-parser — Shape C (legacy prose list, no IDs)', () => {
	test('real fixture: soul-hub-whatsapp ADR-046 prose with bullet conditions', () => {
		const body = `
## Falsifier

By **2026-08-16** (~3 months), at least one of the following must be true:

- A second AI session has written ≥3 notes to the vault and the audit log shows ALL of them came through the API path.
- An attempted direct-write was blocked by the hook AND the agent successfully retried via the skill.

If by 2026-08-16 neither holds — either no AI session has touched the vault, or agents are circumventing the hook — the design has failed.
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/soul-hub-whatsapp/adr-046-vault-write-chokepoint.md',
			body,
			meta: makeMeta({ status: 'shipped', falsifier_date: '2026-08-16' }),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 2, 'one per bullet');
		assert.equal(falsifiers[0].shape, 'C');
		// status: shipped → all derived as closed (legacy ADR is shipped → criteria met)
		assert.equal(falsifiers[0].status, 'closed');
		assert.equal(falsifiers[0].deadline, '2026-08-16');
		assert.ok(falsifiers[0].description.includes('audit log shows'));
	});
});

describe('falsifier-parser — Shape F (pure prose, no list at all)', () => {
	test('real fixture: scad-engagement index prose-only', () => {
		const body = `
## Falsifier (when to switch to Plan B)

If both contacts decline to put their names on the bracketed draft by Day 7, drop co-authored play. Fall back to: same memo, Jasem's byline, framed as "a sketch from our conversation, share or discard at your discretion."
`;
		const { falsifiers, warnings } = parseFalsifiers({
			sourcePath: 'projects/scad-engagement/index.md',
			body,
			meta: { type: 'index' } as VaultMeta,
			sourceKind: 'project-index',
		});
		assert.equal(falsifiers.length, 1, 'one anonymous F1');
		assert.equal(falsifiers[0].id, 'F1');
		assert.equal(falsifiers[0].shape, 'F');
		assert.equal(falsifiers[0].status, 'open', 'project-index default');
		assert.ok(falsifiers[0].description.length > 100, 'description is the prose');
		assert.equal(warnings.length, 0);
	});
});

describe('falsifier-parser — synthetic edge cases', () => {
	test('no `## Falsifier` section at all → empty + warning', () => {
		const body = `
# Some ADR

## Context

Stuff.

## Decision

Things.
`;
		const { falsifiers, warnings } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 0);
		assert.equal(warnings.length, 1);
		assert.equal(warnings[0].kind, 'no_falsifier_section');
	});

	test('Shape A — overdue (deadline in the past, status still open)', () => {
		const body = `
## Falsifiers

- **F1** Some criterion that is past due
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta({ falsifier_date: '2024-01-01' }), // long past
			sourceKind: 'adr-body',
		});
		// The parser itself doesn't classify as overdue (that's the API's job),
		// but it must preserve the deadline so the API can compare.
		assert.equal(falsifiers[0].deadline, '2024-01-01');
		assert.equal(falsifiers[0].status, 'open');
	});

	test('Shape A — superseded marker (❌)', () => {
		const body = `
## Falsifiers

- **F1** Original criterion

**Falsifier scorecard after S2**:

- ❌ F1 — superseded 2026-05-17 (replaced by ADR-008's stricter criterion)
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers[0].status, 'superseded');
		assert.ok(falsifiers[0].evidence?.includes('replaced by ADR-008'));
	});

	test('mixed shapes — Shape A wins over Shape C if both present', () => {
		// Realistically the operator wouldn't mix, but the parser should be deterministic.
		const body = `
## Falsifiers

- **F1** Shape A definition
- Some plain bullet (Shape C contender)
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		// Shape A detection wins; only F1 emitted (the plain bullet doesn't match Shape A regex)
		assert.equal(falsifiers.length, 1);
		assert.equal(falsifiers[0].shape, 'A');
		assert.equal(falsifiers[0].id, 'F1');
	});

	test('closure-without-definition warning', () => {
		const body = `
## Status

- ✅ F7 — closed 2026-05-17 (no matching definition)

## Falsifiers

- **F1** Only one definition
`;
		const { falsifiers, warnings } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 1);
		const warn = warnings.find((w) => w.kind === 'closure_without_definition');
		assert.ok(warn, 'F7 closure flagged');
		assert.ok(warn!.detail.includes('F7'));
	});

	test('Shape A description preserved without trailing closure markers', () => {
		const body = `
## Falsifiers

- **F1** Endpoint shipped + integration tests covering the four mutations + idempotency.
- **F2** At least one AI consumer wired (orchestrator tool OR Naseej recipe step).
`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.ok(falsifiers[0].description.includes('integration tests'));
		assert.ok(falsifiers[1].description.includes('AI consumer'));
		assert.equal(falsifiers[0].raw_definition.startsWith('- **F1**'), true);
	});
});

describe('falsifier-parser — heading variant coverage', () => {
	test('heading `## Falsifier` (singular) is recognised', () => {
		const body = `## Falsifier\n\n- **F1** test`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 1);
	});

	test('heading `## Falsifier (kill criteria)` is recognised', () => {
		const body = `## Falsifier (kill criteria)\n\n- **F1** test`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 1);
	});

	test('heading `### Falsifier (when to revert)` (h3) is recognised', () => {
		const body = `### Falsifier (when to revert)\n\n- **F1** test`;
		const { falsifiers } = parseFalsifiers({
			sourcePath: 'projects/example/adr-001.md',
			body,
			meta: makeMeta(),
			sourceKind: 'adr-body',
		});
		assert.equal(falsifiers.length, 1);
	});
});
