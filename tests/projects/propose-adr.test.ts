/**
 * project-phases ADR-005 S1 — pure-helper tests for proposeAdr.
 *
 * The orchestration entry point (`applyProposeAdr`) talks to the live
 * vault engine — that path is verified end-to-end via live integration
 * smoke after pm2 reload (synthetic project + propose + cleanup). This
 * file covers only the pure functions: kebab-slug derivation, ordinal
 * lookup, frontmatter composition, body composition.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/propose-adr.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	deriveAdrSlug,
	nextOrdinalFromNotes,
	composeAdrFrontmatter,
	composeAdrBody,
	stripFalsifierPrefix,
	todayInTimezone,
	type ProposeAdrInput,
} from '../../src/lib/projects/propose-adr.ts';

function fixtureInput(overrides: Partial<ProposeAdrInput> = {}): ProposeAdrInput {
	return {
		slug: 'test-project',
		working_title: 'Cache rendered peer-brief PDFs',
		tier: 'Tier 1',
		problem_statement:
			'Rendering the peer-brief PDF takes ~12s per call. Caching by recipe-hash would drop this to <100ms for repeat requests.',
		decision_sketch: [
			'Compute sha256 of the recipe YAML + transcript JSON',
			'Store rendered PDF bytes keyed by that hash in vault assets',
			'On request, check cache first; render only on miss',
		],
		falsifier_conditions: [
			'Cache hit rate exceeds 60% after 7 days of operator usage',
			'Storage growth stays under 500MB after the first month',
		],
		...overrides,
	};
}

// ─── deriveAdrSlug ────────────────────────────────────────────────────

describe('deriveAdrSlug', () => {
	test('kebab-cases multi-word titles', () => {
		assert.equal(deriveAdrSlug('Cache rendered peer-brief PDFs'), 'cache-rendered-peer-brief-pdfs');
	});

	test('translates `+` to ` and ` (per existing ADR-005 convention)', () => {
		assert.equal(
			deriveAdrSlug('AI propose-ADR + propose-slice asymmetry'),
			'ai-propose-adr-and-propose-slice-asymmetry',
		);
	});

	test('strips non-alphanumeric / collapses dashes', () => {
		assert.equal(deriveAdrSlug('Title!!! with @#$ chars'), 'title-with-chars');
	});

	test('truncates at 60 chars without leaving trailing dash', () => {
		const long = 'x'.repeat(80);
		const slug = deriveAdrSlug(long);
		assert.ok(slug.length <= 60);
		assert.ok(!slug.endsWith('-'));
	});

	test('lowercases everything', () => {
		assert.equal(deriveAdrSlug('UPPERCASE WORDS'), 'uppercase-words');
	});

	test('handles empty/whitespace gracefully', () => {
		assert.equal(deriveAdrSlug('   '), '');
	});
});

// ─── nextOrdinalFromNotes ─────────────────────────────────────────────

describe('nextOrdinalFromNotes', () => {
	test('returns 001 when no ADRs exist for the project', () => {
		const paths = [
			'projects/test-project/index.md',
			'projects/other-project/adr-001-foo.md', // different project — ignored
		];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '001');
	});

	test('returns 002 when adr-001 exists', () => {
		const paths = ['projects/test-project/adr-001-foo.md', 'projects/test-project/index.md'];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '002');
	});

	test('finds the max ordinal across multiple ADRs (not the count)', () => {
		const paths = [
			'projects/test-project/adr-001-a.md',
			'projects/test-project/adr-003-b.md',
			'projects/test-project/adr-007-c.md', // gap at 002/004/005/006 is fine
		];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '008');
	});

	test('handles 2-digit ordinals (legacy hand-numbering)', () => {
		const paths = ['projects/test-project/adr-12-legacy.md'];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '013');
	});

	test('only considers paths under the matching project prefix', () => {
		const paths = [
			'projects/other/adr-999-foo.md', // sibling project — ignored
			'knowledge/learnings/2026-05-17-adr-005-something.md', // not an ADR path
			'projects/test-project/adr-002-x.md',
		];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '003');
	});

	test('ignores non-adr files in the project folder', () => {
		const paths = [
			'projects/test-project/index.md',
			'projects/test-project/2026-05-17-research.md', // not an ADR
			'projects/test-project/adr-001-a.md',
		];
		assert.equal(nextOrdinalFromNotes(paths, 'test-project'), '002');
	});
});

// ─── composeAdrFrontmatter ─────────────────────────────────────────────

describe('composeAdrFrontmatter', () => {
	test('produces the minimum required fields for the projects zone', () => {
		const fm = composeAdrFrontmatter(fixtureInput(), {
			ordinal: '005',
			created: '2026-05-17',
		});
		assert.equal(fm.type, 'decision');
		assert.equal(fm.status, 'proposed');
		assert.equal(fm.created, '2026-05-17');
		assert.equal(fm.project, 'test-project');
		assert.ok(Array.isArray(fm.tags));
		assert.ok((fm.tags as string[]).includes('decision'));
		assert.ok((fm.tags as string[]).includes('proposed-by-ai'));
		assert.ok((fm.tags as string[]).includes('test-project'));
	});

	test('sets a 90-day default falsifier_date', () => {
		const fm = composeAdrFrontmatter(fixtureInput(), {
			ordinal: '001',
			created: '2026-05-17',
		});
		assert.equal(fm.falsifier_date, '2026-08-15');
	});

	test('inherits parent_project + cluster_tag when supplied', () => {
		const fm = composeAdrFrontmatter(fixtureInput(), {
			ordinal: '001',
			created: '2026-05-17',
			parent_project: '[[../soul-hub/index|soul-hub]]',
			cluster_tag: 'cluster:soul-hub',
		});
		assert.equal(fm.parent_project, '[[../soul-hub/index|soul-hub]]');
		assert.ok((fm.tags as string[]).includes('cluster:soul-hub'));
	});

	test('attaches parent_adrs as relates_to', () => {
		const fm = composeAdrFrontmatter(
			fixtureInput({ parent_adrs: ['[[adr-005-ai-propose-adr]]', '[[adr-046-vault-write-chokepoint]]'] }),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.deepEqual(fm.relates_to, ['[[adr-005-ai-propose-adr]]', '[[adr-046-vault-write-chokepoint]]']);
	});

	test('single parent_adrs collapses to scalar (matches existing vault convention)', () => {
		const fm = composeAdrFrontmatter(
			fixtureInput({ parent_adrs: ['[[adr-046-vault-write-chokepoint]]'] }),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.equal(fm.relates_to, '[[adr-046-vault-write-chokepoint]]');
	});

	test('source_agent defaults to "proposeAdr"; source_context records slug+tier+ordinal', () => {
		const fm = composeAdrFrontmatter(fixtureInput(), {
			ordinal: '003',
			created: '2026-05-17',
		});
		assert.equal(fm.source_agent, 'proposeAdr');
		assert.match(fm.source_context as string, /slug=test-project tier=Tier 1 ordinal=003/);
	});

	test('explicit source_agent overrides the default', () => {
		const fm = composeAdrFrontmatter(
			fixtureInput({ source_agent: 'claude-opus' }),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.equal(fm.source_agent, 'claude-opus');
	});
});

// ─── composeAdrBody ────────────────────────────────────────────────────

describe('composeAdrBody', () => {
	test('produces a markdown body with all required sections', () => {
		const body = composeAdrBody(fixtureInput(), { ordinal: '005', created: '2026-05-17' });
		assert.match(body, /^# ADR-005 — Cache rendered peer-brief PDFs/m);
		assert.match(body, /^## Status/m);
		assert.match(body, /^## Context/m);
		assert.match(body, /^## Decision \(sketch\)/m);
		assert.match(body, /^## Falsifiers/m);
		assert.match(body, /^## Implementation plan/m);
		assert.match(body, /^## Related/m);
	});

	test('Status line carries PROPOSED + tier + AdrDrawer hint', () => {
		const body = composeAdrBody(fixtureInput({ tier: 'Tier 2' }), {
			ordinal: '005',
			created: '2026-05-17',
		});
		assert.match(body, /PROPOSED 2026-05-17/);
		assert.match(body, /Tier: \*\*Tier 2\*\*/);
		assert.match(body, /Accept \/ Reject \/ Park buttons/);
	});

	test('Context section includes the problem_statement verbatim', () => {
		const input = fixtureInput();
		const body = composeAdrBody(input, { ordinal: '001', created: '2026-05-17' });
		assert.ok(body.includes(input.problem_statement));
	});

	test('Decision sketch bullets render as markdown list items', () => {
		const body = composeAdrBody(fixtureInput(), { ordinal: '001', created: '2026-05-17' });
		assert.match(body, /- Compute sha256 of the recipe YAML/);
		assert.match(body, /- Store rendered PDF bytes/);
	});

	test('Falsifiers are numbered F1, F2, ... with the deadline declared', () => {
		const body = composeAdrBody(fixtureInput(), { ordinal: '001', created: '2026-05-17' });
		assert.match(body, /Deadline 2026-08-15/);
		assert.match(body, /\*\*F1\*\* Cache hit rate exceeds 60%/);
		assert.match(body, /\*\*F2\*\* Storage growth stays under 500MB/);
	});

	test('Implementation plan ships as a placeholder table for operator to fill', () => {
		const body = composeAdrBody(fixtureInput(), { ordinal: '001', created: '2026-05-17' });
		assert.match(body, /\| Slice \| Scope \| Estimate \|/);
		assert.match(body, /\| S1 \| \(operator to fill in after acceptance\) \| — \|/);
	});

	test('Related section links the project + parent_adrs', () => {
		const body = composeAdrBody(
			fixtureInput({ parent_adrs: ['[[adr-046-vault-write-chokepoint]]'] }),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.match(body, /\[\[index\|test-project\]\]/);
		assert.match(body, /\[\[adr-046-vault-write-chokepoint\]\]/);
		assert.match(body, /\[\[\.\.\/project-phases\/adr-005-ai-propose-adr-and-propose-slice\|ADR-005\]\]/);
	});
});

