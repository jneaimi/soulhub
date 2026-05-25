import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { soulHubSecretsPath } from '$lib/paths.js';

/**
 * GET /api/settings/keys — ADR-007 key-presence probe for the agent UI.
 *
 * Reports, for a fixed allowlist of LLM secrets, ONLY whether each is set in
 * `~/.soul-hub/.env` and its last-4 chars (so the operator can confirm WHICH
 * key is loaded without exposing it). The full secret is NEVER read into the
 * response and is NEVER logged. Missing .env → every key `present: false`.
 */

const ALLOWLIST = [
	'ANTHROPIC_API_KEY',
	'OPENROUTER_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_API_KEY',
] as const;

interface KeyPresence {
	present: boolean;
	last4: string | null;
}

export const GET: RequestHandler = async () => {
	try {
		const keys: Record<string, KeyPresence> = {};
		for (const name of ALLOWLIST) keys[name] = { present: false, last4: null };

		let raw = '';
		try {
			raw = readFileSync(soulHubSecretsPath(), 'utf-8');
		} catch {
			// Missing .env — every key stays absent.
			return json({ keys });
		}

		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
			if (!m) continue;
			const name = m[1];
			if (!(name in keys)) continue;
			const value = m[2].trim().replace(/^['"]|['"]$/g, '');
			if (!value) continue;
			keys[name] = { present: true, last4: value.slice(-4) };
		}

		return json({ keys });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
