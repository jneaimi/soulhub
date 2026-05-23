/** Voice-queue scanner — Phase 4 / ADR-003 (amended).
 *
 *  Reads `~/vault/inbox/` for notes whose frontmatter declares
 *  `voice_eligible: true`, applies the eligibility window, filters out
 *  notes already acked, and returns the top N items sorted by priority,
 *  due-status, and creation time.
 *
 *  This is a pure read utility — it does NOT mark items acked. The
 *  consumer (heartbeat tick) decides when to ack via
 *  `markVoiceAcked(paths, 'auto')` after a successful delivery.
 *
 *  Cost: ~50 inbox notes × O(1) frontmatter access (already in memory
 *  via the vault indexer). Sub-millisecond per scan; cheap enough to
 *  call on every heartbeat tick (every 30 min) without caching.
 */

import { getVaultEngine } from './index.js';
import { getAckedPaths } from '../channels/whatsapp/heartbeat-state.js';
import type { VaultNote } from './types.js';

export type VoicePriority = 'low' | 'normal' | 'high';

export interface VoiceQueueItem {
	notePath: string;
	title: string;
	summary: string;
	priority: VoicePriority;
	dueAt: Date | null;
	createdAt: Date | null;
	bodyExcerpt: string;
}

const FRESHNESS_NO_DUE_MS = 48 * 60 * 60 * 1000; // 48h since `created`
const POST_DUE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14d after `voice_due`

const PRIORITY_RANK: Record<VoicePriority, number> = { high: 0, normal: 1, low: 2 };

/** Strict boolean parse — frontmatter YAML may surface as boolean, string
 *  ("true"/"yes"), or unset. Anything other than literal `true` or
 *  case-insensitive "true"/"yes" is false. */
function asBool(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === 'string') {
		const v = value.trim().toLowerCase();
		return v === 'true' || v === 'yes';
	}
	return false;
}

/** ISO-date or YYYY-MM-DD parse. Returns null for unparseable input so
 *  we don't crash on a malformed `voice_due:` field — those notes simply
 *  fall through to the no-due freshness window. */
function asDate(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

function asPriority(value: unknown): VoicePriority {
	if (value === 'high' || value === 'normal' || value === 'low') return value;
	return 'normal';
}

/** True if the note's frontmatter passes the eligibility window for
 *  voice-queue surfacing. Pure function — no DB access, no side effects.
 *  Exported so the smoke test can exercise edge cases without touching
 *  the vault. */
export function isWithinEligibilityWindow(
	createdAt: Date | null,
	dueAt: Date | null,
	now: Date = new Date(),
): boolean {
	const nowMs = now.getTime();
	if (dueAt) {
		const dueMs = dueAt.getTime();
		// Eligible from `dueAt` (inclusive at start of day, but strict
		// >= on millisecond is fine for our purposes — Obsidian dates
		// resolve to 00:00 local) through `dueAt + 14 days`.
		return nowMs >= dueMs && nowMs <= dueMs + POST_DUE_WINDOW_MS;
	}
	if (createdAt) {
		return nowMs - createdAt.getTime() <= FRESHNESS_NO_DUE_MS;
	}
	// No created date → can't establish recency; refuse to surface.
	// Producers writing voice_eligible:true MUST also set `created` per
	// vault inbox/CLAUDE.md ("Required Fields: type, created, tags").
	return false;
}

function noteToItem(note: VaultNote): VoiceQueueItem | null {
	const m = note.meta;
	if (!asBool(m.voice_eligible)) return null;

	const createdAt = asDate(m.created);
	const dueAt = asDate(m.voice_due);

	const summaryRaw = typeof m.voice_summary === 'string' ? m.voice_summary.trim() : '';
	// Fallback: first non-blank line of body, capped to 200 chars (per
	// ADR-003 open-question vote: "first sentence — keeps WhatsApp short").
	const fallback = note.content
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith('#') && l !== '---') ?? '';
	const summary = (summaryRaw || fallback).slice(0, 200);

	const priority = asPriority(m.voice_priority);
	const bodyExcerpt = note.content.slice(0, 500);

	return {
		notePath: note.path,
		title: note.title,
		summary,
		priority,
		dueAt,
		createdAt,
		bodyExcerpt,
	};
}

/** Sort: priority (high first), then due-passed before non-due, then
 *  most-recent created first. Stable wrt original order beyond that. */
function sortItems(items: VoiceQueueItem[], now: Date): VoiceQueueItem[] {
	const nowMs = now.getTime();
	return items.slice().sort((a, b) => {
		const pa = PRIORITY_RANK[a.priority];
		const pb = PRIORITY_RANK[b.priority];
		if (pa !== pb) return pa - pb;

		// "Due-passed" tier: dueAt ≤ now sorts before items with no dueAt
		// (which sort before items with dueAt > now — but those are filtered
		// out upstream by isWithinEligibilityWindow, so we shouldn't see
		// them here in practice).
		const aDuePassed = a.dueAt ? a.dueAt.getTime() <= nowMs : false;
		const bDuePassed = b.dueAt ? b.dueAt.getTime() <= nowMs : false;
		if (aDuePassed !== bDuePassed) return aDuePassed ? -1 : 1;

		const aCreated = a.createdAt?.getTime() ?? 0;
		const bCreated = b.createdAt?.getTime() ?? 0;
		return bCreated - aCreated;
	});
}

export interface ScanOptions {
	now?: Date;
	limit?: number;
}

/** Top N voice-eligible inbox notes ready to surface. Empty array when:
 *
 *   - vault engine isn't initialised (server still booting)
 *   - no inbox notes have `voice_eligible: true`
 *   - all eligible notes are outside their freshness window
 *   - all eligible notes are already in voice_acks
 */
export function getEligibleVoiceItems(opts: ScanOptions = {}): VoiceQueueItem[] {
	const engine = getVaultEngine();
	if (!engine) return [];
	const now = opts.now ?? new Date();
	const limit = opts.limit ?? 5;

	// VaultEngine doesn't expose `indexer.all()` directly; `getRecent(N)`
	// returns the same set, sorted by mtime desc. Vault has ~1k notes
	// total — overscan is cheap. Filter to inbox/ here.
	const all = engine.getRecent(10000).filter((n) => n.path.startsWith('inbox/'));

	const candidates: VoiceQueueItem[] = [];
	for (const note of all) {
		const item = noteToItem(note);
		if (!item) continue;
		if (!isWithinEligibilityWindow(item.createdAt, item.dueAt, now)) continue;
		candidates.push(item);
	}

	if (candidates.length === 0) return [];

	const ackedSet = getAckedPaths(candidates.map((c) => c.notePath));
	const fresh = candidates.filter((c) => !ackedSet.has(c.notePath));

	return sortItems(fresh, now).slice(0, limit);
}

// Test seam: re-export the pure-function so smoke tests can call it
// without an initialised vault.
export { noteToItem as _noteToItem };
