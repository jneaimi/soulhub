/**
 * shell-script handler — PATH hardening (spawn bash ENOENT fix).
 *
 * Run via:
 *   node --test --experimental-strip-types tests/scheduler/shell-script-path.test.ts
 *
 * Regression guard for the new-install scheduler failure: a PM2 daemon
 * resurrected at boot by launchd can inherit a PATH that lacks /bin, so
 * `spawn('bash', …)` fails with `spawn bash ENOENT`. The handler now appends
 * the standard system bin dirs to the spawned env's PATH. These tests prove
 * (a) the pure PATH-merge logic and (b) that a task spawns and exits cleanly
 * even when the inherited PATH is minimal.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { delimiter } from 'node:path';

import { hardenPath, shellScriptFactory, ShellScriptError } from '../../src/lib/scheduler/handlers/shell-script.ts';

describe('hardenPath', () => {
	test('appends all system dirs when PATH is empty/undefined', () => {
		for (const input of [undefined, '']) {
			const out = hardenPath(input).split(delimiter);
			for (const dir of ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/sbin', '/sbin']) {
				assert.ok(out.includes(dir), `expected ${dir} in hardened PATH for input=${JSON.stringify(input)}`);
			}
		}
	});

	test('preserves caller entries and their priority order', () => {
		const out = hardenPath('/custom/first:/custom/second').split(delimiter);
		assert.strictEqual(out[0], '/custom/first');
		assert.strictEqual(out[1], '/custom/second');
		assert.ok(out.includes('/bin'), 'system dir still appended after operator entries');
	});

	test('does not duplicate a system dir already present', () => {
		const out = hardenPath('/bin:/custom').split(delimiter);
		assert.strictEqual(out.filter((d) => d === '/bin').length, 1, '/bin must appear exactly once');
	});

	test('drops empty segments from a malformed PATH', () => {
		const out = hardenPath('::/custom::').split(delimiter);
		assert.ok(!out.includes(''), 'no empty PATH segments');
		assert.ok(out.includes('/custom'));
	});
});

describe('shellScriptFactory spawn under minimal PATH', () => {
	test('bash resolves even when inherited PATH lacks /bin (no ENOENT)', async () => {
		const savedPath = process.env.PATH;
		// Simulate the launchd/PM2 stripped environment that caused the bug.
		process.env.PATH = '/nonexistent-dir-for-test';
		try {
			const fn = shellScriptFactory({ command: ['bash', '-c', 'echo ok'] });
			const result = (await fn()) as { exitCode: number | null; stdoutTail: string };
			assert.strictEqual(result.exitCode, 0, 'task should exit 0');
			assert.match(result.stdoutTail, /ok/, 'script stdout captured');
		} finally {
			process.env.PATH = savedPath;
		}
	});

	test('non-zero exit still surfaces as ShellScriptError (sad path intact)', async () => {
		const fn = shellScriptFactory({ command: ['bash', '-c', 'exit 3'] });
		await assert.rejects(
			fn() as Promise<unknown>,
			(err: unknown) => err instanceof ShellScriptError && err.exitCode === 3,
		);
	});
});