// ─── ADR-010 S1 — Falsifier prefix strip (Bug 1) ───────────────────────

describe('stripFalsifierPrefix', () => {
	test('passes clean input through unchanged', () => {
		assert.equal(
			stripFalsifierPrefix('At least one real X event occurs.'),
			'At least one real X event occurs.',
		);
	});

	test('strips `F1 — text` (em-dash, the common bug)', () => {
		assert.equal(
			stripFalsifierPrefix('F1 — At least one real X event occurs.'),
			'At least one real X event occurs.',
		);
	});

	test('strips `F1: text` (colon)', () => {
		assert.equal(stripFalsifierPrefix('F1: text'), 'text');
	});

	test('strips `F1. text` (period)', () => {
		assert.equal(stripFalsifierPrefix('F1. text'), 'text');
	});

	test('strips `F1) text` (close-paren)', () => {
		assert.equal(stripFalsifierPrefix('F1) text'), 'text');
	});

	test('strips `F1 - text` (regular hyphen)', () => {
		assert.equal(stripFalsifierPrefix('F1 - text'), 'text');
	});

	test('strips `**F1** — text` (markdown-emphasised prefix)', () => {
		assert.equal(stripFalsifierPrefix('**F1** — text'), 'text');
	});

	test('handles multi-digit ordinals (F10, F42)', () => {
		assert.equal(stripFalsifierPrefix('F10 — text'), 'text');
		assert.equal(stripFalsifierPrefix('F42: text'), 'text');
	});

	test('does NOT strip mid-text mentions of F<N>', () => {
		// "Requires F1 to close" — F1 is meaningful here, not a prefix
		assert.equal(
			stripFalsifierPrefix('Requires F1 to close before this fires.'),
			'Requires F1 to close before this fires.',
		);
	});

	test('does NOT strip F<N> without a separator', () => {
		// "F1 text" without `—:.-)` would be ambiguous; require a separator
		assert.equal(stripFalsifierPrefix('F1 text without separator'), 'F1 text without separator');
	});
});

