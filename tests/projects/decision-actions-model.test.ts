/**
 * projects-graph ADR-025 D5 — decisionActionModel unit tests.
 *
 * Covers the pure UI model that drives DecisionActions.svelte:
 *  - agent resolves → showAiButton=true + correct agent name in resolvedAgent
 *  - null resolves   → showAiButton=false (plain Accept only, no AI affordance)
 *  - pre-set assignee that IS a roster agent wins (row 1 routing precedence)
 *  - buildConfirmMessage returns the canonical confirm string
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/decision-actions-model.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decisionActionModel, buildConfirmMessage } from '../../src/lib/projects/decision-actions-model.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roster(...ids: string[]): Set<string> {
	return new Set(ids.map((id) => id.toLowerCase()));
}

const FULL_ROSTER = roster(
	'soul-hub-implementer',
	'implementer',   // ADR-011 — general coding floor (replaces 'developer' as default)
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
	'weaver',        // ADR-025 D2 — arabic work_type specialist
);

const EMPTY_ROSTER = new Set<string>();

// ---------------------------------------------------------------------------
// showAiButton + resolvedAgent — agent resolves
// ---------------------------------------------------------------------------

describe('decisionActionModel — agent resolves → showAiButton=true', () => {
	test('coding + soul-hub cluster → soul-hub-implementer, showAiButton=true', () => {
		const model = decisionActionModel('coding', null, ['cluster:soul-hub', 'adr'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'soul-hub-implementer');
	});

	test('coding without cluster → implementer (ADR-011 floor), showAiButton=true', () => {
		// ADR-011 switched the coding floor from 'developer' to 'implementer'.
		// FULL_ROSTER now includes 'implementer'; 'developer' is no longer the floor.
		const model = decisionActionModel('coding', null, ['workbench'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'implementer');
	});

	test('research → researcher, showAiButton=true', () => {
		const model = decisionActionModel('research', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'researcher');
	});

	test('writing → author, showAiButton=true', () => {
		const model = decisionActionModel('writing', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'author');
	});

	test('design → designer, showAiButton=true', () => {
		const model = decisionActionModel('design', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'designer');
	});

	test('media → media-generator, showAiButton=true', () => {
		const model = decisionActionModel('media', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'media-generator');
	});
});

// ---------------------------------------------------------------------------
// showAiButton=false — human-only work
// ---------------------------------------------------------------------------

describe('decisionActionModel — no agent routes → showAiButton=false', () => {
	test('work_type=decision → null, showAiButton=false', () => {
		const model = decisionActionModel('decision', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('work_type=manual → null, showAiButton=false', () => {
		const model = decisionActionModel('manual', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('null work_type, no assignee → null, showAiButton=false', () => {
		const model = decisionActionModel(null, null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('empty-string work_type → null, showAiButton=false', () => {
		const model = decisionActionModel('', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('unmapped work_type → null, showAiButton=false', () => {
		const model = decisionActionModel('ritual', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('empty roster → null even for coding, showAiButton=false', () => {
		const model = decisionActionModel('coding', null, ['cluster:soul-hub'], EMPTY_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});
});

// ---------------------------------------------------------------------------
// Pre-set assignee honored (D5 spec: "Respect a pre-set assignee")
// ---------------------------------------------------------------------------

describe('decisionActionModel — pre-set assignee wins (D5 spec)', () => {
	test('pre-set assignee in roster beats cluster routing', () => {
		const model = decisionActionModel('coding', 'researcher', ['cluster:soul-hub'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'researcher');
	});

	test('pre-set assignee in roster beats default work_type mapping', () => {
		const model = decisionActionModel('design', 'author', [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'author');
	});

	test('pre-set assignee of soul-hub-implementer is honored directly', () => {
		// Simulates a note that already has assignee=soul-hub-implementer set.
		// resolveAgentForWork row 1: assignee in roster → returns it immediately.
		const model = decisionActionModel('coding', 'soul-hub-implementer', ['cluster:soul-hub'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'soul-hub-implementer');
	});

	test('pre-set assignee NOT in roster is ignored; falls through to routing', () => {
		// 'ghost-agent' is not installed → routing falls through to coding+soul-hub → soul-hub-implementer
		const model = decisionActionModel('coding', 'ghost-agent', ['cluster:soul-hub'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'soul-hub-implementer');
	});

	test('pre-set assignee that maps to a human-only work → still routes to assignee', () => {
		// Explicit assignee in roster always wins — even if work_type says decision.
		const model = decisionActionModel('decision', 'researcher', [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'researcher');
	});
});

// ---------------------------------------------------------------------------
// buildConfirmMessage — canonical confirm string
// ---------------------------------------------------------------------------

describe('buildConfirmMessage', () => {
	test('contains the agent name in backtick form', () => {
		const msg = buildConfirmMessage('soul-hub-implementer');
		assert.ok(msg.includes('`soul-hub-implementer`'), `Expected backtick form in: ${msg}`);
	});

	test('mentions production mode', () => {
		const msg = buildConfirmMessage('developer');
		assert.ok(msg.includes('production'), `Expected "production" in: ${msg}`);
	});

	test('mentions isolated worktree', () => {
		const msg = buildConfirmMessage('developer');
		assert.ok(msg.includes('isolated'), `Expected "isolated" in: ${msg}`);
	});

	test('mentions cost estimate', () => {
		const msg = buildConfirmMessage('soul-hub-implementer');
		assert.ok(msg.includes('$5'), `Expected cost estimate in: ${msg}`);
	});

	test('mentions branch hand-back', () => {
		const msg = buildConfirmMessage('soul-hub-implementer');
		assert.ok(msg.includes('branch'), `Expected "branch" in: ${msg}`);
	});
});

// ---------------------------------------------------------------------------
// ADR-025 D3 — needsScaffold hint for coding with no project repo
// ---------------------------------------------------------------------------

describe('decisionActionModel — needsScaffold (ADR-025 D3)', () => {
	const ROSTER_WITH_IMPLEMENTER = roster('implementer', 'researcher', 'designer');
	const ROSTER_NO_IMPLEMENTER = roster('researcher', 'designer');

	test('coding + no project repo + implementer in roster → needsScaffold=true', () => {
		// subjectHasProjectRepo=false (default) + no repoMap (backward-compat:
		// hasRepo returns true) → implementer resolves normally.
		// But WITH a repoMap where implementer has no repo and no project repo →
		// resolvedAgent=null and needsScaffold=true.
		const repoMap = new Map<string, string | undefined>([['implementer', undefined]]);
		const model = decisionActionModel('coding', null, [], ROSTER_WITH_IMPLEMENTER, repoMap, false);
		assert.equal(model.showAiButton, false);
		assert.equal(model.needsScaffold, true);
	});

	test('coding + project repo PRESENT → needsScaffold=false, showAiButton=true', () => {
		const repoMap = new Map<string, string | undefined>([['implementer', undefined]]);
		// subjectHasProjectRepo=true unlocks the implementer carve-out → resolves
		const model = decisionActionModel('coding', null, [], ROSTER_WITH_IMPLEMENTER, repoMap, true);
		assert.equal(model.showAiButton, true);
		assert.equal(model.needsScaffold, false);
	});

	test('coding + no project repo + NO implementer in roster → needsScaffold=true (floor absent)', () => {
		// Even with no implementer in roster, needsScaffold fires for coding+no-repo
		// (the operator should bind a repo + install implementer).
		const repoMap = new Map<string, string | undefined>();
		const model = decisionActionModel('coding', null, [], ROSTER_NO_IMPLEMENTER, repoMap, false);
		assert.equal(model.showAiButton, false);
		assert.equal(model.needsScaffold, true);
	});

	test('non-coding work_type + no project repo → needsScaffold=false', () => {
		// D3 only fires for coding; design/research missing specialist is a
		// different problem (missingSpecialist), not a repo-binding problem.
		// Use a roster without designer so resolvedAgent=null, then confirm
		// needsScaffold is still false (not coding → no scaffold hint).
		const repoMap = new Map<string, string | undefined>();
		const rosterNoDesigner = roster('researcher', 'implementer');
		const model = decisionActionModel('design', null, [], rosterNoDesigner, repoMap, false);
		assert.equal(model.showAiButton, false);
		assert.equal(model.needsScaffold, false);
	});

	test('work_type=decision + no project repo → needsScaffold=false (human-owned)', () => {
		const repoMap = new Map<string, string | undefined>();
		const model = decisionActionModel('decision', null, [], ROSTER_WITH_IMPLEMENTER, repoMap, false);
		assert.equal(model.showAiButton, false);
		assert.equal(model.needsScaffold, false);
	});

	test('work_type=null + no project repo → needsScaffold=false', () => {
		const repoMap = new Map<string, string | undefined>();
		const model = decisionActionModel(null, null, [], ROSTER_WITH_IMPLEMENTER, repoMap, false);
		assert.equal(model.showAiButton, false);
		assert.equal(model.needsScaffold, false);
	});

	test('needsScaffold=false when showAiButton=true (D3 mutually exclusive with AI dispatch)', () => {
		// soul-hub cluster + soul-hub-implementer has a static repo → resolves
		const rosterWithShi = roster('soul-hub-implementer', 'implementer');
		const repoMap = new Map<string, string | undefined>([
			['soul-hub-implementer', '~/dev/soul-hub'],
		]);
		const model = decisionActionModel('coding', null, ['cluster:soul-hub'], rosterWithShi, repoMap, false);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'soul-hub-implementer');
		assert.equal(model.needsScaffold, false);
	});

	test('needsScaffold=false without repoMap (backward-compat: no ADR-014 check)', () => {
		// When repoMap is absent, hasRepo returns true (backward-compat path).
		// The implementer resolves without project repo check → showAiButton=true.
		const model = decisionActionModel('coding', null, [], ROSTER_WITH_IMPLEMENTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.needsScaffold, false);
	});
});

// ---------------------------------------------------------------------------
// ADR-025 D2 — arabic work_type routes to weaver
// ---------------------------------------------------------------------------

describe('decisionActionModel — arabic → weaver (ADR-025 D2)', () => {
	test('arabic → weaver, showAiButton=true when weaver in roster', () => {
		const model = decisionActionModel('arabic', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'weaver');
	});

	test('arabic → null when weaver NOT in roster', () => {
		const rosterNoWeaver = roster('researcher', 'author', 'designer', 'implementer');
		const model = decisionActionModel('arabic', null, [], rosterNoWeaver);
		assert.equal(model.showAiButton, false);
		assert.equal(model.resolvedAgent, null);
	});

	test('arabic → weaver unaffected by soul-hub cluster', () => {
		// arabic is non-coding; cluster only affects coding work_type
		const model = decisionActionModel('arabic', null, ['cluster:soul-hub'], FULL_ROSTER);
		assert.equal(model.resolvedAgent, 'weaver');
	});
});

// ---------------------------------------------------------------------------
// ADR-025 D2 — missingSpecialist hint for absent non-coding specialists
// ---------------------------------------------------------------------------

describe('decisionActionModel — missingSpecialist hint (ADR-025 D2)', () => {
	test('designer missing → missingSpecialist="designer"', () => {
		const rosterNoDesigner = roster('researcher', 'author', 'implementer', 'weaver');
		const model = decisionActionModel('design', null, [], rosterNoDesigner);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, 'designer');
	});

	test('weaver missing → missingSpecialist="weaver"', () => {
		const rosterNoWeaver = roster('researcher', 'author', 'designer', 'implementer');
		const model = decisionActionModel('arabic', null, [], rosterNoWeaver);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, 'weaver');
	});

	test('researcher missing → missingSpecialist="researcher"', () => {
		const rosterNoResearcher = roster('author', 'designer', 'implementer');
		const model = decisionActionModel('research', null, [], rosterNoResearcher);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, 'researcher');
	});

	test('author missing → missingSpecialist="author"', () => {
		const rosterNoAuthor = roster('researcher', 'designer', 'implementer');
		const model = decisionActionModel('writing', null, [], rosterNoAuthor);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, 'author');
	});

	test('media-generator missing → missingSpecialist="media-generator"', () => {
		const rosterNoMedia = roster('researcher', 'author', 'designer', 'implementer');
		const model = decisionActionModel('media', null, [], rosterNoMedia);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, 'media-generator');
	});

	test('missingSpecialist=null when specialist IS in roster', () => {
		// designer is present → resolvedAgent='designer', missingSpecialist=null
		const model = decisionActionModel('design', null, [], FULL_ROSTER);
		assert.equal(model.resolvedAgent, 'designer');
		assert.equal(model.missingSpecialist, null);
	});

	test('missingSpecialist=null for coding (uses floor, not a fixed specialist)', () => {
		// coding with no implementer in roster → null resolvedAgent, but NOT missingSpecialist
		const rosterNoImplementer = roster('researcher', 'designer');
		const model = decisionActionModel('coding', null, [], rosterNoImplementer);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, null);
	});

	test('missingSpecialist=null for decision (human-owned)', () => {
		const model = decisionActionModel('decision', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, null);
	});

	test('missingSpecialist=null for manual (human-owned)', () => {
		const model = decisionActionModel('manual', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, null);
	});

	test('missingSpecialist=null for unknown work_type', () => {
		const model = decisionActionModel('ritual', null, [], FULL_ROSTER);
		assert.equal(model.showAiButton, false);
		assert.equal(model.missingSpecialist, null);
	});

	test('missingSpecialist=null when agent resolved (assignee wins)', () => {
		// Even if designer is not installed, an assignee that IS in the roster
		// resolves — missingSpecialist should not fire when resolvedAgent is set.
		const rosterNoDesigner = roster('researcher', 'author', 'implementer');
		const model = decisionActionModel('design', 'researcher', [], rosterNoDesigner);
		assert.equal(model.resolvedAgent, 'researcher');
		assert.equal(model.missingSpecialist, null);
	});
});
