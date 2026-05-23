/** Hygiene report orchestrator. Single entry point that the API
 *  endpoint and heartbeat hook both call. Pulls fresh data from the
 *  live vault engine — applies a 5-minute staleness guard so PM2
 *  cold-starts don't return data from before the watcher caught up
 *  (per ADR-010 open Q1 decision: trust + staleness guard). */

import { getVaultEngine } from '../vault/index.js';
import { getStaleInbox } from './stale-inbox.js';
import { getStatusContradictions } from './status-contradictions.js';
import { getMisplacedNotes } from './misplaced-notes.js';
import { getInboxDecisions } from './inbox-decisions.js';
import { computeHealthScore } from './health-score.js';
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

	const staleInbox = getStaleInbox(engine);
	const statusContradictions = getStatusContradictions(engine);
	const governanceViolationsRaw = engine.getGovernanceViolations();
	const governanceViolations = governanceViolationsRaw.map((v) => ({
		path: v.path,
		violations: v.violations,
	}));
	const misplacedNotes = getMisplacedNotes(engine);
	const inboxDecisions = getInboxDecisions();

	const totals = {
		indexed: stats.totalNotes,
		orphans: orphans.length,
		unresolved: unresolved.length,
		staleInbox: staleInbox.length,
		statusContradictions: statusContradictions.length,
		governanceViolations: governanceViolations.length,
		misplacedNotes: misplacedNotes.length,
		inboxDecisions: inboxDecisions.length,
	};

	return {
		generatedAt: new Date().toISOString(),
		totals,
		healthScore: computeHealthScore(totals),
		// Cap the issue lists in the report payload so a 458-orphan vault
		// doesn't blow up the keeper prompt or the API response. Totals
		// remain accurate; the lists are a triage sample.
		orphans: orphans.slice(0, ISSUE_LIST_CAP),
		unresolved: unresolved.slice(0, ISSUE_LIST_CAP),
		staleInbox: staleInbox.slice(0, ISSUE_LIST_CAP),
		statusContradictions: statusContradictions.slice(0, ISSUE_LIST_CAP),
		governanceViolations: governanceViolations.slice(0, ISSUE_LIST_CAP),
		misplacedNotes: misplacedNotes.slice(0, ISSUE_LIST_CAP),
		inboxDecisions: inboxDecisions.slice(0, ISSUE_LIST_CAP),
	};
}
