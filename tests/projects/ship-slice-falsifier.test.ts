/**
 * appendFalsifierClosure regression tests — per project-phases ADR-004 S3.
 *
 * The 2026-05-17 F4 dogfood-ship caught a real bug: the closure line landed
 * inside a fenced ```` ```markdown ```` example block in ADR-004's Context
 * section, NOT in the real `## Status` section. Root cause: the scorecard
 * scan ran against the un-stripped body AND wasn't bounded to the actual
 * `## Status` section. Both guards now in place.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { appendFalsifierClosure } from '../../src/lib/projects/ship-slice.ts';

describe('appendFalsifierClosure — fence-aware + Status-bounded scorecard scan', () => {
	test('self-referential ADR — closure lands in REAL Status, NOT inside fenced example', () => {
		// Mimic ADR-004's shape: a real `## Status` section, followed by a
		// `## Context` section containing a fenced markdown example with
		// `## Status` + `**Falsifier scorecard after S3**:` prose as the
		// pedagogical example.
		const body = `
## Status

**S1 SHIPPED 2026-05-17** commit \`abc1234\` — initial work

## Context

The closure-marker shape looks like this:

\`\`\`markdown
## Status

**Falsifier scorecard after S3**:

- ✅ F1 — closed 2026-05-17 (example evidence)
- ⏳ F2 — pending (example)
\`\`\`

Multiple scorecard blocks may exist.
`;
		const result = appendFalsifierClosure(body, 'F1', '2026-05-17', 'deadbef', 'S2');
		assert.equal(result.changed, true);
		// The new line must be in the REAL Status section (above `## Context`),
		// NOT inside the fenced example below.
		const realStatusEnd = result.body.indexOf('## Context');
		const closureIdx = result.body.indexOf('- ✅ F1 — closed 2026-05-17 (commit `deadbef`, slice S2 shipped)');
		assert.ok(closureIdx > 0, 'closure line present');
		assert.ok(closureIdx < realStatusEnd, 'closure line is BEFORE the Context section (i.e., inside real Status)');
		// And the fenced example F1 must remain unchanged inside the fence.
		assert.ok(result.body.includes('- ✅ F1 — closed 2026-05-17 (example evidence)'), 'fenced example F1 preserved verbatim');
	});

	test('Status section with NO existing scorecard — creates one', () => {
		const body = `## Status\n\n**S1 SHIPPED 2026-05-17** commit \`abc1234\`\n\n## Context\n\nStuff.`;
		const result = appendFalsifierClosure(body, 'F1', '2026-05-17', 'deadbef', 'S2');
		assert.equal(result.changed, true);
		assert.ok(result.body.includes('**Falsifier scorecard after S2**:'), 'new scorecard block created');
		assert.ok(result.body.includes('- ✅ F1 — closed 2026-05-17 (commit `deadbef`, slice S2 shipped)'));
		// Must precede `## Context`
		assert.ok(result.body.indexOf('Falsifier scorecard') < result.body.indexOf('## Context'));
	});

	test('Status section with EXISTING scorecard — appends to it (no new block)', () => {
		const body = `## Status

**Falsifier scorecard after S2**:

- ✅ F1 — closed 2026-05-15 (earlier)

## Context

Stuff.
`;
		const result = appendFalsifierClosure(body, 'F2', '2026-05-17', 'deadbef', 'S3');
		assert.equal(result.changed, true);
		// Should be appended to the existing block, not create a new one
		const blockMatches = result.body.match(/\*\*Falsifier scorecard after [^*]+\*\*:/g) ?? [];
		assert.equal(blockMatches.length, 1, 'no new scorecard block created');
		assert.ok(result.body.includes('- ✅ F2 — closed 2026-05-17 (commit `deadbef`, slice S3 shipped)'));
	});

	test('idempotent — same closure already present is a no-op', () => {
		const body = `## Status

**Falsifier scorecard after S2**:

- ✅ F1 — closed 2026-05-17 (commit \`deadbef\`, slice S2 shipped)

## Context
`;
		const result = appendFalsifierClosure(body, 'F1', '2026-05-17', 'deadbef', 'S2');
		assert.equal(result.changed, false, 'no change when exact line already present');
	});

	test('replaces existing PENDING marker with CLOSED (status transition)', () => {
		const body = `## Status

**Falsifier scorecard after S1**:

- ⏳ F1 — pending (waiting on S2)

## Context
`;
		const result = appendFalsifierClosure(body, 'F1', '2026-05-17', 'deadbef', 'S2');
		assert.equal(result.changed, true);
		assert.ok(!result.body.includes('⏳ F1 — pending'), 'pending marker removed');
		assert.ok(result.body.includes('✅ F1 — closed 2026-05-17 (commit `deadbef`, slice S2 shipped)'));
	});

	test('no Status section at all — creates one with the closure', () => {
		const body = `# Some ADR\n\n## Context\n\nStuff.`;
		const result = appendFalsifierClosure(body, 'F1', '2026-05-17', undefined, 'S1');
		assert.equal(result.changed, true);
		assert.ok(result.body.startsWith('## Status\n'), 'Status section created at top');
		assert.ok(result.body.includes('- ✅ F1 — closed 2026-05-17 (slice S1 shipped)'), 'closure line without commit');
	});
});
