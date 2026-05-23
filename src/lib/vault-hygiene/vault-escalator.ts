/** ADR-043 — vault-hygiene inline-button escalator.
 *
 *  Reads the fresh hygiene report from `getHygieneReport()` directly
 *  (no markdown digest middle-step, unlike project-hygiene's escalator).
 *  Emits one Telegram message per actionable anomaly with the
 *  appropriate bucket-aware keyboard from `callback.ts`.
 *
 *  Pass 2 scope: three vault-hygiene buckets.
 *   - `unresolved` (broken wikilink) → 🗑 Unlink · 🔇 Ignore 30d
 *   - `orphan_note`                  → 📦 Archive · 🔇 Ignore 30d
 *   - `stale_inbox_item`             → 🗑 Drop · 🔇 Ignore 30d
 *  Link-up (orphan → parent) and Move-to-vault (stale → destination)
 *  both need operator-picked targets; deferred to a sibling ADR for
 *  the multi-step picker flow.
 *
 *  Triggers:
 *   - Manual: `POST /api/hygiene/vault-escalate-buttons` (any time)
 *   - Auto:   `heartbeat-tick.ts` fires after the keeper dispatch
 *
 *  Suppression: shares `~/.soul-hub/data/hygiene-suppressions.json`
 *  with project-hygiene. Per-bucket key shape:
 *   - unresolved        → `${source}::${raw}` (per-link)
 *   - orphan_note       → notePath
 *   - stale_inbox_item  → notePath
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sendText } from '../channels/telegram/outbound.js';
import {
	buildFixBatchKeyboard,
	buildVaultHygieneOrphanKeyboard,
	buildVaultHygieneStaleInboxKeyboard,
	hasPendingVaultHygiene,
	rememberFixBatch,
	rememberVaultHygieneButtons,
} from '../channels/telegram/callback.js';
import { formatAggregateDigest } from './link-fix-payload.js';
import { config as soulHubConfig } from '../config.js';
import { getVaultEngine } from '../vault/index.js';
import { getStaleInbox } from './stale-inbox.js';
import type { OrphanIssue, StaleInboxIssue, UnresolvedIssue } from './types.js';

/** Per-bucket emission caps. Each bucket gets its own slice so a
 *  high-volume bucket (`unresolved` regularly sits at 100+ entries)
 *  can't starve rarer buckets (`orphan_note`, `stale_inbox_item`).
 *  Caps are applied AFTER suppression so the operator only sees
 *  actionable rows, not noise they've already ignored. */
const BUCKET_CAPS: Record<string, number> = {
	orphan_note: 5,
	stale_inbox_item: 5,
	unresolved: 10,
};

const SUPPRESSIONS_PATH = join(homedir(), '.soul-hub', 'data', 'hygiene-suppressions.json');

export interface VaultEscalationResult {
	ok: boolean;
	totalRows?: number;
	sent?: number;
	skipped?: number;
	failures?: { source: string; raw: string; error: string }[];
	byBucket?: Record<string, { totalRows: number; sent: number; skipped: number }>;
	error?: string;
}

interface SuppressionEntry {
	slug?: string;
	key?: string;
	bucket: string;
	until: string;
}

/** Build the composite key for a broken-link suppression. Uses the
 *  source path + literal raw text so multiple broken links in the
 *  same file can be suppressed independently. */
export function vaultHygieneKeyFor(source: string, raw: string): string {
	return `${source}::${raw}`;
}

