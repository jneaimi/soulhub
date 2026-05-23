/** projects-graph ADR-006 — vault-scout edge-stale extractor (pure).
 *
 *  Walks project root `index.md` notes with non-empty `produces_for[]`,
 *  probes any RICH-form entries that carry a `destination` + `falsifier`
 *  + `falsifier_date` against `edge-flow.ts` for the newest file mtime,
 *  diffs against the per-edge snapshot store, and emits Candidates when
 *  the gap exceeds the declared falsifier window.
 *
 *  Mirrors the explicit pattern from project-phases ADR-009's unblock
 *  extractor (sibling file `vault-scout-unblock.ts`): pure aside from
 *  one injected dependency (the snapshot store), quiet first
 *  observation, single SQLite table owned in heartbeat-state.ts.
 *
 *  First observation of a (producer, consumer) edge is QUIET — the row
 *  is INSERTed with the current `last_flow_mtime` and no candidate
 *  fires. This keeps first post-deploy run noise-free even when several
 *  rich-form edges already exist in the vault. The watcher only emits
 *  on the SECOND or later observation where the edge is past its
 *  falsifier window. */

import { createHash } from 'node:crypto';
import { probeEdgeFlow } from '../../vault/edge-flow.js';

export interface EdgeSnapshot {
	producer_slug: string;
	consumer_slug: string;
	destination: string;
	last_flow_mtime: number | null;
	last_check_at: number;
}

export interface EdgeSnapshotStore {
	get(producerSlug: string, consumerSlug: string): EdgeSnapshot | null;
	upsert(row: EdgeSnapshot): void;
}

/** Producer index.md note as fed to the extractor. Pulled from the
 *  engine; only the fields the extractor needs (no full `VaultNote`
 *  surface). */
export interface ProducerIndex {
	/** Vault-relative path to the producer's root `index.md` — used as
	 *  candidate `sourcePath` and feeds the projectFolder tag. */
	path: string;
	/** Producer's project slug (extracted from `projects/<slug>/index.md`). */
	slug: string;
	/** Rich-form `produces_for` entries from frontmatter; the extractor
	 *  filters to those carrying `destination` + `falsifier` + `falsifier_date`. */
	producesFor: ReadonlyArray<{
		target: string;
		destination?: string;
		falsifier?: string;
		falsifier_date?: string;
	}>;
}

export interface EdgeStaleCandidate {
	id: string;
	producerPath: string;
	producerSlug: string;
	consumerSlug: string;
	destination: string;
	falsifier: string;
	falsifierDate: string;
	/** newest mtime observed at the destination, in ms. null = no file
	 *  ever matched (broken-from-day-zero edge). */
	lastFlowMtime: number | null;
	/** Days since `last_flow_mtime`, or Infinity when null. Drives the
	 *  candidate's stale severity in the WhatsApp surface. */
	daysStale: number;
	/** Falsifier window expressed as days. Computed from `falsifier_date`
	 *  minus `created` of the producer note, OR a default 14d fallback
	 *  per ADR-006 sample falsifier ("14 consecutive days"). */
	staleWindowDays: number;
}

export interface EdgeExtractionStats {
	producersScanned: number;
	edgesExamined: number;
	edgesFirstObserved: number;
	edgesStale: number;
	edgesMissingDestination: number;
}

export interface EdgeExtractionResult {
	candidates: EdgeStaleCandidate[];
	stats: EdgeExtractionStats;
}

function shortHash(input: string, len = 8): string {
	return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** Best-effort window-days extraction from a free-text falsifier string.
 *  Catches the literal "14 consecutive days" pattern used in the
 *  ADR-006 example; falls back to 14 days when no number found. */
function parseWindowDays(falsifier: string): number {
	const m = /(\d+)\s*(?:consecutive\s+)?day/i.exec(falsifier);
	if (m) {
		const n = parseInt(m[1], 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return 14;
}

function parseConsumerSlug(targetWikilink: string): string | null {
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(targetWikilink.trim());
	if (!m) return null;
	const inner = m[1].trim();
	const segs = inner.split('/').filter(Boolean);
	while (segs.length > 1 && /^index(\.md)?$/i.test(segs[segs.length - 1])) {
		segs.pop();
	}
	const last = segs[segs.length - 1] ?? inner;
	return last.replace(/\.md$/i, '') || null;
}

/** Pure extractor. Walks the supplied producer indexes, probes each
 *  rich-form edge against the filesystem, diffs against the store, and
 *  returns candidates whose freshness gap exceeds the declared window.
 *
 *  Side effects: `store.upsert(...)` for any edge whose snapshot differs
 *  from the current probe. */
export async function extractEdgeStaleCandidates(
	producers: ReadonlyArray<ProducerIndex>,
	store: EdgeSnapshotStore,
	now: number,
): Promise<EdgeExtractionResult> {
	const candidates: EdgeStaleCandidate[] = [];
	const stats: EdgeExtractionStats = {
		producersScanned: 0,
		edgesExamined: 0,
		edgesFirstObserved: 0,
		edgesStale: 0,
		edgesMissingDestination: 0,
	};

	for (const producer of producers) {
		const richEdges = producer.producesFor.filter(
			(e) => typeof e.destination === 'string' && e.destination.trim() !== '' &&
				typeof e.falsifier === 'string' && e.falsifier.trim() !== '' &&
				typeof e.falsifier_date === 'string' && e.falsifier_date.trim() !== '',
		);
		if (richEdges.length === 0) continue;
		stats.producersScanned += 1;

		for (const edge of richEdges) {
			const consumerSlug = parseConsumerSlug(edge.target);
			if (!consumerSlug || consumerSlug === producer.slug) {
				stats.edgesMissingDestination += 1;
				continue;
			}
			const destination = edge.destination!.trim();
			const falsifier = edge.falsifier!.trim();
			const falsifierDate = edge.falsifier_date!.trim();
			stats.edgesExamined += 1;

			const probe = await probeEdgeFlow(destination);

			const prior = store.get(producer.slug, consumerSlug);
			if (!prior) {
				// Quiet first observation. Insert and skip — operator gets
				// no candidate even if the edge is already stale.
				store.upsert({
					producer_slug: producer.slug,
					consumer_slug: consumerSlug,
					destination,
					last_flow_mtime: probe.newestMtime,
					last_check_at: now,
				});
				stats.edgesFirstObserved += 1;
				continue;
			}

			// Always update the snapshot — observation cadence matters
			// for audit even when the candidate doesn't fire.
			store.upsert({
				producer_slug: producer.slug,
				consumer_slug: consumerSlug,
				destination,
				last_flow_mtime: probe.newestMtime,
				last_check_at: now,
			});

			// Staleness check.
			const windowDays = parseWindowDays(falsifier);
			const windowMs = windowDays * 24 * 60 * 60 * 1000;
			const gapMs = probe.newestMtime === null
				? Infinity
				: now - probe.newestMtime;
			if (gapMs <= windowMs) continue;

			stats.edgesStale += 1;
			candidates.push({
				id:
					'edge-stale-' +
					shortHash(producer.slug + '|' + consumerSlug),
				producerPath: producer.path,
				producerSlug: producer.slug,
				consumerSlug,
				destination,
				falsifier,
				falsifierDate,
				lastFlowMtime: probe.newestMtime,
				daysStale: Number.isFinite(gapMs) ? Math.floor(gapMs / 86_400_000) : Number.POSITIVE_INFINITY,
				staleWindowDays: windowDays,
			});
		}
	}

	return { candidates, stats };
}
