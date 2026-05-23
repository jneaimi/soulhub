import type { RequestHandler } from './$types';
import {
	listSkills,
	listOverlayNames,
	readOverlay,
	skillsDir,
} from '$lib/skills/index.js';
import { json } from '@sveltejs/kit';

/** ADR-009 Phase 4c — list all discovered skills + their chat overlay state.
 *  The UI uses a single GET to render both the installed-skills surface and
 *  the chat-invokable filter. Skills with no overlay get `chat_overlay: null`
 *  and are invisible to the v2 orchestrator. */
export const GET: RequestHandler = async () => {
	const skills = listSkills();
	const overlayNames = new Set(listOverlayNames());
	const enriched = skills.map((s) => ({
		...s,
		chat_overlay: overlayNames.has(s.id) ? readOverlay(s.id) ?? null : null,
	}));
	return json({
		skills: enriched,
		dir: skillsDir(),
		count: enriched.length,
		chat_invokable_count: enriched.filter((s) => s.chat_overlay?.chat_invokable).length,
	});
};
