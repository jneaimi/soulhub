/**
 * Global secrets layer — platform-level secrets stored in ~/.soul-hub/.env
 *
 * Secrets are loaded at startup and merged into process.env.
 * The API allows reading (masked) and writing secrets from the UI.
 * Actual values never leave the server — the UI only sees masked versions.
 *
 * File format: standard .env (KEY=value, one per line, # comments)
 */

import {
	readFileSync,
	writeFileSync,
	renameSync,
	chmodSync,
	existsSync,
	mkdirSync,
	openSync,
	fsyncSync,
	closeSync,
	unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { soulHubSecretsPath } from './paths.js';
import { getAllDeclaredSecrets } from './secret-testers.js';

const SECRETS_PATH = soulHubSecretsPath();
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Ensure the parent directory exists with 0700 mode. */
function ensureDir(): void {
	const dir = dirname(SECRETS_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	try {
		chmodSync(dir, DIR_MODE);
	} catch {
		/* permission already correct or unavailable on platform */
	}
}

/**
 * Atomic, durable write of the secrets file.
 *
 * Steps: rotate `.env → .env.bak`, write `.env.tmp`, fsync, rename onto `.env`,
 * chmod 0600. The rename is POSIX-atomic, so an interrupt at any point either
 * leaves the previous file intact or atomically replaces it.
 */
function atomicWriteSecrets(content: string): void {
	ensureDir();

	if (existsSync(SECRETS_PATH)) {
		const backup = `${SECRETS_PATH}.bak`;
		try {
			if (existsSync(backup)) unlinkSync(backup);
			renameSync(SECRETS_PATH, backup);
			try {
				chmodSync(backup, FILE_MODE);
			} catch {
				/* ignore */
			}
		} catch {
			/* best-effort backup */
		}
	}

	const tmp = `${SECRETS_PATH}.tmp`;
	writeFileSync(tmp, content, { encoding: 'utf-8', mode: FILE_MODE });
	try {
		const fd = openSync(tmp, 'r+');
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* fsync best-effort — not all FS support it */
	}
	renameSync(tmp, SECRETS_PATH);
	try {
		chmodSync(SECRETS_PATH, FILE_MODE);
	} catch {
		/* ignore */
	}
}

/** Parse a .env file into key-value pairs */
function parseEnv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIdx = trimmed.indexOf('=');
		if (eqIdx === -1) continue;
		const key = trimmed.substring(0, eqIdx).trim();
		let value = trimmed.substring(eqIdx + 1).trim();
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) result[key] = value;
	}
	return result;
}

/** Serialize key-value pairs to .env format */
function serializeEnv(secrets: Record<string, string>): string {
	const lines = ['# Soul Hub platform secrets', '# Managed via Settings > Channels', ''];
	for (const [key, value] of Object.entries(secrets)) {
		// Quote values that contain spaces or special chars
		if (value.includes(' ') || value.includes('#') || value.includes('"')) {
			lines.push(`${key}="${value.replace(/"/g, '\\"')}"`);
		} else {
			lines.push(`${key}=${value}`);
		}
	}
	lines.push(''); // trailing newline
	return lines.join('\n');
}

/** Load secrets from .data/secrets.env and merge into process.env */
export function loadSecrets(): Record<string, string> {
	if (!existsSync(SECRETS_PATH)) return {};
	try {
		const content = readFileSync(SECRETS_PATH, 'utf-8');
		const secrets = parseEnv(content);
		// Merge into process.env — secrets.env values override shell env
		// This allows UI-configured values to take precedence
		for (const [key, value] of Object.entries(secrets)) {
			process.env[key] = value;
		}
		return secrets;
	} catch {
		return {};
	}
}

/** A masked secret entry returned by the API.
 *
 *  - `set`: any source has supplied a value (platform file or shell env)
 *  - `source`: `platform` if `~/.soul-hub/.env` carries the value, `shell`
 *    if it only exists in process.env (inherited from the parent shell)
 *  - `declared`: true if at least one channel/provider adapter declares it.
 *    Declared-but-unset keys are surfaced so UIs can prompt the user.
 *  - `required`: declared by an adapter that marks it as required. */
export interface MaskedSecret {
	key: string;
	set: boolean;
	source: 'platform' | 'shell';
	declared: boolean;
	required: boolean;
	declaredBy: string[];
	link?: string;
}

/** Get all secrets as masked entries — joins declared-by-adapter ∪ set-on-disk. */
export function getMaskedSecrets(): MaskedSecret[] {
	const platformSecrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	const declared = getAllDeclaredSecrets();
	const declaredByKey = new Map(declared.map((d) => [d.key, d]));

	const allKeys = new Set<string>([...Object.keys(platformSecrets), ...declaredByKey.keys()]);

	return Array.from(allKeys).map((key): MaskedSecret => {
		const d = declaredByKey.get(key);
		return {
			key,
			set: !!process.env[key],
			source: key in platformSecrets ? 'platform' : 'shell',
			declared: !!d,
			required: d?.required ?? false,
			declaredBy: d?.declaredBy ?? [],
			link: d?.link,
		};
	});
}

/** Check if a specific env var is set (from any source) */
export function isEnvSet(key: string): boolean {
	return !!process.env[key];
}

/** Set a secret — writes to ~/.soul-hub/.env atomically and updates process.env */
export function setSecret(key: string, value: string): void {
	if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
		throw new Error(`Invalid secret key: "${key}". Use UPPER_SNAKE_CASE.`);
	}

	const secrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	secrets[key] = value;
	atomicWriteSecrets(serializeEnv(secrets));

	// Update process.env immediately so callers see the new value without restart
	process.env[key] = value;
}

/** Remove a secret — atomically writes ~/.soul-hub/.env without the key */
export function removeSecret(key: string): void {
	const secrets = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	delete secrets[key];
	delete process.env[key];

	atomicWriteSecrets(serializeEnv(secrets));
}

/** Get the raw value of a secret (server-side only — never expose to client) */
export function getSecretValue(key: string): string | undefined {
	return process.env[key];
}

/** Sync known env vars from process.env (shell) into .data/secrets.env.
 *  Only imports keys that exist in process.env but not in secrets.env.
 *  Returns the count of newly synced keys. */
export function syncFromShell(keys: string[]): number {
	const existing = existsSync(SECRETS_PATH)
		? parseEnv(readFileSync(SECRETS_PATH, 'utf-8'))
		: {};

	let synced = 0;
	for (const key of keys) {
		// Only sync if the key exists in process.env and is not already in secrets.env
		if (process.env[key] && !(key in existing)) {
			existing[key] = process.env[key]!;
			synced++;
		}
	}

	if (synced > 0) {
		atomicWriteSecrets(serializeEnv(existing));
	}

	return synced;
}

// Load secrets on module import (server startup)
loadSecrets();
