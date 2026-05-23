import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	correctClassification,
	type FilterCategory,
} from '$lib/inbox/index.js';

const VALID_CATEGORIES: readonly FilterCategory[] = [
	'personal',
	'transactional',
	'notification',
	'promotional',
	'bulk',
	'unclassified',
];

/**
 * POST /api/inbox/messages/[id]/recategorize
 *
 * Body: { category: FilterCategory, scope?: 'this' | 'pattern', reason?: string }
 *
 * Updates the message's classification, writes the user-corrected entry to
 * filter_cache, and (if scope='pattern', the default) re-classifies all sibling
 * messages in 'new' or 'skipped' state with the same cache signature.
 * Returns the number of sibling rows updated.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const messageId = Number(params.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		return json({ error: 'invalid message id' }, { status: 400 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const input = body as Partial<{ category: string; scope: 'this' | 'pattern'; reason: string }>;
	const category = input.category;
	if (!category || !(VALID_CATEGORIES as readonly string[]).includes(category)) {
		return json(
			{ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` },
			{ status: 400 },
		);
	}
	const scope = input.scope === 'this' ? 'this' : 'pattern';

	const result = correctClassification(messageId, {
		category: category as FilterCategory,
		scope,
		reason: input.reason,
	});

	if (!result.ok) {
		return json(
			{ error: result.reason ?? 'unknown', messageId },
			{ status: result.reason === 'not_found' ? 404 : 500 },
		);
	}

	return json({
		ok: true,
		messageId,
		category,
		scope,
		siblingsUpdated: result.siblingsUpdated,
	});
};
