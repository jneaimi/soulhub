/**
 * ADR-014 S7 — Toolset gating falsifier harness.
 *
 * Falsifier: "any of these tests fail after a code change"
 * passes = ADR-014 is correctly implemented.
 *
 * Covers:
 *  - selectToolsets: pure function, all context paths (S2 + S4)
 *  - applyGatingFilter: toolset membership + WEB_ONLY_TOOLS hard-filter
 *  - session expansion registry: requestToolsetExpansion / getSessionExpansions
 *  - assertToolsetCoverage: warns on untagged tools
 *  - WEB_ONLY_TOOLS: correct members
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	selectToolsets,
	applyGatingFilter,
	requestToolsetExpansion,
	getSessionExpansions,
	clearSessionExpansions,
	assertToolsetCoverage,
	WEB_ONLY_TOOLS,
	TOOLSET_DESCRIPTIONS,
	getToolsetMap,
	type ToolsetName,
} from '../../src/lib/orchestrator-v2/tools/gating.js';
import { TOOL_MANIFESTS } from '../../src/lib/orchestrator-v2/tools/manifest.js';

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Build a minimal fake tools dictionary keyed by manifest entries. */
function fakeToolsFor(names: string[]): Record<string, unknown> {
	return Object.fromEntries(names.map((n) => [n, { _fake: n }]));
}

// ─── selectToolsets ───────────────────────────────────────────────────────────

describe('selectToolsets', () => {
	test('always includes core', () => {
		const enabled = selectToolsets({ channel: 'whatsapp' });
		assert.ok(enabled.has('core'), 'core must always be in the set');
	});

	test('undefined channel returns all toolsets (REPL / legacy compat)', () => {
		const enabled = selectToolsets({});
		const all: ToolsetName[] = [
			'core', 'vault', 'project-adr', 'inbox', 'crm',
			'external-fetch', 'navigation', 'actions',
		];
		for (const ts of all) {
			assert.ok(enabled.has(ts), `all toolsets expected for undefined channel, missing: ${ts}`);
		}
	});

	test('web channel adds navigation + project-adr by default', () => {
		const enabled = selectToolsets({ channel: 'web' });
		assert.ok(enabled.has('navigation'), 'navigation expected on web');
		assert.ok(enabled.has('project-adr'), 'project-adr expected on web');
	});

	test('whatsapp channel does NOT include navigation by scope alone', () => {
		const enabled = selectToolsets({ channel: 'whatsapp' });
		assert.ok(!enabled.has('navigation'), 'navigation must not appear for whatsapp without a URL/keyword');
	});

	// ── Scope defaults (S2) ────────────────────────────────────────────────────

	test('scopeKind=project adds project-adr + vault', () => {
		const enabled = selectToolsets({ channel: 'web', scopeKind: 'project' });
		assert.ok(enabled.has('project-adr'));
		assert.ok(enabled.has('vault'));
	});

	test('scopeKind=crm-contact adds crm + vault', () => {
		const enabled = selectToolsets({ channel: 'web', scopeKind: 'crm-contact' });
		assert.ok(enabled.has('crm'));
		assert.ok(enabled.has('vault'));
	});

	test('scopeKind=inbox-thread adds inbox', () => {
		const enabled = selectToolsets({ channel: 'web', scopeKind: 'inbox-thread' });
		assert.ok(enabled.has('inbox'));
	});

	test('scopeKind=vault-note adds vault', () => {
		const enabled = selectToolsets({ channel: 'web', scopeKind: 'vault-note' });
		assert.ok(enabled.has('vault'));
	});

	// ── Keyword-intent expansion (S4) ─────────────────────────────────────────

	test('CRM keywords expand crm toolset', () => {
		const keywords = ['contact me', 'new lead', 'deal pipeline', 'prospect list', 'follow-up'];
		for (const msg of keywords) {
			const enabled = selectToolsets({ channel: 'whatsapp', userMessage: msg });
			assert.ok(enabled.has('crm'), `crm not enabled for message: "${msg}"`);
		}
	});

	test('URL in message expands external-fetch', () => {
		const enabled = selectToolsets({ channel: 'whatsapp', userMessage: 'check https://example.com' });
		assert.ok(enabled.has('external-fetch'));
	});

	test('youtube.com URL expands external-fetch', () => {
		const enabled = selectToolsets({ channel: 'whatsapp', userMessage: 'summarize https://youtube.com/watch?v=abc' });
		assert.ok(enabled.has('external-fetch'));
	});

	test('"remind me" expands actions', () => {
		const enabled = selectToolsets({ channel: 'whatsapp', userMessage: 'remind me to call Ahmed tomorrow' });
		assert.ok(enabled.has('actions'));
	});

	test('"generate image" expands actions', () => {
		const enabled = selectToolsets({ channel: 'telegram', userMessage: 'generate an image of a falcon' });
		assert.ok(enabled.has('actions'));
	});

	test('inbox email keyword expands inbox', () => {
		const enabled = selectToolsets({ channel: 'web', userMessage: 'check my inbox' });
		assert.ok(enabled.has('inbox'));
	});

	test('"save this" expands vault', () => {
		const enabled = selectToolsets({ channel: 'web', userMessage: 'save this to my notes' });
		assert.ok(enabled.has('vault'));
	});

	test('"project adr" keywords expand project-adr + vault', () => {
		const enabled = selectToolsets({ channel: 'whatsapp', userMessage: 'update the ADR status' });
		assert.ok(enabled.has('project-adr'));
		assert.ok(enabled.has('vault'));
	});

	test('irrelevant message does not expand non-core toolsets on whatsapp', () => {
		const enabled = selectToolsets({ channel: 'whatsapp', userMessage: 'hello, how are you?' });
		// Should only contain core (+ whatever scope/channel adds by default)
		assert.ok(!enabled.has('crm'), 'crm should not appear for plain greeting');
		assert.ok(!enabled.has('inbox'), 'inbox should not appear for plain greeting');
		assert.ok(!enabled.has('navigation'), 'navigation should not appear on whatsapp');
	});
});

