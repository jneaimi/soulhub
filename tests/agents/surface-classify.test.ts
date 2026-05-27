/** ADR-012 P3 — classifySurface tests.
 *
 *  Determines an artifact's implementation surface from its `surface:`
 *  frontmatter so the UI routes out-of-worktree work deliberately instead of
 *  pretending it's soul-hub code (the ADR-003 failure mode).
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/surface-classify.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('classifySurface', () => {
	test('absent surface → soul-hub (default in-worktree path)', async () => {
		const { classifySurface } = await import('$lib/projects/dispatch-routing.ts');
		assert.deepEqual(classifySurface({}), { kind: 'soul-hub' });
		assert.deepEqual(classifySurface({ surface: undefined }), { kind: 'soul-hub' });
		assert.equal(classifySurface({ surface: 42 as unknown }).kind, 'soul-hub');
	});

	test('explicit soul-hub aliases → soul-hub', async () => {
		const { classifySurface } = await import('$lib/projects/dispatch-routing.ts');
		assert.equal(classifySurface({ surface: 'soul-hub' }).kind, 'soul-hub');
		assert.equal(classifySurface({ surface: '~/dev/soul-hub' }).kind, 'soul-hub');
		assert.equal(classifySurface({ surface: 'Soul-Hub' }).kind, 'soul-hub'); // case-insensitive
	});

	test('global agent/skill config → config-repo with claude-config repo', async () => {
		const { classifySurface } = await import('$lib/projects/dispatch-routing.ts');
		for (const s of ['~/.claude/agents', '~/.claude/skills', 'agent-config', 'skill-config', 'claude-config']) {
			const r = classifySurface({ surface: s });
			assert.equal(r.kind, 'config-repo', `${s} → config-repo`);
			assert.equal(r.repo, '~/claude-config', `${s} → claude-config repo`);
			assert.equal(r.declared, s);
		}
	});

	test('config surface is case-insensitive on the alias key', async () => {
		const { classifySurface } = await import('$lib/projects/dispatch-routing.ts');
		const r = classifySurface({ surface: '~/.CLAUDE/Agents' });
		assert.equal(r.kind, 'config-repo');
		assert.equal(r.repo, '~/claude-config');
	});

	test('an unknown declared surface → external (no known repo)', async () => {
		const { classifySurface } = await import('$lib/projects/dispatch-routing.ts');
		const r = classifySurface({ surface: '~/some/other/repo' });
		assert.equal(r.kind, 'external');
		assert.equal(r.repo, undefined);
		assert.equal(r.declared, '~/some/other/repo');
	});
});
