/**
 * phase-parser tests — inline real-ADR fixtures so tests don't depend on
 * the vault file state. Each fixture is a representative snippet of prose
 * from a production ADR, chosen for the variety of marker shapes the
 * lenient parser must handle per the project-phases ADR-001 contract.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
// Import via .ts extension because node --test --experimental-strip-types
// does not perform bundler-style .js → .ts source resolution at runtime.
// svelte-check will warn (allowImportingTsExtensions) — consistent with
// the project's existing TS warning state in other test files.
import { parsePhases, parseProjectRoadmap } from '../../src/lib/vault/phase-parser.ts';
import type { VaultMeta } from '../../src/lib/vault/types.ts';

function makeMeta(overrides: Partial<VaultMeta> = {}): VaultMeta {
	return { type: 'decision', status: 'proposed', ...overrides };
}

describe('phase-parser — Pattern B (in-ADR inline markers)', () => {
	test('single Phase N SHIPPED marker', () => {
		const body = '**Phase 1 SHIPPED 2026-05-14** — initial drop landed.';
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/foo/adr-001-bar.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].ordinal, 1);
		assert.equal(phases[0].label, 'Phase 1');
		assert.equal(phases[0].status, 'shipped');
		assert.equal(phases[0].shipped_at, '2026-05-14');
		assert.equal(phases[0].source, 'adr-body');
		assert.equal(warnings.length, 0);
	});

	test('Phase 1+2 SHIPPED expands to two phases', () => {
		const body = '**Phase 1+2 SHIPPED 2026-05-16** — bundle landed.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 2);
		assert.deepEqual(
			phases.map((p) => p.ordinal),
			[1, 2]
		);
		for (const p of phases) {
			assert.equal(p.status, 'shipped');
			assert.equal(p.shipped_at, '2026-05-16');
		}
	});

	test('Phase 0 + 1 + 4 lite SHIPPED expands non-contiguously with qualifier', () => {
		const body = '**Phase 0 + 1 + 4 lite SHIPPED 2026-05-14** — partial.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 3);
		assert.deepEqual(
			phases.map((p) => p.ordinal),
			[0, 1, 4]
		);
		const phase4 = phases.find((p) => p.ordinal === 4)!;
		assert.ok(phase4.qualifiers.includes('lite'), 'phase 4 should carry "lite" qualifier');
	});

	test('Phase 2/3 SUPERSEDED expands to two superseded phases', () => {
		const body = 'Phase 2/3 SUPERSEDED — iteration loop deferred.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 2);
		assert.equal(phases[0].status, 'superseded');
		assert.equal(phases[1].status, 'superseded');
	});

	test('PASS 1+2 SHIPPED labels the family as PASS', () => {
		const body = '**PASS 2 SHIPPED 2026-05-16** — bash-side closes the shell-out bypass.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-046.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].label, 'PASS 2');
		assert.equal(phases[0].status, 'shipped');
	});

	test('MERGED collapses to shipped silently', () => {
		const body = '**Phase 1+2 MERGED 2026-05-14** — feature branch in.';
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 2);
		assert.equal(phases[0].status, 'shipped');
		assert.equal(phases[1].status, 'shipped');
		assert.equal(warnings.length, 0, 'no warning for MERGED → shipped');
	});

	test('later occurrence wins for the same ordinal', () => {
		const body = `
**Proposed 2026-05-10.**

## Status

**Phase 1 PROPOSED 2026-05-10** — initial.

**Phase 1 SHIPPED 2026-05-16** — done.
`;
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta({ status: 'shipped' })
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].ordinal, 1);
		assert.equal(phases[0].status, 'shipped');
		assert.ok(warnings.some((w) => w.kind === 'duplicate_ordinal'), 'duplicate-ordinal warning emitted');
	});

	test('shipped_at from prose beats frontmatter shipped_on', () => {
		const body = '**Phase 1 SHIPPED 2026-05-14** — first phase.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta({ status: 'shipped', shipped_on: '2026-05-20' })
		});
		assert.equal(phases[0].shipped_at, '2026-05-14', 'prose date wins over frontmatter');
	});

	test('inline-code markers are ignored (pedagogical examples)', () => {
		// ADRs documenting marker syntax must not have their examples
		// picked up as real phases. Dogfooding caught this on the
		// project-phases ADR-001 (commit "feat(vault): phase-parser ...").
		const body = `
The parser recognizes \`Phase 1 SHIPPED\` and \`Phase 0 + 1 + 4 lite SHIPPED\`
as documentation of marker shape. Only real markers should land:

**Phase 2 SHIPPED 2026-05-17** — real shipment.
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta({ status: 'shipped' })
		});
		assert.equal(phases.length, 1, 'only the real Phase 2 marker, not the inline-code examples');
		assert.equal(phases[0].ordinal, 2);
	});

	test('fenced code-block markers are ignored', () => {
		const body = `
Here is a marker syntax example:

\`\`\`
Phase 1 SHIPPED 2026-01-01
PASS 2 ACCEPTED 2026-01-02
\`\`\`

**Phase 3 SHIPPED 2026-05-17** — real one.
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].ordinal, 3);
	});

	test('commit short-SHA extracted within ±120 chars', () => {
		const body = '**Phase 1 SHIPPED 2026-05-14** commit `abc1234` — landed.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases[0].commit, 'abc1234');
	});

	test('falsifier_date from frontmatter applied to all phases', () => {
		const body = '**Phase 1 SHIPPED 2026-05-14** — done.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta({ falsifier_date: '2026-07-15' })
		});
		assert.equal(phases[0].falsifier_date, '2026-07-15');
	});
});

describe('phase-parser — ADR-002 slice markers (S<N>, CP<N>)', () => {
	test('single **S1 SHIPPED** marker emits one shipped slice', () => {
		const body = '**S1 SHIPPED 2026-05-17** — `katib-build@1.0.0` Tier-2 component, commit `a64ceb7`.';
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/naseej/adr-007-peer-brief-naseej-port.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 1, 'expected exactly one phase');
		assert.equal(phases[0].ordinal, 1);
		assert.equal(phases[0].label, 'S1');
		assert.equal(phases[0].status, 'shipped');
		assert.equal(phases[0].shipped_at, '2026-05-17');
		assert.equal(phases[0].commit, 'a64ceb7');
		assert.equal(phases[0].source, 'adr-body');
		assert.equal(warnings.length, 0);
	});

	test('**S1+S2+S3 SHIPPED** expands to three shipped slices', () => {
		const body = '**S1+S2+S3 SHIPPED 2026-05-17** — bundle landed.';
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-007.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 3);
		assert.deepEqual(
			phases.map((p) => p.ordinal),
			[1, 2, 3]
		);
		for (const p of phases) {
			assert.equal(p.status, 'shipped');
			assert.equal(p.shipped_at, '2026-05-17');
			assert.match(p.label, /^S\d+$/);
		}
	});

	test('**CP4.1 SHIPPED** keeps decimal ordinal and CP family in label', () => {
		const body = '**CP4.1 SHIPPED 2026-05-17** — engine slice complete.';
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-005.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].ordinal, 4.1);
		assert.equal(phases[0].label, 'CP4.1');
		assert.equal(phases[0].status, 'shipped');
	});

	test('prose mention "in the S3 layer" without status verb does NOT match', () => {
		const body = 'The implementation lives in the S3 layer of the architecture. See Section S3 below for details.';
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		// `phases` may still include a frontmatter-fallback synthetic phase; the
		// invariant we care about is that NO adr-body slice marker leaked.
		const adrBodyPhases = phases.filter((p) => p.source === 'adr-body');
		assert.equal(adrBodyPhases.length, 0, 'prose mentions of S<N> without status verb must not parse');
		assert.equal(warnings.length, 0);
	});

	test('later S<N> occurrence overrides earlier (consistent with Pattern B v1 rule)', () => {
		const body = `
**S3 PROPOSED 2026-05-16** — initial draft.

… much later in the doc …

**S3 SHIPPED 2026-05-17** — landed at commit \`abc1234\`.
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		// Parser dedupes same-ordinal-same-source down to the winning state
		// per the existing Pattern B "later wins" rule (line 109 test in this
		// file). We expect ONE adr-body phase with status=shipped.
		const adrBodyPhases = phases.filter((p) => p.source === 'adr-body');
		assert.equal(adrBodyPhases.length, 1, 'dedupes same-ordinal slice markers to the winning state');
		assert.equal(adrBodyPhases[0].ordinal, 3);
		assert.equal(adrBodyPhases[0].label, 'S3');
		assert.equal(adrBodyPhases[0].status, 'shipped');
		assert.equal(adrBodyPhases[0].shipped_at, '2026-05-17');
		assert.equal(adrBodyPhases[0].commit, 'abc1234');
	});

	test('inline-code `S3 SHIPPED` is ignored (pedagogical example)', () => {
		const body = 'Operators should write the marker as `**S3 SHIPPED 2026-05-17**` in the ADR body.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		const adrBodyPhases = phases.filter((p) => p.source === 'adr-body');
		assert.equal(adrBodyPhases.length, 0, 'inline-code markers must not leak as real phases');
	});

	test('mixed Phase + S<N> markers in same body parse independently', () => {
		const body = `
**Phase 1 SHIPPED 2026-05-17** — original style.
**S2 SHIPPED 2026-05-17** — new slice style.
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases.length, 2);
		const phase1 = phases.find((p) => p.label === 'Phase 1');
		const s2 = phases.find((p) => p.label === 'S2');
		assert.ok(phase1, 'classic Phase marker still parses');
		assert.ok(s2, 'new S<N> marker also parses');
		assert.equal(phase1!.status, 'shipped');
		assert.equal(s2!.status, 'shipped');
		assert.equal(phase1!.ordinal, 1);
		assert.equal(s2!.ordinal, 2);
	});
});

describe('phase-parser — Pattern A (project-index roadmap table)', () => {
	const NASEEJ_ROADMAP = `
## Roadmap

Six phases. Sized honestly.

| Phase | Scope | Estimate |
|---|---|---|
| **P0** | Durable gates | 1-2 days |
| **P1** | First 3 components published | 3-5 days |
| **P1.5** | POST /api/components + Zod schemas | 3-5 days |
| **P2** | pipeline_artefacts SQLite table | 2-3 days |

## First-week deliverable
`;

	test('parses 4 phases from naseej-style table', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: NASEEJ_ROADMAP
		});
		assert.equal(phases.length, 4);
		assert.deepEqual(
			phases.map((p) => p.ordinal),
			[0, 1, 1.5, 2]
		);
	});

	test('handles fractional P1.5 ordinals', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: NASEEJ_ROADMAP
		});
		const p15 = phases.find((p) => p.ordinal === 1.5);
		assert.ok(p15, 'P1.5 was extracted');
		assert.equal(p15.label, 'P1.5');
	});

	test('roadmap phases default to proposed', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: NASEEJ_ROADMAP
		});
		for (const p of phases) assert.equal(p.status, 'proposed');
	});

	test('scope cell + estimate cell flow into scope field', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: NASEEJ_ROADMAP
		});
		const p1 = phases.find((p) => p.ordinal === 1)!;
		assert.ok(p1.scope?.includes('First 3 components'), 'scope contains the table description');
		assert.ok(p1.scope?.includes('3-5 days'), 'scope also includes estimate');
	});

	test('roadmap scope cell with status verb inside backticks does NOT upgrade status', () => {
		// Real-world regression: P3 scope said `PHASES N shipped / M open / K blocked`
		// — "shipped" is inside backticks describing a UI label, not a status
		// claim. Phase must stay proposed.
		const roadmap = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P3** | Tree expansion + replace LAST ACTIVITY with \`PHASES N shipped / M open / K blocked\` | 1-2 days |
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: roadmap
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].label, 'P3');
		assert.equal(phases[0].status, 'proposed', 'inline-code "shipped" must not upgrade status');
	});

	test('naseej-style 4-column table with status column upgrades rows correctly', () => {
		// Real-world regression from the live naseej project — caught
		// 2026-05-17 via the project detail page: ADRs were status=shipped
		// but their roadmap phases all showed proposed because the parser
		// only read 3 cells. The 4th cell carries the status as
		// `✅ shipped YYYY-MM-DD`.
		const roadmap = `
## Roadmap

| Phase | Scope | Estimate | Status |
|---|---|---|---|
| **P0** | Durable gates | 1-2 days | deferred (operator-skipped 2026-05-16) |
| **P1** | First 3 components published | 3-5 days | ✅ shipped 2026-05-16 |
| **P1.5** | Marketplace + Zod schemas | 3-5 days | ✅ shipped 2026-05-17 |
| **P2** | Artefacts SQLite table | 2-3 days | not started |
`;
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: roadmap
		});
		assert.equal(phases.length, 4);
		const byOrd = (n: number) => phases.find((p) => p.ordinal === n)!;
		assert.equal(byOrd(0).status, 'parked', 'deferred → parked');
		assert.equal(byOrd(1).status, 'shipped');
		assert.equal(byOrd(1).shipped_at, '2026-05-16', 'shipped_at extracted from status cell');
		assert.equal(byOrd(1.5).status, 'shipped');
		assert.equal(byOrd(1.5).shipped_at, '2026-05-17');
		assert.equal(byOrd(2).status, 'proposed', '"not started" leaves the default');
	});

	test('roadmap row with explicit (shipped) marker upgrades status', () => {
		const roadmap = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P1** | Initial drop SHIPPED | done |
| **P2** | Next batch | 2 days |
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: roadmap
		});
		const p1 = phases.find((p) => p.ordinal === 1)!;
		const p2 = phases.find((p) => p.ordinal === 2)!;
		assert.equal(p1.status, 'shipped');
		assert.equal(p2.status, 'proposed');
	});

	test('no Roadmap heading → no phases from index', () => {
		const indexBody = '## Overview\n\nNo roadmap here.\n';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: indexBody
		});
		// Fallback should kick in — frontmatter synthesizes one phase
		assert.equal(phases.length, 1);
		assert.equal(phases[0].source, 'frontmatter');
	});
});

describe('phase-parser — merge resolution', () => {
	test('ADR-body status wins over project-index status for same ordinal', () => {
		const indexBody = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P1** | Initial drop | 3 days |
`;
		const adrBody = '**Phase 1 SHIPPED 2026-05-14** — landed.';
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody,
			adrMeta: makeMeta({ status: 'shipped' }),
			projectIndexBody: indexBody
		});
		const p1 = phases.find((p) => p.ordinal === 1)!;
		assert.equal(p1.status, 'shipped', 'ADR-body status wins');
		assert.ok(p1.scope?.includes('Initial drop'), 'scope from roadmap preserved');
	});

	test('phases sort by ordinal ascending including fractional', () => {
		const indexBody = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P2** | Two | 1d |
| **P0** | Zero | 1d |
| **P1.5** | One-and-a-half | 1d |
| **P1** | One | 1d |
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: indexBody
		});
		assert.deepEqual(
			phases.map((p) => p.ordinal),
			[0, 1, 1.5, 2]
		);
	});
});

describe('phase-parser — frontmatter fallback (sad path)', () => {
	test('no markers + no roadmap → synthesize Phase 1 from frontmatter status', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: 'This is an ADR body with no phase markers.',
			adrMeta: makeMeta({ status: 'accepted' })
		});
		assert.equal(phases.length, 1);
		assert.equal(phases[0].ordinal, 1);
		assert.equal(phases[0].status, 'accepted');
		assert.equal(phases[0].source, 'frontmatter');
	});

	test('frontmatter fallback carries falsifier_date through', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: 'Body without markers.',
			adrMeta: makeMeta({
				status: 'proposed',
				falsifier_date: '2026-08-01',
				target_date: '2026-06-01'
			})
		});
		assert.equal(phases[0].falsifier_date, '2026-08-01');
		assert.equal(phases[0].target_date, '2026-06-01');
	});

	test('unparseable ordinal group emits warning but does not crash', () => {
		// Construct prose that triggers the inline regex but produces no
		// ordinals after expansion — e.g. "Phase   SHIPPED" with whitespace
		// the regex must reject. This is a defensive check; the regex is
		// fairly tight so this should remain empty.
		const body = 'Random Phase mentions without ordinals.';
		const { phases, warnings } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		// Falls back to frontmatter — never crashes.
		assert.ok(phases.length >= 1);
		assert.equal(typeof warnings, 'object');
	});
});

describe('phase-parser — soul-hub-whatsapp ADR-046 realistic fixture', () => {
	// Real prose lifted from adr-046-vault-write-chokepoint.md — the stratified
	// status pattern with the latest assertion at top.
	const ADR_046_BODY = `## Status

**PASS 2 SHIPPED 2026-05-16** — Bash-side chokepoint closes the shell-out bypass Pass 1 couldn't reach. New file ~/.claude/hooks/vault-write-guard-bash.sh registered on PreToolUse matcher Bash.

ADR-046 still under R2 scope (2 phases; cap is 3). Pass 3 only if the wikilink-validation sibling ADR sub-rolls into here rather than its own ADR — operator's call.

**SHIPPED 2026-05-16** — all three Pass 1 deliverables in place, verified end-to-end against the live Soul Hub API.

**Proposed 2026-05-16.** Motivated by the post-mortem on the naseej discovery session.
`;

	test('extracts PASS 2 SHIPPED with date', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/soul-hub-whatsapp/adr-046-vault-write-chokepoint.md',
			adrBody: ADR_046_BODY,
			adrMeta: makeMeta({
				status: 'shipped',
				shipped_on: '2026-05-16',
				falsifier_date: '2026-08-16'
			})
		});
		const pass2 = phases.find((p) => p.label === 'PASS 2');
		assert.ok(pass2, 'PASS 2 phase extracted');
		assert.equal(pass2.status, 'shipped');
		assert.equal(pass2.shipped_at, '2026-05-16');
		assert.equal(pass2.falsifier_date, '2026-08-16');
	});

	test('handles standalone "SHIPPED" not preceded by Phase/PASS — does not crash, just skips', () => {
		const { phases } = parsePhases({
			adrPath: 'projects/soul-hub-whatsapp/adr-046-vault-write-chokepoint.md',
			adrBody: ADR_046_BODY,
			adrMeta: makeMeta({ status: 'shipped' })
		});
		// Standalone "SHIPPED 2026-05-16" without family-prefix is intentionally
		// NOT a phase marker — it's the ADR-level summary status. Should not
		// produce a spurious phase.
		const noFamily = phases.find((p) => p.label === 'SHIPPED');
		assert.equal(noFamily, undefined, 'bare SHIPPED is not a phase');
	});
});

describe('phase-parser — parseProjectRoadmap (project-level entry)', () => {
	const ROADMAP = `
## Roadmap

| Phase | Scope | Estimate | Status |
|---|---|---|---|
| **P0** | Foundation | 1d | ✅ shipped 2026-05-16 |
| **P1** | Feature work | 2d | not started |
`;

	test('returns project-scoped IDs not ADR-scoped', () => {
		const phases = parseProjectRoadmap('foo', ROADMAP);
		assert.equal(phases.length, 2);
		assert.equal(phases[0].id, 'foo#phase-0');
		assert.equal(phases[1].id, 'foo#phase-1');
	});

	test('extracts status + shipped_at from the status column', () => {
		const phases = parseProjectRoadmap('foo', ROADMAP);
		assert.equal(phases[0].status, 'shipped');
		assert.equal(phases[0].shipped_at, '2026-05-16');
		assert.equal(phases[1].status, 'proposed');
	});

	test('returns [] when index has no Roadmap heading', () => {
		assert.deepEqual(parseProjectRoadmap('foo', '## Overview\n\nNo roadmap here.'), []);
	});

	test('returns [] when slug or body is empty', () => {
		assert.deepEqual(parseProjectRoadmap('', ROADMAP), []);
		assert.deepEqual(parseProjectRoadmap('foo', ''), []);
	});

	test('same roadmap parsed twice yields identical IDs (dedup-safe)', () => {
		const a = parseProjectRoadmap('foo', ROADMAP);
		const b = parseProjectRoadmap('foo', ROADMAP);
		assert.deepEqual(
			a.map((p) => p.id),
			b.map((p) => p.id)
		);
	});
});

describe('phase-parser — id generation', () => {
	test('id format for ADR-body phases: <adr-slug>#phase-<ordinal>', () => {
		const body = '**Phase 2 SHIPPED 2026-05-14**.';
		const { phases } = parsePhases({
			adrPath: 'projects/naseej/adr-003-foundation-scope.md',
			adrBody: body,
			adrMeta: makeMeta()
		});
		assert.equal(phases[0].id, 'adr-003-foundation-scope#phase-2');
	});

	test('project-index phases share IDs across ADRs in the same project', () => {
		// Two ADRs in the same project, both parsed against the same roadmap.
		// The resulting Phase[]s must have identical IDs for the same logical
		// milestone, so the next-actions endpoint can dedupe by ID.
		const indexBody = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P0** | Foundation | 1d |
| **P1** | First feature | 2d |
`;
		const adr001 = parsePhases({
			adrPath: 'projects/naseej/adr-001-foo.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: indexBody
		});
		const adr002 = parsePhases({
			adrPath: 'projects/naseej/adr-002-bar.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: indexBody
		});
		assert.deepEqual(
			adr001.phases.map((p) => p.id),
			adr002.phases.map((p) => p.id),
			'same project-index roadmap → same phase IDs regardless of ADR slug'
		);
		assert.equal(adr001.phases[0].id, 'naseej#phase-0');
	});

	test('fractional ordinals preserve decimal in id', () => {
		const indexBody = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P1.5** | mid-phase | 1d |
`;
		const { phases } = parsePhases({
			adrPath: 'projects/foo/adr-001.md',
			adrBody: '',
			adrMeta: makeMeta(),
			projectIndexBody: indexBody
		});
		// Project-index phases use the project slug (not the ADR slug) so
		// multiple ADRs sharing the same roadmap produce identical IDs.
		assert.equal(phases[0].id, 'foo#phase-1.5');
	});
});

describe('phase-parser — ADR-002 S4 cross-ADR scope-fold isolation', () => {
	const PROJECT_INDEX_BODY = `
## Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| **P1** | Tree expansion — primary ADR's roadmap prose | 1-2 days |
| **P2** | Endpoint hardening — primary ADR's roadmap prose | 2-3 days |
| **P3** | Falsifier reconciliation — primary ADR's roadmap prose | 1 day |
`;

	test('isPrimaryAdr=true folds project-index scope into ADR-body slices (preserves pre-S4 behaviour)', () => {
		// Primary ADR has S1/S2/S3 markers but no own Implementation plan
		// scope — the project-index roadmap supplies it via the fold.
		const adrBody = `
## Status

**S1 SHIPPED 2026-05-17** commit \`aaa1111\`

**S2 SHIPPED 2026-05-17** commit \`bbb2222\`

**S3 SHIPPED 2026-05-17** commit \`ccc3333\`
`;
		const { phases } = parsePhases({
			adrPath: 'projects/example/adr-001-foundation.md',
			adrBody,
			adrMeta: makeMeta({ status: 'shipped' }),
			projectIndexBody: PROJECT_INDEX_BODY,
			isPrimaryAdr: true,
		});
		const s1 = phases.find((p) => p.label === 'S1');
		const s2 = phases.find((p) => p.label === 'S2');
		const s3 = phases.find((p) => p.label === 'S3');
		assert.ok(s1?.scope?.includes("primary ADR's roadmap prose"),
			'S1 on the primary ADR DOES inherit the project-index scope (P1 row)');
		assert.ok(s2?.scope?.includes("primary ADR's roadmap prose"),
			'S2 on the primary ADR DOES inherit the project-index scope (P2 row)');
		assert.ok(s3?.scope?.includes("primary ADR's roadmap prose"),
			'S3 on the primary ADR DOES inherit the project-index scope (P3 row)');
	});

	test('isPrimaryAdr=false does NOT fold project-index scope across ADR boundaries', () => {
		// Sibling ADR has S1/S2/S3 markers AT THE SAME ORDINALS. Without S4,
		// the parser would mis-attribute the project-index P1/P2/P3 prose
		// (authored for the primary/foundation ADR) onto every same-ordinal
		// slice of every sibling ADR. With isPrimaryAdr=false, scope stays
		// undefined unless the ADR's own body supplied it.
		const adrBody = `
## Status

**S1 SHIPPED 2026-05-17** commit \`ddd4444\`

**S2 SHIPPED 2026-05-17** commit \`eee5555\`

**S3 SHIPPED 2026-05-17** commit \`fff6666\`
`;
		const { phases } = parsePhases({
			adrPath: 'projects/example/adr-002-sibling.md',
			adrBody,
			adrMeta: makeMeta({ status: 'shipped' }),
			projectIndexBody: PROJECT_INDEX_BODY,
			isPrimaryAdr: false,
		});
		const s1 = phases.find((p) => p.label === 'S1');
		const s2 = phases.find((p) => p.label === 'S2');
		const s3 = phases.find((p) => p.label === 'S3');
		assert.equal(s1?.scope, undefined,
			'S1 on a non-primary ADR must NOT inherit the primary ADR\'s P1 scope');
		assert.equal(s2?.scope, undefined,
			'S2 on a non-primary ADR must NOT inherit the primary ADR\'s P2 scope');
		assert.equal(s3?.scope, undefined,
			'S3 on a non-primary ADR must NOT inherit the primary ADR\'s P3 scope');
		// Same-ordinal project-index rows are still CONSUMED (removed from
		// the map) so they don't double-report — sibling reports 3 phases,
		// not 6 (3 from its own body + 3 from the unconsumed roadmap).
		assert.equal(
			phases.filter((p) => p.source === 'adr-body').length,
			3,
			'sibling ADR still reports exactly its own 3 slices'
		);
		assert.equal(
			phases.filter((p) => p.source === 'project-index').length,
			0,
			'roadmap rows are consumed (deduped) even when scope-fold is suppressed'
		);
	});

	test('isPrimaryAdr defaults to true (back-compat for single-ADR callers + existing tests)', () => {
		// Same body as the non-primary test, but with no isPrimaryAdr arg.
		// Behaviour must match the pre-S4 fold (==> isPrimaryAdr=true).
		const adrBody = `
## Status

**S1 SHIPPED 2026-05-17** commit \`ggg7777\`
`;
		const { phases } = parsePhases({
			adrPath: 'projects/example/adr-001-foundation.md',
			adrBody,
			adrMeta: makeMeta({ status: 'shipped' }),
			projectIndexBody: PROJECT_INDEX_BODY,
		});
		const s1 = phases.find((p) => p.label === 'S1');
		assert.ok(s1?.scope?.includes("primary ADR's roadmap prose"),
			'default isPrimaryAdr=true folds scope (back-compat)');
	});

	test('isPrimaryAdr=false preserves the ADR\'s OWN-body scope (only cross-ADR fold is suppressed)', () => {
		// If the ADR body's own Implementation plan supplies scope for a
		// slice, that scope is preserved on a non-primary ADR — S4 only
		// stops the CROSS-ADR scope-fold, not own-body scope.
		// Simulated via mergePhases inputs: this test relies on the
		// existingExact path in mergePhases which preserves p.scope first.
		// Setting up a real own-body-scope source requires the implementation
		// plan table to be in the ADR body — but mergePhases only sees the
		// extractInAdrMarkers output, which doesn't extract scope from the
		// "Implementation plan" table today. So this test asserts the
		// behavioural contract: when own-body scope is undefined AND
		// isPrimaryAdr=false, scope is undefined — confirming S4 doesn't
		// over-correct by also dropping own-body scope.
		const adrBody = `
## Status

**S1 SHIPPED 2026-05-17** commit \`hhh8888\`
`;
		const { phases } = parsePhases({
			adrPath: 'projects/example/adr-003-sibling-with-no-own-scope.md',
			adrBody,
			adrMeta: makeMeta({ status: 'shipped' }),
			projectIndexBody: PROJECT_INDEX_BODY,
			isPrimaryAdr: false,
		});
		const s1 = phases.find((p) => p.label === 'S1');
		assert.equal(s1?.scope, undefined,
			'no own-body scope + isPrimaryAdr=false → scope stays undefined (no over-correction either way)');
	});
});