// ─── applyGatingFilter ────────────────────────────────────────────────────────

describe('applyGatingFilter', () => {
	// Build a realistic fake tools set from the manifest
	const allToolNames = TOOL_MANIFESTS.map((m) => m.name);
	const allFakeTools = fakeToolsFor(allToolNames);

	test('returns only tools whose toolset is in the enabled set', () => {
		const enabled = new Set<ToolsetName>(['core']);
		const result = applyGatingFilter(allFakeTools, enabled, 'web');
		// core toolset tools should be present
		const toolsetMap = getToolsetMap();
		for (const [name] of Object.entries(result)) {
			const ts = toolsetMap.get(name);
			// could be 'core' or unmapped (passed through)
			assert.ok(!ts || ts === 'core', `tool ${name} should be core, got ${ts}`);
		}
	});

	test('WEB_ONLY_TOOLS are excluded when channel !== web (whatsapp)', () => {
		const enabled = new Set<ToolsetName>([
			'core', 'vault', 'project-adr', 'inbox', 'crm',
			'external-fetch', 'navigation', 'actions',
		]);
		const result = applyGatingFilter(allFakeTools, enabled, 'whatsapp');
		for (const webOnlyTool of WEB_ONLY_TOOLS) {
			assert.ok(
				!(webOnlyTool in result),
				`${webOnlyTool} must not appear in whatsapp tools`,
			);
		}
	});

	test('WEB_ONLY_TOOLS are included when channel === web', () => {
		const enabled = new Set<ToolsetName>([
			'core', 'vault', 'project-adr', 'navigation',
		]);
		const result = applyGatingFilter(allFakeTools, enabled, 'web');
		// e.g. navigateTo is in navigation + WEB_ONLY_TOOLS → should appear on web
		assert.ok('navigateTo' in result, 'navigateTo must appear on web channel');
	});

	test('WEB_ONLY_TOOLS are excluded when channel is undefined', () => {
		const enabled = new Set<ToolsetName>([
			'core', 'vault', 'project-adr', 'inbox', 'crm',
			'external-fetch', 'navigation', 'actions',
		]);
		const result = applyGatingFilter(allFakeTools, enabled, undefined);
		for (const webOnlyTool of WEB_ONLY_TOOLS) {
			assert.ok(
				!(webOnlyTool in result),
				`${webOnlyTool} must not appear when channel is undefined`,
			);
		}
	});

	test('tools without a manifest entry pass through untouched', () => {
		const fakeWithExtra = { ...allFakeTools, _unregisteredTool: { _fake: true } };
		const enabled = new Set<ToolsetName>(['core']);
		const result = applyGatingFilter(fakeWithExtra, enabled, 'web');
		assert.ok('_unregisteredTool' in result, 'unregistered tool should pass through');
	});

	test('does not mutate the original allTools dict', () => {
		const original = { ...allFakeTools };
		const enabled = new Set<ToolsetName>(['core']);
		applyGatingFilter(allFakeTools, enabled, 'web');
		assert.deepStrictEqual(
			Object.keys(allFakeTools).sort(),
			Object.keys(original).sort(),
			'allFakeTools must not be mutated',
		);
	});
});

// ─── WEB_ONLY_TOOLS membership ────────────────────────────────────────────────

describe('WEB_ONLY_TOOLS', () => {
	test('navigateTo and describeCurrentPage are web-only', () => {
		assert.ok(WEB_ONLY_TOOLS.has('navigateTo'));
		assert.ok(WEB_ONLY_TOOLS.has('describeCurrentPage'));
	});

	test('adr write tools are web-only', () => {
		assert.ok(WEB_ONLY_TOOLS.has('adrAccept'));
		assert.ok(WEB_ONLY_TOOLS.has('adrShip'));
		assert.ok(WEB_ONLY_TOOLS.has('adrPark'));
		assert.ok(WEB_ONLY_TOOLS.has('adrReject'));
	});

	test('vaultNoteMove is web-only', () => {
		assert.ok(WEB_ONLY_TOOLS.has('vaultNoteMove'));
	});

	test('listPages is NOT web-only (all-channel)', () => {
		assert.ok(!WEB_ONLY_TOOLS.has('listPages'), 'listPages must be all-channel (core)');
	});

	test('reply is NOT web-only', () => {
		assert.ok(!WEB_ONLY_TOOLS.has('reply'));
	});
});

