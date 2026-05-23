import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getVaultEngine } from '$lib/vault/index.js'

/** GET /api/vault/writes — Agent write audit trail.
 *
 *  Query params:
 *    - agent          — exact match on the audit actor (e.g. "proposeAdr")
 *    - actor_prefix   — prefix match (e.g. "propose" matches proposeAdr /
 *                       proposeSlice / suggestAdrEdit-but-NOT — wait,
 *                       prefix is literal so "propose" only catches the
 *                       propose-* family. Operators wanting the full
 *                       proposal-suite picture can pass actor_prefix=propose
 *                       OR rely on the ADR-005 S4 /orchestration/tools
 *                       Recent proposals panel which combines all 4 actors.)
 *    - zone           — restrict to a zone prefix
 *    - limit          — 1..200, default 50
 *
 *  Returned in DESC timestamp order (most-recent first). */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine()
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 })
	}

	const agent = url.searchParams.get('agent') || undefined
	const actorPrefix = url.searchParams.get('actor_prefix') || undefined
	const zone = url.searchParams.get('zone') || undefined
	const limitParam = parseInt(url.searchParams.get('limit') || '50', 10)
	const limit = Math.min(Math.max(1, limitParam), 200)

	// `getWriteLog` already supports exact-agent filtering. For prefix
	// matching we pull a wider window (up to 200) then filter client-side
	// before applying the requested limit. Engine-side prefix support is
	// a follow-up if call volume justifies it.
	if (actorPrefix) {
		const wide = engine.getWriteLog({ agent: undefined, zone, limit: 200 })
		const filtered = wide.filter((e) => (e.agent ?? '').startsWith(actorPrefix))
		return json({ entries: filtered.slice(0, limit), total: filtered.length })
	}

	const log = engine.getWriteLog({ agent, zone, limit })
	return json({ entries: log, total: log.length })
}
