/** `/recent` handler — surfaces the most-recently-modified notes across
 *  the vault, capped at 5. Same WhatsApp-friendly format as `/find` so
 *  results read identically whether the user searched or just asked
 *  what's new. */

import { getVaultEngine } from '../vault/index.js';
import type { VaultNote } from '../vault/types.js';

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
const RESULT_LIMIT = 5;

export interface VaultRecentResult {
	text: string;
	notes: VaultNote[];
}

function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}

/** Frontmatter dates may arrive as a JS Date (when YAML parsed `2026-05-03`
 *  as a date) or a string. Normalize to a `YYYY-MM-DD` prefix so the reply
 *  doesn't shout `Sun May 03 2026 04:00:00 GMT+0400` at a phone screen. */
function shortDate(value: unknown): string | undefined {
	if (!value) return undefined;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	const str = String(value);
	const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : str.slice(0, 10);
}

function formatNote(idx: number, note: VaultNote): string {
	const meta: string[] = [];
	if (note.meta.type) meta.push(String(note.meta.type));
	if (note.meta.project) meta.push(String(note.meta.project));
	const metaLine = meta.length ? ` — ${meta.join(' · ')}` : '';
	const stamp = shortDate(note.meta.updated) || shortDate(note.meta.created);
	const stampLine = stamp ? `\n   _${stamp}_` : '';
	return `${idx + 1}. ${note.title}${metaLine}${stampLine}\n   ${noteOpenUrl(note.path)}`;
}

export async function dispatchVaultRecent(): Promise<VaultRecentResult> {
	const engine = getVaultEngine();
	if (!engine) {
		return { text: 'Vault is not initialized — /recent is unavailable.', notes: [] };
	}

	const notes = engine.getRecent(RESULT_LIMIT);
	if (notes.length === 0) {
		return { text: 'Vault is empty — nothing to show yet. Use `/save <text>` to capture something.', notes: [] };
	}

	const lines = [`Last ${notes.length} touched:`];
	for (let i = 0; i < notes.length; i++) {
		lines.push(formatNote(i, notes[i]));
	}
	return { text: lines.join('\n\n'), notes };
}