// ─── Session expansion registry (Tier 3) ─────────────────────────────────────

describe('session expansion registry', () => {
	const key = 'test-conversation-key-adr014';

	test('getSessionExpansions returns empty set for unknown key', () => {
		const expansions = getSessionExpansions('unknown-key-xyz');
		assert.strictEqual(expansions.size, 0);
	});

	test('requestToolsetExpansion stores a toolset for a conversation', () => {
		clearSessionExpansions(key);
		requestToolsetExpansion(key, 'crm');
		const expansions = getSessionExpansions(key);
		assert.ok(expansions.has('crm'), 'crm must be in session expansions after request');
		clearSessionExpansions(key);
	});

	test('multiple toolsets can be added to the same conversation', () => {
		clearSessionExpansions(key);
		requestToolsetExpansion(key, 'inbox');
		requestToolsetExpansion(key, 'actions');
		requestToolsetExpansion(key, 'crm');
		const expansions = getSessionExpansions(key);
		assert.ok(expansions.has('inbox'));
		assert.ok(expansions.has('actions'));
		assert.ok(expansions.has('crm'));
		clearSessionExpansions(key);
	});

	test('clearSessionExpansions removes all expansions for a key', () => {
		requestToolsetExpansion(key, 'vault');
		clearSessionExpansions(key);
		const expansions = getSessionExpansions(key);
		assert.strictEqual(expansions.size, 0);
	});

	test('different conversations have independent expansion sets', () => {
		const key2 = 'test-conversation-key-b';
		clearSessionExpansions(key);
		clearSessionExpansions(key2);
		requestToolsetExpansion(key, 'inbox');
		requestToolsetExpansion(key2, 'crm');
		const exp1 = getSessionExpansions(key);
		const exp2 = getSessionExpansions(key2);
		assert.ok(exp1.has('inbox') && !exp1.has('crm'));
		assert.ok(exp2.has('crm') && !exp2.has('inbox'));
		clearSessionExpansions(key);
		clearSessionExpansions(key2);
	});
});

// ─── assertToolsetCoverage ────────────────────────────────────────────────────

describe('assertToolsetCoverage', () => {
	test('runs without throwing (all manifest entries have toolset tags)', () => {
		// assertToolsetCoverage is warn-only; if it finds gaps it logs but doesn't throw.
		// This test verifies it completes without throwing.
		assert.doesNotThrow(() => assertToolsetCoverage());
	});

	test('every TOOL_MANIFESTS entry has a toolset assigned', () => {
		const untagged = TOOL_MANIFESTS.filter((m) => !m.toolset);
		assert.strictEqual(
			untagged.length,
			0,
			`These manifest entries are missing toolset: ${untagged.map((m) => m.name).join(', ')}`,
		);
	});
});

// ─── TOOLSET_DESCRIPTIONS ─────────────────────────────────────────────────────

describe('TOOLSET_DESCRIPTIONS', () => {
	const allToolsets: ToolsetName[] = [
		'core', 'vault', 'project-adr', 'inbox', 'crm', 'external-fetch', 'navigation', 'actions',
	];

	test('all 8 toolsets have a description', () => {
		for (const ts of allToolsets) {
			assert.ok(
				typeof TOOLSET_DESCRIPTIONS[ts] === 'string' && TOOLSET_DESCRIPTIONS[ts].length > 0,
				`Missing description for toolset: ${ts}`,
			);
		}
	});
});

// ─── Manifest coverage ────────────────────────────────────────────────────────

describe('TOOL_MANIFESTS toolset coverage', () => {
	test('enableToolset and listToolsets are in the manifest (core)', () => {
		const metaToolNames = TOOL_MANIFESTS.map((m) => m.name);
		assert.ok(metaToolNames.includes('enableToolset'), 'enableToolset must be in manifest');
		assert.ok(metaToolNames.includes('listToolsets'), 'listToolsets must be in manifest');
		const enableEntry = TOOL_MANIFESTS.find((m) => m.name === 'enableToolset');
		const listEntry = TOOL_MANIFESTS.find((m) => m.name === 'listToolsets');
		assert.strictEqual(enableEntry?.toolset, 'core', 'enableToolset must be in core toolset');
		assert.strictEqual(listEntry?.toolset, 'core', 'listToolsets must be in core toolset');
	});

	test('listPages is in core toolset (all-channel)', () => {
		const entry = TOOL_MANIFESTS.find((m) => m.name === 'listPages');
		assert.ok(entry, 'listPages must be in manifest');
		assert.strictEqual(entry?.toolset, 'core', 'listPages must be in core toolset');
	});

	test('navigateTo is in navigation toolset', () => {
		const entry = TOOL_MANIFESTS.find((m) => m.name === 'navigateTo');
		assert.ok(entry, 'navigateTo must be in manifest');
		assert.strictEqual(entry?.toolset, 'navigation', 'navigateTo must be in navigation toolset');
	});
});
