/** Hygiene report orchestrator. Single entry point that the API
 *  endpoint and heartbeat hook both call. Pulls fresh data from the
 *  live vault engine — applies a 5-minute staleness guard so PM2
 *  cold-starts don't return data from before the watcher caught up
 *  (per ADR-010 open Q1 decision: trust + staleness guard).
 *
 *  ADR-006 P1.0 — the report now filters suppressed items before returning
 *  them. Suppression keys use the 4-consumer cross-language contract
 *  (actions.ts write / vault-escalator.ts TS read / project_hygiene.py
 *  Python read / this reader). Key schema:
 *    unresolved bucket → composite `${source}::${raw}` (vaultHygieneKeyFor)
 *    all other buckets → bare note path
 *  An expired suppression (until <= today) must NOT hide the item. */

import { getVaultEngine } from '../vault/index.js';
import { getStaleInbox } from './stale-inbox.js';
import { getStatusContradictions } from './status-contradictions.js';
import { getMisplacedNotes } from './misplaced-notes.js';
import { getInboxDecisions } from './inbox-decisions.js';
import { getAdrImplementationDrift } from './adr-implementation-drift.js';
import { computeHealthScore } from './health-score.js';
import { loadSuppressedKeys, vaultHygieneKeyFor } from './suppression-reader.js';
import { ISSUE_LIST_CAP } from './types.js';
import type { HygieneReport, OrphanIssue, UnresolvedIssue } from './types.js';

const INDEX_STALENESS_MS = 5 * 60 * 1000;

