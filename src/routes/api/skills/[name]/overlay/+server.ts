import type { RequestHandler } from './$types';
import { z } from 'zod';
import {
	writeOverlay,
	deleteOverlay,
	readOverlay,
	skillExists,
	type SkillOverlay,
} from '$lib/skills/index.js';
import { json, error } from '@sveltejs/kit';

const InvocationSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('script'),
		cmd: z.array(z.string()).min(1),
		cwd: z.string().optional(),
		timeout_ms: z.number().int().positive().optional(),
	}),
	z.object({
		kind: z.literal('prompt-injection'),
		max_bytes: z.number().int().positive().optional(),
	}),
	z.object({
		kind: z.literal('cli-subsession'),
		extra_args: z.array(z.string()).optional(),
		timeout_ms: z.number().int().positive().optional(),
	}),
]);

const OverlaySchema = z.object({
	name: z.string().min(1).max(100),
	chat_invokable: z.boolean(),
	display_name: z.string().max(100).optional(),
	chat_description: z.string().min(1).max(2000),
	invocation: InvocationSchema,
	args_schema: z.record(z.string(), z.unknown()).optional(),
	examples: z
		.array(z.object({ args: z.string(), description: z.string() }))
		.optional(),
	provenance: z.enum(['user-created', 'seed-roster', 'discovered']).optional(),
});

/** ADR-009 Phase 4c — read the overlay for one skill. Returns 404 when no
 *  overlay exists so the UI can distinguish "off" from "never configured". */
export const GET: RequestHandler = async ({ params }) => {
	const name = params.name;
	if (!name) throw error(400, 'name is required');
	const overlay = readOverlay(name);
	if (!overlay) throw error(404, `no overlay for skill "${name}"`);
	return json({ overlay });
};

/** Write the overlay. Body must validate against `OverlaySchema`. The
 *  `name` in the URL must match the body — we don't allow renaming via
 *  PUT, since the SKILL.md and the overlay file are coupled by name. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const name = params.name;
	if (!name) throw error(400, 'name is required');
	if (!skillExists(name)) {
		throw error(404, `skill "${name}" not found in ~/.claude/skills/`);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid JSON body');
	}

	const parsed = OverlaySchema.safeParse(body);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
		throw error(400, `overlay validation failed: ${issues}`);
	}
	if (parsed.data.name !== name) {
		throw error(400, `overlay.name "${parsed.data.name}" must match URL "${name}"`);
	}

	writeOverlay(parsed.data as SkillOverlay);
	return json({ ok: true, overlay: readOverlay(name) });
};

/** Idempotent un-publish — removes the overlay file. The SKILL.md is
 *  untouched; re-publishing is a fresh PUT. Returns 200 even when no
 *  overlay existed (matches DELETE semantics elsewhere in the API). */
export const DELETE: RequestHandler = async ({ params }) => {
	const name = params.name;
	if (!name) throw error(400, 'name is required');
	deleteOverlay(name);
	return json({ ok: true, name });
};
