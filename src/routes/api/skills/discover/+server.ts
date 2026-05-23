import type { RequestHandler } from './$types';
import { listSkills, listOverlayNames, readOverlay } from '$lib/skills/index.js';
import { json } from '@sveltejs/kit';

/** ADR-009 Phase 4c — explicit re-scan trigger. Equivalent to GET /api/skills
 *  but POST-flavoured for UI buttons that imply an action ("Discover skills")
 *  and to give the model a clearer permissions intent than a bare GET.
 *
 *  No caching today — `listSkills()` reads the filesystem on every call,
 *  so this endpoint is idempotent. Reserved as the integration point for
 *  any future cache-invalidation logic without breaking the UI contract. */
export const POST: RequestHandler = async () => {
	const skills = listSkills();
	const overlayNames = new Set(listOverlayNames());
	const enriched = skills.map((s) => ({
		...s,
		chat_overlay: overlayNames.has(s.id) ? readOverlay(s.id) ?? null : null,
	}));
	return json({
		ok: true,
		skills: enriched,
		count: enriched.length,
		chat_invokable_count: enriched.filter((s) => s.chat_overlay?.chat_invokable).length,
	});
};