export async function getHygieneReport(): Promise<HygieneReport> {
	const engine = getVaultEngine();
	if (!engine) {
		throw new Error('Vault engine not initialized');
	}

	// Staleness guard. The watcher keeps the index live in steady state;
	// after a cold start there can be a multi-second window where the
	// scan hasn't completed. We don't have a public reindex hook on the
	// engine, so we just inspect lastIndexed and warn if stale rather
	// than block — the report still has the watcher's current view.
	const stats = engine.getStats();
	const indexedAt = Date.parse(stats.lastIndexed);
	if (!Number.isNaN(indexedAt) && Date.now() - indexedAt > INDEX_STALENESS_MS) {
		console.warn(
			`[vault-hygiene] index last refreshed ${Math.round((Date.now() - indexedAt) / 1000)}s ago — report may lag`,
		);
	}

	const orphansRaw = engine.getOrphans();
	const orphans: OrphanIssue[] = orphansRaw
		// Match the indexer's orphan-exempt rules: inbox/archive zones,
		// index files, and session logs are NOT considered orphans for
		// hygiene purposes.
		.filter((n) => {
			const zone = n.path.split('/')[0];
			if (zone === 'inbox' || zone === 'archive') return false;
			if (n.path.endsWith('/index.md') || n.path === 'index.md') return false;
			if (n.meta.type === 'session-log') return false;
			return true;
		})
		.map((n) => ({
			path: n.path,
			title: n.title,
			suggestedFix: `Add to nearest index.md: \`- [[${n.path.replace(/\.md$/, '')}|${n.title}]]\``,
		}));

	const unresolvedRaw = engine.getUnresolved();
	// Mirror the orphan filter (line 44) — `archive/` is frozen historical
	// content. Wikilinks inside archive notes that point at since-deleted
	// projects are cosmetic noise, not operational debt: the operator can't
	// "fix" them without rewriting frozen records, and they don't impact
	// any live surface. Skipping them keeps the report's signal-to-noise
	// usable. `inbox/` notes are also transient — same rationale.
	// `operations/hygiene/` reports are frozen heartbeat snapshots (this
	// generator's own past output) — they describe state at a moment in
	// time, so a wikilink to a since-deleted project is a faithful
	// record, not a fix-it.
	const unresolved: UnresolvedIssue[] = unresolvedRaw
		.filter((u) => {
			const zone = u.source.split('/')[0];
			if (zone === 'archive' || zone === 'inbox') return false;
			if (u.source.startsWith('operations/hygiene/')) return false;
			return true;
		})
		.map((u) => ({
			source: u.source,
			raw: u.raw,
			suggestedFix: `Fuzzy-match \`${u.raw}\` against vault titles in \`${u.source}\` directory; correct the link or remove the line.`,
		}));

	const staleInboxRaw = getStaleInbox(engine);
	const statusContradictionsRaw = getStatusContradictions(engine);
	const governanceViolationsRaw = engine.getGovernanceViolations();
	const governanceViolations = governanceViolationsRaw.map((v) => ({
		path: v.path,
		violations: v.violations,
	}));
	const misplacedNotesRaw = getMisplacedNotes(engine);
	const inboxDecisions = getInboxDecisions();
	// ADR-009 — async git check; runs a single bounded `git log main` call.
	// Failures are caught inside getAdrImplementationDrift (returns []).
	const adrImplementationDriftRaw = await getAdrImplementationDrift(engine);

	// ADR-006 P1.0 — load active suppressions for every actionable bucket so
	// dismissed items disappear from the report until their suppression expires.
	// Failures are silently swallowed (empty Set) so a missing suppressions file
	// never breaks the report. All six bucket loads run in parallel.
	const [
		suppressedOrphans,
		suppressedUnresolved,
		suppressedStale,
		suppressedStatus,
		suppressedMisplaced,
		suppressedImplDrift,
	] = await Promise.all([
		loadSuppressedKeys('orphan_note'),
		loadSuppressedKeys('unresolved'),
		loadSuppressedKeys('stale_inbox_item'),
		loadSuppressedKeys('status_contradiction'),
		loadSuppressedKeys('misplaced_note'),
		loadSuppressedKeys('adr_implementation_drift'),
	]);

	// Apply suppression filters. Keys match the 4-consumer cross-language
	// contract: `${source}::${raw}` for unresolved (vaultHygieneKeyFor),
	// bare path for every other bucket.
	const orphansFiltered = orphans.filter((o) => !suppressedOrphans.has(o.path));
	const unresolvedFiltered = unresolved.filter(
		(u) => !suppressedUnresolved.has(vaultHygieneKeyFor(u.source, u.raw)),
	);
	const staleInbox = staleInboxRaw.filter((s) => !suppressedStale.has(s.path));
	const statusContradictions = statusContradictionsRaw.filter(
		(sc) => !suppressedStatus.has(sc.path),
	);
	const misplacedNotes = misplacedNotesRaw.filter((m) => !suppressedMisplaced.has(m.path));
	// ADR-009 — bare path key (same as orphan/stale/status_contradiction buckets).
	const adrImplementationDrift = adrImplementationDriftRaw.filter(
		(d) => !suppressedImplDrift.has(d.path),
	);

	const totals = {
		indexed: stats.totalNotes,
		orphans: orphansFiltered.length,
		unresolved: unresolvedFiltered.length,
		staleInbox: staleInbox.length,
		statusContradictions: statusContradictions.length,
		governanceViolations: governanceViolations.length,
		misplacedNotes: misplacedNotes.length,
		inboxDecisions: inboxDecisions.length,
		adrImplementationDrift: adrImplementationDrift.length,
	};

	return {
		generatedAt: new Date().toISOString(),
		totals,
		healthScore: computeHealthScore(totals),
		// Cap the issue lists in the report payload so a 458-orphan vault
		// doesn't blow up the keeper prompt or the API response. Totals
		// remain accurate; the lists are a triage sample.
		orphans: orphansFiltered.slice(0, ISSUE_LIST_CAP),
		unresolved: unresolvedFiltered.slice(0, ISSUE_LIST_CAP),
		staleInbox: staleInbox.slice(0, ISSUE_LIST_CAP),
		statusContradictions: statusContradictions.slice(0, ISSUE_LIST_CAP),
		governanceViolations: governanceViolations.slice(0, ISSUE_LIST_CAP),
		misplacedNotes: misplacedNotes.slice(0, ISSUE_LIST_CAP),
		inboxDecisions: inboxDecisions.slice(0, ISSUE_LIST_CAP),
		adrImplementationDrift: adrImplementationDrift.slice(0, ISSUE_LIST_CAP),
	};
}
