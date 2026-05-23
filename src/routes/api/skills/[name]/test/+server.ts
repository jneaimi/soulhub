import type { RequestHandler } from './$types';
import { z } from 'zod';
import { runSkill, getChatSkill } from '$lib/skills/index.js';
import { json, error } from '@sveltejs/kit';

const TestRequestSchema = z.object({
	args: z.unknown().optional(),
});

/** ADR-009 Phase 4c — run a chat-invokable skill with sample args and return
 *  captured stdout + duration. The skill must already have a chat-invokable
 *  overlay (security: can't run arbitrary skills via this endpoint). For
 *  prompt-injection skills the response is the SKILL.md body that would be
 *  threaded back to the orchestrator; for script skills it's stdout. */
export const POST: RequestHandler = async ({ params, request }) => {
	const name = params.name;
	if (!name) throw error(400, 'name is required');

	const entry = getChatSkill(name);
	if (!entry) {
		throw error(
			404,
			`skill "${name}" is not chat-invokable — write an overlay with chat_invokable: true first`,
		);
	}

	let body: unknown = {};
	if (request.headers.get('content-length') !== '0') {
		try {
			body = await request.json();
		} catch {
			// Empty body is fine — many prompt-injection skills don't need args.
			body = {};
		}
	}
	const parsed = TestRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw error(400, 'invalid request body');
	}

	const result = await runSkill(name, parsed.data.args);
	return json(result);
};
