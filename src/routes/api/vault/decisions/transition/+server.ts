/** POST /api/vault/decisions/transition — flip a decision's status frontmatter.
 *
 *  Per ADR-037 Phase 2 + Phase 3a. Wraps `engine.updateNote` with a small policy:
 *    - accept  (proposed → accepted)  → status, accepted_on: <today>
 *    - reject  (proposed → rejected)  → status, rejected_on: <today>, reason required
 *    - park    (proposed → parked)    → status, parked_on: <today>, review_after optional
 *    - ship    (accepted → shipped)   → status, shipped_on: <today>            [Phase 3a]
 *
 *  Body: { path: string, action: 'accept' | 'reject' | 'park' | 'ship',
 *          reason?: string, reviewAfter?: string (YYYY-MM-DD) }
 *
 *  Returns: { success: true, path, newStatus } or { success: false, error }.
 *  Engine.updateNote re-validates frontmatter, writes via temp-file rename,
 *  re-indexes, and enqueues a vault git commit (per ADR-019). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { getAgent } from '$lib/agents/store.js';

type Action = 'accept' | 'reject' | 'park' | 'ship';

const ACTION_TO_STATUS: Record<Action, string> = {
	accept: 'accepted',
	reject: 'rejected',
	park: 'parked',
	ship: 'shipped',
};

/** projects-graph ADR-017 P3 — the canonical-6 lifecycle (and this endpoint's
 *  source-status guards) apply to any typed artifact, not just decisions.
 *  Tasks/risks/metrics/posts share the vocab (operator decision 2026-05-21),
 *  so they transition through the same endpoint. Types NOT in this set are
 *  refused — the lifecycle isn't meaningful for `index`/`reference`/etc. */
// projects-graph ADR-021 — design + requirements added in lock-step with the
// worklist's ACTIONABLE_TYPES, so any artifact that can surface in a lane can
// also have its status edited from the drawer.
const TRANSITIONABLE_TYPES = new Set([
	'decision',
	'task',
	'risk',
	'metric',
	'post',
	'design',
	'requirements',
]);

/** Per-action source status guard. accept/reject/park require `proposed`;
 *  ship requires `accepted`. */
const ACTION_FROM_STATUS: Record<Action, string> = {
	accept: 'proposed',
	reject: 'proposed',
	park: 'proposed',
	ship: 'accepted',
};

function todayIso(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ success: false, error: 'Vault not initialized' }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { path, action, reason, reviewAfter, assignee } = body as Record<string, unknown>;

	if (typeof path !== 'string' || !path) {
		return json({ success: false, error: 'path is required' }, { status: 400 });
	}
	// Path safety — only vault notes, no traversal
	if (path.includes('..') || path.startsWith('/') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}

	if (typeof action !== 'string' || !(action in ACTION_TO_STATUS)) {
		return json(
			{ success: false, error: `action must be one of: ${Object.keys(ACTION_TO_STATUS).join(', ')}` },
			{ status: 400 },
		);
	}

	const existing = engine.getNote(path);
	if (!existing) {
		return json({ success: false, error: `Note not found: ${path}` }, { status: 404 });
	}
	if (!TRANSITIONABLE_TYPES.has(String(existing.meta.type ?? ''))) {
		return json(
			{
				success: false,
				error: `Type '${existing.meta.type}' has no lifecycle (allowed: ${[...TRANSITIONABLE_TYPES].join(', ')})`,
			},
			{ status: 400 },
		);
	}
	const currentStatus = String(existing.meta.status ?? '').toLowerCase();
	const requiredFrom = ACTION_FROM_STATUS[action as Action];
	if (currentStatus !== requiredFrom) {
		return json(
			{
				success: false,
				error: `${action} requires status '${requiredFrom}' (current: ${currentStatus || 'none'})`,
			},
			{ status: 409 },
		);
	}

	const newStatus = ACTION_TO_STATUS[action as Action];
	const today = todayIso();

	const metaPatch: Record<string, unknown> = { status: newStatus };
	if (action === 'accept') {
		metaPatch.accepted_on = today;
		// "Accept & hand to AI" (soul-hub-governance — the dispose→execute handoff):
		// optionally set ownership to an AI agent so the worklist moves the item
		// from ready_for_you → ready_for_ai. Validated against the live roster so a
		// typo'd assignee can't silently classify as human/unassigned.
		if (typeof assignee === 'string' && assignee.trim()) {
			const agentId = assignee.trim().toLowerCase();
			if (!getAgent(agentId)) {
				return json({ success: false, error: `unknown agent: ${agentId}` }, { status: 400 });
			}
			metaPatch.assignee = agentId;
		}
	} else if (action === 'ship') {
		metaPatch.shipped_on = today;
	} else if (action === 'reject') {
		if (typeof reason !== 'string' || !reason.trim()) {
			return json(
				{ success: false, error: 'reason is required for reject action' },
				{ status: 400 },
			);
		}
		metaPatch.rejected_on = today;
		metaPatch.rejection_reason = reason.trim();
	} else if (action === 'park') {
		metaPatch.parked_on = today;
		if (typeof reviewAfter === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reviewAfter)) {
			metaPatch.review_after = reviewAfter;
		}
		if (typeof reason === 'string' && reason.trim()) {
			metaPatch.park_reason = reason.trim();
		}
	}

	const result = await engine.updateNote(path, { meta: metaPatch });
	if (!result.success) {
		return json({ success: false, error: result.error }, { status: 500 });
	}

	return json({ success: true, path, newStatus });
};