describe('composeAdrBody — falsifier-prefix integration (Bug 1 regression)', () => {
	test('clean falsifier_conditions render with single F<N> prefix', () => {
		const body = composeAdrBody(
			fixtureInput({
				falsifier_conditions: [
					'At least one real X event occurs',
					'Zero false-positives in 30 days',
				],
			}),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.match(body, /^- \*\*F1\*\* At least one real X event occurs$/m);
		assert.match(body, /^- \*\*F2\*\* Zero false-positives in 30 days$/m);
		// No double-prefix anywhere
		assert.doesNotMatch(body, /\*\*F\d+\*\* F\d+/);
	});

	test('legacy `F1 — text` input gets stripped, no double-prefix in output', () => {
		const body = composeAdrBody(
			fixtureInput({
				falsifier_conditions: [
					'F1 — legacy-style string with em-dash',
					'F2: legacy colon-style',
					'F3) legacy paren-style',
				],
			}),
			{ ordinal: '001', created: '2026-05-17' },
		);
		assert.match(body, /^- \*\*F1\*\* legacy-style string with em-dash$/m);
		assert.match(body, /^- \*\*F2\*\* legacy colon-style$/m);
		assert.match(body, /^- \*\*F3\*\* legacy paren-style$/m);
		// Critical: no `**F1** F1` anywhere
		assert.doesNotMatch(body, /\*\*F\d+\*\* F\d+/);
	});
});

// ─── ADR-010 S1 — Timezone-aware date rendering (Bug 2) ────────────────

describe('todayInTimezone', () => {
	test('renders the Asia/Dubai date by default', () => {
		// 2026-05-17 20:00 UTC = 2026-05-18 00:00 Dubai (just past midnight)
		const utc = new Date('2026-05-17T20:00:00Z');
		assert.equal(todayInTimezone(utc), '2026-05-18');
	});

	test('uses UTC date for moments still inside the same Dubai day', () => {
		// 2026-05-17 19:30 UTC = 2026-05-17 23:30 Dubai (still Sunday)
		const utc = new Date('2026-05-17T19:30:00Z');
		assert.equal(todayInTimezone(utc), '2026-05-17');
	});

	test('falls back to a different timezone when passed explicitly', () => {
		// 2026-05-17 23:00 UTC — UTC says 17th, Dubai says 18th, NYC says 19:00 EDT = 17th
		const utc = new Date('2026-05-17T23:00:00Z');
		assert.equal(todayInTimezone(utc, 'UTC'), '2026-05-17');
		assert.equal(todayInTimezone(utc, 'Asia/Dubai'), '2026-05-18');
		assert.equal(todayInTimezone(utc, 'America/New_York'), '2026-05-17');
	});

	test('handles midnight UTC correctly', () => {
		const utc = new Date('2026-05-18T00:00:00Z');
		assert.equal(todayInTimezone(utc, 'UTC'), '2026-05-18');
		// 04:00 Dubai
		assert.equal(todayInTimezone(utc, 'Asia/Dubai'), '2026-05-18');
	});
});
