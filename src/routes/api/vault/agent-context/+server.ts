import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getVaultEngine } from '$lib/vault/index.js'

/** GET /api/vault/agent-context — Pre-fetch relevant context for agent tasks */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine()
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 })
	}

	const project = url.searchParams.get('project') || undefined
	const query = url.searchParams.get('q') || undefined
	const agent = url.searchParams.get('agent') || undefined
	const limitParam = parseInt(url.searchParams.get('limit') || '5', 10)
	const limit = Math.min(Math.max(1, limitParam), 20)

	const context: Record<string, unknown> = {}

	if (project) {
		context.projectNotes = engine.getNotes({ project, limit })
	}

	if (query) {
		context.relatedNotes = engine.getNotes({ q: query, limit })
	}

	if (agent) {
		context.recentWrites = engine.getWriteLog({ agent, limit: 10 })
	}

	context.recentDecisions = engine.getNotes({ type: 'decision', limit: 3 })
	context.recentPatterns = engine.getNotes({ type: 'pattern', limit: 3 })

	return json(context)
}
