/**
 * project-phases ADR-005 S3 — pure-helper tests for suggestAdrEdit.
 *
 * The orchestration entry point (`applyProposeAdrEdit`) talks to the
 * live vault engine — that path is verified end-to-end via live
 * integration smoke after pm2 reload. This file covers only the pure
 * functions: deriveProposalSlug, nextProposalFilename,
 * composeProposalFrontmatter, composeProposalBody.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/suggest-adr-edit.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	deriveProposalSlug,
	nextProposalFilename,
	composeProposalFrontmatter,
	composeProposalBody,
	PROPOSAL_SECTIONS,
	type SuggestAdrEditInput,
} from '../../src/lib/projects/suggest-adr-edit.ts';

function fixtureInput(overrides: Partial<SuggestAdrEditInput> = {}): SuggestAdrEditInput {
	return {
		slug: 'test-project',
		adr: 'adr-005',
		section: 'Falsifiers',
		title: 'F6 proposal-zone hygiene',
		rationale:
			'30-day staleness check on the proposals/ subfolder — open proposals that haven\'t been touched in 30 days should be flagged by the keeper.',
		proposed_text:
			'- **F6** No proposal sits in `status: open` for more than 30 days. Stale proposals are flagged by the keeper heartbeat.',
		...overrides,
	};
}

// ─── deriveProposalSlug ────────────────────────────────────────────────

describe('deriveProposalSlug', () => {
	test('kebab-cases multi-word titles', () => {
		assert.equal(
			deriveProposalSlug('F6 proposal-zone hygiene'),
			'f6-proposal-zone-hygiene',
		);
	});

	test('translates `+` to ` and `', () => {
		assert.equal(deriveProposalSlug('A + B asymmetry'), 'a-and-b-asymmetry');
	});

	test('strips non-alphanumeric / collapses dashes', () => {
		assert.equal(
			deriveProposalSlug('Title!!! with @#$ chars'),
			'title-with-chars',
		);
	});

	test('truncates at 40 chars without leaving trailing dash', () => {
		const long = 'x'.repeat(60);
		const slug = deriveProposalSlug(long);
		assert.ok(slug.length <= 40);
		assert.ok(!slug.endsWith('-'));
	});

	test('lowercases everything', () => {
		assert.equal(deriveProposalSlug('UPPERCASE WORDS'), 'uppercase-words');
	});

	test('handles empty/whitespace gracefully', () => {
		assert.equal(deriveProposalSlug('   '), '');
	});
});

// ─── nextProposalFilename ──────────────────────────────────────────────

describe('nextProposalFilename', () => {
	test('returns 01 when no proposals exist for this date', () => {
		const paths = [
			'projects/test-project/index.md',
			'projects/other/proposals/2026-05-17-01-foo.md', // different project — ignored
		];
		assert.equal(
			nextProposalFilename(paths, 'test-project', '2026-05-17', 'my-proposal'),
			'2026-05-17-01-my-proposal.md',
		);
	});

	test('returns 02 when 01 exists for this date', () => {
		const paths = [
			'projects/test-project/proposals/2026-05-17-01-first.md',
		];
		assert.equal(
			nextProposalFilename(paths, 'test-project', '2026-05-17', 'second'),
			'2026-05-17-02-second.md',
		);
	});

	test('finds the max counter across the same date', () => {
		const paths = [
			'projects/test-project/proposals/2026-05-17-01-a.md',
			'projects/test-project/proposals/2026-05-17-03-c.md',
			'projects/test-project/proposals/2026-05-17-07-g.md',
		];
		assert.equal(
			nextProposalFilename(paths, 'test-project', '2026-05-17', 'next'),
			'2026-05-17-08-next.md',
		);
	});

	test('counters scope to date — different date starts at 01', () => {
		const paths = [
			'projects/test-project/proposals/2026-05-17-05-yesterday.md',
		];
		assert.equal(
			nextProposalFilename(paths, 'test-project', '2026-05-18', 'today'),
			'2026-05-18-01-today.md',
		);
	});

	test('ignores paths outside the project proposals/ subfolder', () => {
		const paths = [
			'projects/other/proposals/2026-05-17-99-foo.md',
			'projects/test-project/decisions/some-doc.md',
			'projects/test-project/index.md',
		];
		assert.equal(
			nextProposalFilename(paths, 'test-project', '2026-05-17', 'mine'),
			'2026-05-17-01-mine.md',
		);
	});
});

// ─── composeProposalFrontmatter ────────────────────────────────────────

describe('composeProposalFrontmatter', () => {
	test('produces the required fields', () => {
		const fm = composeProposalFrontmatter(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-ai-propose-adr-and-propose-slice',
		});
		assert.equal(fm.type, 'proposal');
		assert.equal(fm.status, 'open');
		assert.equal(fm.created, '2026-05-17');
		assert.equal(fm.project, 'test-project');
		assert.equal(fm.target_adr, '[[adr-005-ai-propose-adr-and-propose-slice]]');
		assert.equal(fm.proposed_section, 'Falsifiers');
		assert.equal(fm.source_agent, 'suggestAdrEdit');
		assert.ok(Array.isArray(fm.tags));
		assert.ok((fm.tags as string[]).includes('proposal'));
		assert.ok((fm.tags as string[]).includes('proposed-by-ai'));
		assert.ok((fm.tags as string[]).includes('test-project'));
	});

	test('inherits cluster_tag when supplied', () => {
		const fm = composeProposalFrontmatter(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-foo',
			cluster_tag: 'cluster:soul-hub',
		});
		assert.ok((fm.tags as string[]).includes('cluster:soul-hub'));
	});

	test('explicit source_agent overrides the default', () => {
		const fm = composeProposalFrontmatter(
			fixtureInput({ source_agent: 'claude-opus-research' }),
			{ created: '2026-05-17', target_adr_slug: 'adr-005-foo' },
		);
		assert.equal(fm.source_agent, 'claude-opus-research');
	});

	test('source_context records slug+adr+section', () => {
		const fm = composeProposalFrontmatter(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-foo',
		});
		assert.match(
			fm.source_context as string,
			/slug=test-project adr=adr-005-foo section=Falsifiers/,
		);
	});
});

// ─── composeProposalBody ───────────────────────────────────────────────

describe('composeProposalBody', () => {
	test('produces a markdown body with all required sections', () => {
		const body = composeProposalBody(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-ai-propose-adr-and-propose-slice',
		});
		assert.match(body, /^# Proposal — F6 proposal-zone hygiene/m);
		assert.match(body, /^## Target/m);
		assert.match(body, /^## Rationale/m);
		assert.match(body, /^## Proposed text/m);
		assert.match(body, /^## Related/m);
	});

	test('Target section links the ADR with its full slug', () => {
		const body = composeProposalBody(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-ai-propose-adr-and-propose-slice',
		});
		assert.match(
			body,
			/- ADR: \[\[adr-005-ai-propose-adr-and-propose-slice\]\]/,
		);
		assert.match(body, /- Section: `## Falsifiers`/);
	});

	test('Rationale section includes the rationale verbatim', () => {
		const input = fixtureInput();
		const body = composeProposalBody(input, {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-foo',
		});
		assert.ok(body.includes(input.rationale));
	});

	test('Proposed text section includes the proposed_text verbatim', () => {
		const input = fixtureInput();
		const body = composeProposalBody(input, {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-foo',
		});
		assert.ok(body.includes(input.proposed_text));
	});

	test('Related section links the project + target ADR + ADR-005', () => {
		const body = composeProposalBody(fixtureInput(), {
			created: '2026-05-17',
			target_adr_slug: 'adr-005-foo',
		});
		assert.match(body, /\[\[\.\.\/index\|test-project\]\]/);
		assert.match(body, /\[\[\.\.\/adr-005-foo\|target ADR\]\]/);
		assert.match(
			body,
			/\[\[\.\.\/\.\.\/project-phases\/adr-005-ai-propose-adr-and-propose-slice\|ADR-005\]\]/,
		);
	});
});

// ─── PROPOSAL_SECTIONS export ──────────────────────────────────────────

describe('PROPOSAL_SECTIONS', () => {
	test('exposes the canonical six sections', () => {
		assert.deepEqual(PROPOSAL_SECTIONS, [
			'Status',
			'Context',
			'Decision',
			'Falsifiers',
			'Implementation plan',
			'Related',
		]);
	});
});