async function loadActiveSuppressions(bucket: string): Promise<Set<string>> {
	try {
		const text = await readFile(SUPPRESSIONS_PATH, 'utf-8');
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return new Set();
		const today = new Date().toISOString().slice(0, 10);
		const active = new Set<string>();
		for (const entry of parsed as SuppressionEntry[]) {
			if (entry?.bucket !== bucket) continue;
			if (typeof entry.until !== 'string') continue;
			if (entry.until <= today) continue;
			const key = entry.key ?? entry.slug;
			if (typeof key === 'string') active.add(key);
		}
		return active;
	} catch {
		return new Set();
	}
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

function formatUnresolvedMessage(issue: UnresolvedIssue): string {
	return (
		`🔗 *Broken wikilink* — \`${issue.source}\`\n\n` +
		`\`[[${issue.raw}]]\` doesn't resolve. Tap *🗑 Unlink* to replace the link with its ` +
		`display text in place (reversible via git), or *🔇 Ignore* to suppress for 30 days.`
	);
}

function formatOrphanMessage(issue: OrphanIssue): string {
	const titlePart = issue.title ? ` *${issue.title}*` : '';
	return (
		`🧩 *Orphan note*${titlePart} — \`${issue.path}\`\n\n` +
		`No incoming or outgoing wikilinks. Either link it up manually, archive it ` +
		`to remove the clutter, or ignore for 30 days.`
	);
}

function formatStaleInboxMessage(issue: StaleInboxIssue): string {
	const titlePart = issue.title ? ` *${issue.title}*` : '';
	return (
		`📥 *Stale inbox note*${titlePart} — \`${issue.path}\`\n\n` +
		`${issue.ageDays}d in inbox without being filed. Tap *🗑 Drop* to git-rm it ` +
		`(reversible via \`git checkout\`), or *🔇 Ignore* to suppress for 30 days.`
	);
}

export async function emitVaultHygieneEscalations(): Promise<VaultEscalationResult> {
	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'vault-engine-not-ready' };

	// Pull each bucket's full anomaly set from the engine directly.
	// The hygiene report's 20-cap is a display affordance, not a policy —
	// for the escalator we want suppression to take effect across the
	// entire pool before applying the per-emission cap.
	const unresolved = engine.getUnresolved();
	const orphans = engine.getOrphans();
	const staleInbox = getStaleInbox(engine);

	const failures: { source: string; raw: string; error: string }[] = [];
	const byBucket: Record<string, { totalRows: number; sent: number; skipped: number }> = {};
	let totalRows = 0;
	let sent = 0;
	let skipped = 0;

	// Filter orphans up-front using the same zone-exempt rules report.ts
	// applies (inbox/archive zones, index.md, session-log type) — without
	// this, inbox notes would also surface as orphans and double-fire
	// with stale_inbox_item.
	const orphanIssues: OrphanIssue[] = orphans
		.filter((n) => {
			const zone = n.path.split('/')[0];
			if (zone === 'inbox' || zone === 'archive') return false;
			if (n.path.endsWith('/index.md') || n.path === 'index.md') return false;
			if (n.meta?.type === 'session-log') return false;
			return true;
		})
		.map((n) => ({
			path: n.path,
			title: n.title,
			suggestedFix: `Link from a related note, or archive if no longer relevant.`,
		}));

	// Mirror report.ts filtering for `unresolved` — archive/inbox are
	// frozen/transient zones and `operations/hygiene/` snapshots are this
	// generator's own past output. Wikilinks in those areas are cosmetic
	// noise, not operational debt; the report classifies them as
	// un-actionable and the escalator must match, otherwise the operator
	// gets fan-out for anomalies the report itself says don't exist.
	const unresolvedIssues = unresolved.filter((u) => {
		const zone = u.source.split('/')[0];
		if (zone === 'archive' || zone === 'inbox') return false;
		if (u.source.startsWith('operations/hygiene/')) return false;
		return true;
	});

	// Bucket order: rare buckets first (orphan, stale-inbox) so their
	// independent caps stay separate from the high-volume unresolved
	// pool. Each bucket has its own cap from BUCKET_CAPS — no global
	// budget sharing, so one bucket can't starve another.
	type BucketRunner = () => Promise<void>;
	const buckets: { name: string; total: number; run: BucketRunner }[] = [
		{
			name: 'orphan_note',
			total: orphanIssues.length,
			run: async () => {
				const bucket = 'orphan_note';
				const cap = BUCKET_CAPS[bucket] ?? 5;
				const suppressed = await loadActiveSuppressions(bucket);
				let bucketSent = 0;
				for (const issue of orphanIssues) {
					if (bucketSent >= cap) break;
					const key = issue.path;
					if (suppressed.has(key) || hasPendingVaultHygiene(issue.path, '', bucket)) {
						byBucket[bucket].skipped++;
						skipped++;
						continue;
					}
					const result = await sendText(chatId, formatOrphanMessage(issue), delivery, {
						replyMarkup: buildVaultHygieneOrphanKeyboard(issue.path),
					});
					if (!result.ok || result.messageIds.length === 0) {
						failures.push({ source: issue.path, raw: '', error: result.error ?? 'send-failed' });
						continue;
					}
					rememberVaultHygieneButtons({
						source: issue.path,
						raw: '',
						bucket,
						chatJid: String(chatId),
						messageId: result.messageIds[0],
					});
					byBucket[bucket].sent++;
					sent++;
					bucketSent++;
				}
			},
		},
		{
			name: 'stale_inbox_item',
			total: staleInbox.length,
			run: async () => {
				const bucket = 'stale_inbox_item';
				const cap = BUCKET_CAPS[bucket] ?? 5;
				const suppressed = await loadActiveSuppressions(bucket);
				let bucketSent = 0;
				for (const issue of staleInbox) {
					if (bucketSent >= cap) break;
					const key = issue.path;
					if (suppressed.has(key) || hasPendingVaultHygiene(issue.path, '', bucket)) {
						byBucket[bucket].skipped++;
						skipped++;
						continue;
					}
					const result = await sendText(chatId, formatStaleInboxMessage(issue), delivery, {
						replyMarkup: buildVaultHygieneStaleInboxKeyboard(issue.path),
					});
					if (!result.ok || result.messageIds.length === 0) {
						failures.push({ source: issue.path, raw: '', error: result.error ?? 'send-failed' });
						continue;
					}
					rememberVaultHygieneButtons({
						source: issue.path,
						raw: '',
						bucket,
						chatJid: String(chatId),
						messageId: result.messageIds[0],
					});
					byBucket[bucket].sent++;
					sent++;
					bucketSent++;
				}
			},
		},
		{
			name: 'unresolved',
			total: unresolvedIssues.length,
			run: async () => {
				// Bulk-fix surface (new): one aggregate message with a
				// `🤖 Fix all (N) · 📋 Show list · ⏭ Skip` keyboard
				// instead of N per-row messages. Per-row vh-unlink rows
				// are retired for this bucket — the operator does
				// everything from the aggregate, or expands to the
				// text-only list via the button.
				const bucket = 'unresolved';
				const suppressed = await loadActiveSuppressions(bucket);
				const fresh = unresolvedIssues.filter((link) => {
					const key = vaultHygieneKeyFor(link.source, link.raw);
					return !suppressed.has(key);
				});
				const suppressedCount = unresolvedIssues.length - fresh.length;
				byBucket[bucket].skipped += suppressedCount;
				skipped += suppressedCount;
				if (fresh.length === 0) return;

				const batch = fresh.map((link) => ({
					source: link.source,
					raw: link.raw,
				}));
				const digestText = formatAggregateDigest(batch);
				const result = await sendText(chatId, digestText, delivery, {
					replyMarkup: buildFixBatchKeyboard(batch),
				});
				if (!result.ok || result.messageIds.length === 0) {
					for (const link of fresh) {
						failures.push({
							source: link.source,
							raw: link.raw,
							error: result.error ?? 'send-failed',
						});
					}
					return;
				}
				rememberFixBatch({
					batch,
					digestText,
					chatJid: String(chatId),
					messageId: result.messageIds[0],
				});
				// All fresh links are now under one aggregate. Count as
				// a single send (not N) so the metric reflects messages
				// emitted, not links covered.
				byBucket[bucket].sent += 1;
				sent += 1;
			},
		},
	];

	for (const b of buckets) {
		byBucket[b.name] = { totalRows: b.total, sent: 0, skipped: 0 };
		totalRows += b.total;
		if (b.total > 0) await b.run();
	}

	return { ok: true, totalRows, sent, skipped, failures, byBucket };
}
