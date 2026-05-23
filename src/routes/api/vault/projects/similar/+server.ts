/** GET /api/vault/projects/similar — creation-time validation hook
 *  per ADR-038 Phase 3.
 *
 *  Query params:
 *  - `slug` (required) — proposed kebab-case project slug
 *  - `title` (optional) — proposed human title
 *  - `description` (optional) — 1-2 sentences for the semantic prompt
 *  - `skipSemantic` (optional, default false) — disable the Gemini Flash
 *    fallback even when lexical returns zero
 *
 *  Returns the full `SimilarityResult` (matches + verdict + confidence).
 *  Consumed by the `/new` page UI and any future orchestrator
 *  project-create tool. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { checkProjectSimilarity } from '$lib/vault/project-similarity.js';

export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const slug = url.searchParams.get('slug')?.trim() ?? '';
	if (!slug) return json({ error: 'slug query param is required' }, { status: 400 });

	// Same slug validation as scaffoldProject — keep the API symmetrical.
	if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
		return json(
			{ error: 'slug must be lowercase letters, digits, and hyphens; must start with a letter' },
			{ status: 400 },
		);
	}

	const skipSemantic = url.searchParams.get('skipSemantic') === 'true';
	const title = url.searchParams.get('title') ?? undefined;
	const description = url.searchParams.get('description') ?? undefined;

	try {
		const result = await checkProjectSimilarity(
			engine,
			{ slug, title, description },
			{ skipSemantic },
		);
		return json(result);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Similarity check failed' },
			{ status: 500 },
		);
	}
};
