/** Deterministic vault-hygiene janitor pass (ADR-008 step 2).
 *
 *  Replaces the keeper agent's auto-fix job (Job A in ADR-008) on the
 *  every-30-min heartbeat. Three operations — each requires zero LLM
 *  judgment, so they run unattended as deterministic code:
 *
 *    A1. Orphans → add to nearest index.md (`healOrphans`)
 *    A2. Stale inbox notes with valid `type` → move to canonical zone
 *    A3. Governance violations: missing-but-derivable `created` field → backfill
 *        (`healMissingFrontmatter`)
 *
 *  Job B (dead-link retarget, ambiguous-misplaced, flip-vs-tick) is handled
 *  by the PTY `hygiene-fixer` agent (ADR-007) on demand.
 *  Job C (escalate / daily digest) is already deterministic and stays.
 *
 *  Receives the pre-built `HygieneReport` so the caller controls report
 *  freshness and can skip the janitor when the report is empty (cooldown).
 */

import { getVaultEngine } from '$lib/vault/index.js';
import { healOrphans, healMissingFrontmatter } from '$lib/system/healers/vault-healer.js';
import type { HygieneReport } from './types.js';

export interface JanitorResult {
	orphansFixed: number;
	inboxFiled: number;
	frontmatterBackfilled: number;
	errors: number;
	skipped: number;
	summary: string;
}

/** Map of note type → canonical zone for stale-inbox auto-move.
 *  Must stay in sync with `zoneForType` in stale-inbox.ts — kept here
 *  as a plain object to avoid a circular import (janitor ← stale-inbox
 *  would create a loop through heartbeat-tick). */
const INBOX_TYPE_TO_ZONE: Record<string, string> = {
	learning: 'knowledge/learnings',
	pattern: 'knowledge/patterns',
	snippet: 'knowledge/snippets',
	debugging: 'knowledge/debugging',
	recipe: 'knowledge/cooking/recipes',
	project: 'projects',
	decision: 'projects',
	research: 'knowledge/research',
};

/** Run the deterministic auto-fix pass over the given hygiene report.
 *
 *  Side-effects: vault file writes (orphan link additions, inbox moves,
 *  frontmatter patches). All writes are git-tracked by the vault committer
 *  (engine writes) or the vault watcher (healer's direct fs writes).
 *
 *  Returns immediately with an empty result when the vault engine is
 *  unavailable — caller logs and continues. */
export async function runJanitorPass(report: HygieneReport): Promise<JanitorResult> {
	const result: JanitorResult = {
		orphansFixed: 0,
		inboxFiled: 0,
		frontmatterBackfilled: 0,
		errors: 0,
		skipped: 0,
		summary: '',
	};

	const engine = getVaultEngine();
	if (!engine) {
		result.summary = 'vault engine unavailable — janitor skipped';
		return result;
	}

	const vaultDir = engine.vaultDir;
	const allNotes = engine.getAllNotes();

	// ── A1: Orphans → add to nearest index.md ──────────────────────────────
	if (report.orphans.length > 0) {
		// Resolve the orphan paths back to full VaultNote objects. Orphans that
		// the engine no longer knows about (stale report) are silently skipped.
		const orphanNotes = report.orphans
			.map((o) => engine.getNote(o.path))
			.filter((n): n is NonNullable<typeof n> => n !== undefined);

		if (orphanNotes.length > 0) {
			const heal = await healOrphans(vaultDir, orphanNotes, allNotes);
			result.orphansFixed = heal.fixed.length;
			result.skipped += heal.skipped.length;
			result.errors += heal.errors.length;
		}
	}

	// ── A2: Stale inbox with valid type → move to canonical zone ───────────
	if (report.staleInbox.length > 0) {
		const toMove = report.staleInbox.filter((issue) => {
			const note = engine.getNote(issue.path);
			const type = note?.meta?.type;
			return typeof type === 'string' && Boolean(INBOX_TYPE_TO_ZONE[type]);
		});

		for (const issue of toMove) {
			const note = engine.getNote(issue.path);
			const type = note?.meta?.type as string;
			const zone = INBOX_TYPE_TO_ZONE[type];
			if (!zone) continue;
			try {
				const moveResult = await engine.moveNote(issue.path, zone);
				if (moveResult.success) {
					result.inboxFiled++;
				} else {
					result.errors++;
					console.warn(
						`[vault-hygiene/janitor] move failed for ${issue.path}: ${(moveResult as { error?: string }).error ?? 'unknown'}`,
					);
				}
			} catch (err) {
				result.errors++;
				console.warn(
					`[vault-hygiene/janitor] move error for ${issue.path}: ${(err as Error).message}`,
				);
			}
		}
	}

	// ── A3: Governance violations — backfill derivable `created` field ──────
	// healMissingFrontmatter filters allNotes internally for missing `created`.
	// Cap + per-run limit are owned by the healer (50 items/run).
	const frontmatterHeal = await healMissingFrontmatter(vaultDir, allNotes);
	result.frontmatterBackfilled = frontmatterHeal.fixed.length;
	result.skipped += frontmatterHeal.skipped.length;
	result.errors += frontmatterHeal.errors.length;

	// ── Summary ─────────────────────────────────────────────────────────────
	const total = result.orphansFixed + result.inboxFiled + result.frontmatterBackfilled;
	result.summary = total > 0
		? `auto-fixed ${total} (orphans-linked: ${result.orphansFixed}, inbox-filed: ${result.inboxFiled}, frontmatter: ${result.frontmatterBackfilled}), errors: ${result.errors}, skipped: ${result.skipped}`
		: `no auto-fixes needed, errors: ${result.errors}`;

	return result;
}
