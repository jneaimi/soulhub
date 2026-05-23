#!/usr/bin/env -S npx tsx
/**
 * Falsifier for the `channel-config-precise-shape` governance contract.
 *
 * The precise `SoulHubConfig` typing (src/lib/config.schema.ts) claims the
 * well-known `channels.telegram` block always carries `access` + `delivery`.
 * The RUNTIME `channels` schema is a loose passthrough record, so a hand-edited
 * settings.json can drop those blocks: the typing then silently lies and every
 * direct operator-notification consumer falls through its `if (!delivery) return`
 * guard — alerts go dark with no error.
 *
 * This re-derives the live config exactly as the loader does (read settings.json
 * → ConfigSchema.parse) and asserts the precise blocks survived. Re-parsing the
 * slice through TelegramChannelSchema would be useless (its `.prefault` would
 * backfill the very blocks we're checking for), so we inspect the loose result
 * the consumers actually see.
 *
 * Exit 0 = sound. Exit 1 = drift (the contract is falsified).
 *
 *   npx tsx scripts/contracts/channel-config-precise-shape.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigSchema, findMissingChannelBlocks } from '../../src/lib/config.schema.ts';

function loadRawSettings(): unknown {
	const candidates = [
		process.env.SOUL_HUB_SETTINGS || '',
		resolve(homedir(), '.soul-hub/settings.json'),
		resolve(process.cwd(), 'settings.json'),
	].filter(Boolean);
	for (const p of candidates) {
		try {
			return JSON.parse(readFileSync(p, 'utf-8'));
		} catch {
			/* try next */
		}
	}
	return {};
}

const parsed = ConfigSchema.safeParse(loadRawSettings());
if (!parsed.success) {
	// A schema-invalid settings.json is a different failure class (the loader
	// falls back to defaults, which ARE sound) — not this contract's concern.
	console.log('channel-config-precise-shape: settings.json fails ConfigSchema; loader uses sound defaults — PASS');
	process.exit(0);
}

const missing = findMissingChannelBlocks(parsed.data.channels as Record<string, unknown>);
const drift = Object.entries(missing).filter(([, blocks]) => blocks.length > 0);

if (drift.length === 0) {
	console.log('channel-config-precise-shape: PASS — live config carries every precisely-typed channel block');
	process.exit(0);
}

console.error('channel-config-precise-shape: FALSIFIED — precise SoulHubConfig typing assumes channel blocks the live config omits:');
for (const [channel, blocks] of drift) {
	console.error(`  • channels.${channel}: missing [${blocks.join(', ')}] — direct consumers will silently no-op`);
}
console.error('Fix: restore the blocks in settings.json, OR make the consumers re-validate their slice, OR narrow the typing.');
process.exit(1);
