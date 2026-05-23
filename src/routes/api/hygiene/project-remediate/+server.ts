import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import {
	archiveProject,
	setProjectStatus,
	setPauseUntil,
	touchProjectUpdated,
	scaffoldProjectIndex,
	reconcileDualStatus,
	setReviewDate,
	suppressAnomaly,
	type ActionResult,
} from '$lib/vault-hygiene/actions.js';

/** POST /api/hygiene/project-remediate — web disposition for project-hygiene
 *  anomalies (soul-hub-hygiene ADR-005 "2b").
 *
 *  Mirrors the Telegram `hyg-*` callbacks: same remediation functions, same
 *  semantics, only the trigger moves to a web POST. Dates for pause/review are
 *  computed server-side so the client only sends a verb. Destructive actions
 *  (archive) are gated by a client-side confirm on the dashboard.
 *
 *  Cross-site rejected (same guard as /api/hygiene/remediate). Vault mutations
 *  are git-revertible.
 *
 *  Body: { action, slug, bucket? }
 */

const ACTIONS = [
	'archive',
	'mark-active',
	'mark-maintained',
	'pause',
	'touch',
	'scaffold',
	'use-index',
	'use-project',
	'snooze-review',
	'mark-reviewed',
	'dismiss',
] as const;
type Action = (typeof ACTIONS)[number];

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

/** today + n days, as YYYY-MM-DD (Dubai-agnostic — date granularity only). */
function isoInDays(n: number): string {
	const d = new Date(Date.now() + n * 86_400_000);
	return d.toISOString().slice(0, 10);
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	let body: { action?: string; slug?: string; bucket?: string };
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, slug, bucket } = body;
	if (!action || !ACTIONS.includes(action as Action)) {
		return json({ ok: false, error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
	}
	if (!slug || typeof slug !== 'string') {
		return json({ ok: false, error: 'slug is required' }, { status: 400 });
	}
	if (action === 'dismiss' && (!bucket || typeof bucket !== 'string')) {
		return json({ ok: false, error: 'dismiss requires bucket' }, { status: 400 });
	}

	const engine = getVaultEngine();
	if (!engine) return json({ ok: false, error: 'vault-engine-not-ready' }, { status: 503 });
	const vaultDir = engine.vaultDir;

	try {
		let result: ActionResult;
		switch (action as Action) {
			case 'archive': {
				// Mirror the Telegram hyg-arc-y two-step: flip to `archived`
				// first so archiveProject's status guard passes, then git-mv.
				const flip = await setProjectStatus(slug, 'archived', vaultDir);
				if (!flip.ok) {
					result = flip;
					break;
				}
				result = await archiveProject(slug, vaultDir);
				break;
			}
			case 'mark-active':
				result = await setProjectStatus(slug, 'active', vaultDir);
				break;
			case 'mark-maintained':
				result = await setProjectStatus(slug, 'maintained', vaultDir);
				break;
			case 'pause':
				result = await setPauseUntil(slug, isoInDays(30), vaultDir);
				break;
			case 'touch':
				result = await touchProjectUpdated(slug, vaultDir);
				break;
			case 'scaffold':
				result = await scaffoldProjectIndex(slug, vaultDir);
				break;
			case 'use-index':
				result = await reconcileDualStatus(slug, 'index', vaultDir);
				break;
			case 'use-project':
				result = await reconcileDualStatus(slug, 'project', vaultDir);
				break;
			case 'snooze-review':
				result = await setReviewDate(slug, isoInDays(14), vaultDir);
				break;
			case 'mark-reviewed':
				result = await setReviewDate(slug, isoInDays(90), vaultDir);
				break;
			case 'dismiss':
				result = await suppressAnomaly(slug, bucket as string, 30);
				break;
		}
		return json(result);
	} catch (err) {
		return json({ ok: false, error: (err as Error).message }, { status: 500 });
	}
};
