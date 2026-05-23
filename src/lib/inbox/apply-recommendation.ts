/** Phase C — operator accept/advise loop for stuck-transactional mail.
 *
 *  The keeper agent surfaces stuck-unknown transactional rows with a
 *  recommendation object (kind/zone/tags/confidence/reasoning). The
 *  operator replies "accept #N" or "advise #N: kind=X, zone=Y, tag=Z, ..."
 *  to apply the recommendation. This module is the load-bearing apply
 *  step — it patches extracted_data, optionally calls routeMessageToVault
 *  with the chosen zone/tags, and records the action so the keeper's
 *  next tick doesn't re-surface the same row.
 *
 *  Two action modes:
 *    - `'route'` (default): rewrite extract.kind to the chosen kind,
 *      then call routeMessageToVault. Operator-driven → bypasses the
 *      per-tick worker cap, fires immediately. Marks processed on
 *      success.
 *    - `'archive'`: skip the vault write entirely, just mark processed.
 *      For "this is junk, don't save it" cases (mail bounces, etc.).
 *
 *  Audit: writes an `agent_actions` row with
 *  `actor='operator-direct', tool='inbox-apply-recommendation'` so the
 *  audit trail distinguishes operator decisions from worker auto-routes.
 */

import { getMessage, markMessageProcessed, recordAgentAction, setExtractedData } from './db.js';
import { routeMessageToVault } from './route-to-vault.js';
import type { TransactionalExtract } from './extractor.js';

export interface ApplyRecommendationInput {
	messageId: number;
	/** Action — 'route' (default) saves to vault; 'archive' marks processed
	 *  without saving (for junk/bounces/etc). */
	action?: 'route' | 'archive';
	/** Override the recommendation's kind. Falls back to the existing
	 *  extracted_data.kind, or 'unknown' if nothing available. */
	kind?: string;
	/** Override the recommendation's zone. Falls back to pickZone() output
	 *  given the (possibly-overridden) kind. */
	zone?: string;
	/** Additional tags to merge into composeNote's defaults. */
	tags?: string[];
	/** Optional human reason for audit ("operator accepted recommendation"
	 *  or "operator advised correction: was=unknown, now=statement"). */
	reason?: string;
}

export interface ApplyRecommendationResult {
	ok: boolean;
	messageId: number;
	action: 'route' | 'archive';
	vaultPath?: string;
	openUrl?: string;
	error?: string;
}

export async function applyRecommendation(input: ApplyRecommendationInput): Promise<ApplyRecommendationResult> {
	const messageId = input.messageId;
	const action = input.action ?? 'route';
	const auditReason = input.reason ?? `operator.${action}`;

	const message = getMessage(messageId);
	if (!message) {
		const result: ApplyRecommendationResult = {
			ok: false,
			messageId,
			action,
			error: `Message ${messageId} not found.`,
		};
		recordAgentAction({
			tool: 'inbox-apply-recommendation',
			messageId,
			actor: 'operator-direct',
			args: { action, reason: auditReason, override: { kind: input.kind, zone: input.zone, tags: input.tags } },
			result,
		});
		return result;
	}

	if (message.processStatus === 'processed') {
		return {
			ok: true,
			messageId,
			action,
			error: 'already-processed (idempotent)',
		};
	}

	// ARCHIVE — no vault save, just mark processed.
	if (action === 'archive') {
		try {
			markMessageProcessed(messageId);
			const result: ApplyRecommendationResult = { ok: true, messageId, action: 'archive' };
			recordAgentAction({
				tool: 'inbox-apply-recommendation',
				messageId,
				actor: 'operator-direct',
				args: { action, reason: auditReason },
				result,
			});
			return result;
		} catch (err) {
			const result: ApplyRecommendationResult = {
				ok: false,
				messageId,
				action: 'archive',
				error: (err as Error).message,
			};
			recordAgentAction({
				tool: 'inbox-apply-recommendation',
				messageId,
				actor: 'operator-direct',
				args: { action, reason: auditReason },
				result,
			});
			return result;
		}
	}

	// ROUTE — patch extracted_data.kind if the operator (or the
	// recommendation) chose a kind different from what's cached, then
	// invoke routeMessageToVault. The worker's `pickZone()` will read the
	// updated kind on its own; if the operator also overrode `zone` or
	// `tags`, we don't have a clean way to pipe those into the worker
	// today — but the L3 ship promotes them to first-class params here.
	const currentExtract = parseExtractedData(message);
	const targetKind = input.kind ?? currentExtract?.kind ?? 'unknown';
	if (targetKind !== currentExtract?.kind) {
		const patched: TransactionalExtract = {
			...(currentExtract ?? { kind: 'unknown' }),
			kind: targetKind as TransactionalExtract['kind'],
		};
		setExtractedData(messageId, patched);
	}

	try {
		const routeResult = await routeMessageToVault(messageId, {
			actor: 'operator-direct',
			reason: auditReason,
			// Operator overrides win over pickZone() — only when supplied.
			zoneOverride: input.zone,
			extraTags: input.tags,
		});

		const result: ApplyRecommendationResult = {
			ok: routeResult.ok,
			messageId,
			action: 'route',
			vaultPath: routeResult.vaultPath,
			openUrl: routeResult.openUrl,
			error: routeResult.error,
		};
		recordAgentAction({
			tool: 'inbox-apply-recommendation',
			messageId,
			actor: 'operator-direct',
			args: { action, reason: auditReason, override: { kind: input.kind, zone: input.zone, tags: input.tags } },
			result,
		});
		return result;
	} catch (err) {
		const result: ApplyRecommendationResult = {
			ok: false,
			messageId,
			action: 'route',
			error: (err as Error).message,
		};
		recordAgentAction({
			tool: 'inbox-apply-recommendation',
			messageId,
			actor: 'operator-direct',
			args: { action, reason: auditReason, override: { kind: input.kind, zone: input.zone, tags: input.tags } },
			result,
		});
		return result;
	}
}

function parseExtractedData(message: { extractedData: string | null }): TransactionalExtract | null {
	if (!message.extractedData) return null;
	try {
		const parsed = JSON.parse(message.extractedData) as TransactionalExtract;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}
