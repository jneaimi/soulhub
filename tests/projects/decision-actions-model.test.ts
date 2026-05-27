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
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
	'weaver',
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

	test('coding without cluster → developer, showAiButton=true', () => {
		const model = decisionActionModel('coding', null, ['workbench'], FULL_ROSTER);
		assert.equal(model.showAiButton, true);
		assert.equal(model.resolvedAgent, 'developer');
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
