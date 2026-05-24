/**
 * Settings migration — additive feature-flag back-fill (ADR-055 P3).
 *
 * Problem: feature flags added to the schema after an install was created never
 * appear in that install's `~/.soul-hub/settings.json` on `git pull`. The schema
 * default (typically `false`) then wins — even when the DISTRIBUTION wants a
 * different value. Concretely: the public distribution seeds `updateCheck: true`
 * in `settings.example.json`, but an install set up before that flag existed
 * keeps it absent, so the update banner stays dormant forever.
 *
 * Fix: on server boot, for every key in the shipped `settings.example.json`'s
 * `features` block that is MISSING from the live `settings.json`, add it (value
 * from the example). Strictly ADDITIVE — it never overwrites a flag the operator
 * has already set, so an explicit `false` is respected.
 *
 * Distribution-aware for free: the private repo's `settings.example.json` has no
 * `features` block, so this is a no-op on the operator's instance; the public
 * export injects `features` (incl. `updateCheck: true`), so existing public
 * installs self-heal on their next boot after upgrading.
 *
 * Idempotent: writes only when a key is genuinely missing. Fully fail-safe —
 * any error (missing/malformed example, unreadable settings) is a logged no-op,
 * never a boot-blocker.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubSettingsPath } from './paths.js';

export interface MigrationResult {
	/** Feature flags that were back-filled this run (key → value). Empty = no-op. */
	added: Record<string, unknown>;
}

export function migrateFeatureFlags(): MigrationResult {
	const added: Record<string, unknown> = {};
	try {
		// Distribution template ships at the repo root; the server runs with cwd
		// set to the repo root (pm2 / npm scripts), so resolve from there.
		const examplePath = resolve(process.cwd(), 'settings.example.json');
		let exFeatures: Record<string, unknown>;
		try {
			const example = JSON.parse(readFileSync(examplePath, 'utf-8')) as Record<string, unknown>;
			exFeatures = (example.features as Record<string, unknown> | undefined) ?? {};
		} catch {
			return { added }; // no example / unreadable — nothing to seed from
		}
		// No distribution-specific flags to back-fill (e.g. the private repo's
		// example has no `features` block) → guaranteed no-op.
		if (Object.keys(exFeatures).length === 0) return { added };

		const settingsPath = soulHubSettingsPath();
		let settings: Record<string, unknown>;
		try {
			settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
		} catch {
			// No settings.json yet — a fresh install is seeded by bootstrap.sh
			// directly from settings.example.json, so there is nothing to migrate.
			return { added };
		}

		const features = (settings.features as Record<string, unknown> | undefined) ?? {};
		for (const [key, val] of Object.entries(exFeatures)) {
			if (!(key in features)) {
				features[key] = val;
				added[key] = val;
			}
		}
		if (Object.keys(added).length === 0) return { added }; // nothing missing — idempotent

		settings.features = features;
		// Atomic write: tmp + rename, so a crash mid-write can't truncate settings.
		const tmp = `${settingsPath}.migrate.tmp`;
		writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
		renameSync(tmp, settingsPath);
		console.log(
			`[settings-migration] back-filled feature flags from settings.example.json: ${JSON.stringify(added)}`,
		);
		return { added };
	} catch (err) {
		console.error('[settings-migration] failed (non-fatal):', (err as Error).message);
		return { added };
	}
}
