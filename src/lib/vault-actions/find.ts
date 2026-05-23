/** `/find` handler — lexical search over the vault, formatted for the
 *  WhatsApp screen. Matches `engine.getNotes` (MiniSearch under the
 *  hood — same backend as `/api/vault/notes`). Caps at 5 results so
 *  the reply fits in a single message bubble. */

import { getVaultEngine } from '../vault/index.js';
import type { SearchResult } from '../vault/types.js';

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
const RESULT_LIMIT = 5;

export interface VaultFindResult {
	text: string;
	results: SearchResult[];
}

function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}

function formatResult(idx: number, hit: SearchResult): string {
	const meta: string[] = [];
	if (hit.type) meta.push(hit.type);
	if (hit.tags && hit.tags.length) meta.push(hit.tags.slice(0, 3).join(', '));
	const metaLine = meta.length ? ` — ${meta.join(' · ')}` : '';
	return `${idx + 1}. ${hit.title}${metaLine}\n   ${noteOpenUrl(hit.path)}`;
}

export async function dispatchVaultFind(query: string): Promise<VaultFindResult> {
	const engine = getVaultEngine();
	if (!engine) {
		return { text: 'Vault is not initialized — /find is unavailable.', results: [] };
	}

	const trimmed = query.trim();
	if (!trimmed) {
		return {
			text: "Usage: `/find <query>` — searches the vault and returns the top 5 matches.",
			results: [],
		};
	}

	const results = engine.getNotes({ q: trimmed, limit: RESULT_LIMIT });
	if (results.length === 0) {
		return {
			text: `No matches for "${trimmed}". Try a different keyword, a tag (e.g. \`heartbeat\`), or \`/recent\` to see what's fresh.`,
			results: [],
		};
	}

	const lines = [`Top ${results.length} for "${trimmed}":`];
	for (let i = 0; i < results.length; i++) {
		lines.push(formatResult(i, results[i]));
	}
	return { text: lines.join('\n\n'), results };
}
