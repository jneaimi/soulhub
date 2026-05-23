/**
 * Single source of truth for Soul Hub user-data paths.
 *
 * All persistent state lives under `~/.soul-hub/` (overridable via SOUL_HUB_HOME):
 *   ~/.soul-hub/settings.json   — user config
 *   ~/.soul-hub/.env            — platform secrets
 *   ~/.soul-hub/data/           — runtime state (db, audit logs, queues, …)
 *   ~/.soul-hub/logs/           — pm2 stdout/stderr
 *
 * Keeping state out of the repo means clones/upgrades never wipe user data
 * and `git status` stays clean for OSS contributors.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

/** Root of the Soul Hub home directory — absolute, with `~` expanded. */
export function soulHubHome(): string {
	const override = process.env.SOUL_HUB_HOME;
	if (override) {
		return override.startsWith('~')
			? resolve(homedir(), override.slice(1).replace(/^\/+/, ''))
			: resolve(override);
	}
	return resolve(homedir(), '.soul-hub');
}

/** Path to the settings file. */
export function soulHubSettingsPath(): string {
	return resolve(soulHubHome(), 'settings.json');
}

/** Path to the platform secrets file (.env format). */
export function soulHubSecretsPath(): string {
	return resolve(soulHubHome(), '.env');
}

/**
 * Path to the runtime data directory. Pass a leaf to get a sub-path.
 * Ensures the directory exists.
 */
export function soulHubDataDir(...leaf: string[]): string {
	const dir = resolve(soulHubHome(), 'data');
	mkdirSync(dir, { recursive: true });
	return leaf.length ? resolve(dir, ...leaf) : dir;
}

/** Path inside the data dir. Does NOT create parent dirs for the leaf itself. */
export function soulHubDataFile(name: string): string {
	return resolve(soulHubDataDir(), name);
}

/**
 * Path to the temp uploads directory — used by the standalone terminal's
 * drag-drop / upload button when no project cwd is in scope. Pass a leaf
 * (e.g. a date stamp) to get a sub-path. Ensures the base dir exists.
 */
export function soulHubUploadsDir(...leaf: string[]): string {
	const dir = resolve(soulHubHome(), 'uploads');
	mkdirSync(dir, { recursive: true });
	return leaf.length ? resolve(dir, ...leaf) : dir;
}
