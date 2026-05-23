/** Auth dir resolution for the Baileys multi-file auth state. The actual
 *  reader/writer is `useMultiFileAuthState` from Baileys — this module
 *  centralises path expansion and the ~/.soul-hub/data convention.
 *  Per OSS ADR-001, all user state lives under `~/.soul-hub/`. */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { soulHubDataDir } from '../../paths.js';
import type { WhatsAppChannelConfig } from './types.js';

const HOME = homedir();

function expandPath(p: string): string {
	if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
	if (p === '~') return HOME;
	return resolve(p);
}

/** Resolve the auth directory for the active WhatsApp account. Falls back
 *  to `~/.soul-hub/data/whatsapp/<account>/` when the config doesn't
 *  spell out an absolute path. */
export function resolveAuthDir(config: WhatsAppChannelConfig): string {
	const accountId = config.account;
	const accountConfig = config.accounts[accountId];
	if (accountConfig?.authDir) {
		const expanded = expandPath(accountConfig.authDir);
		mkdirSync(expanded, { recursive: true, mode: 0o700 });
		return expanded;
	}
	const fallback = resolve(soulHubDataDir(), 'whatsapp', accountId);
	mkdirSync(fallback, { recursive: true, mode: 0o700 });
	return fallback;
}

/** Wipe the auth dir — called on explicit logout or 401 (logged-out from
 *  the WhatsApp side). Best-effort: missing dir is not an error. */
export function clearAuthDir(authDir: string): void {
	if (!existsSync(authDir)) return;
	rmSync(authDir, { recursive: true, force: true });
}
