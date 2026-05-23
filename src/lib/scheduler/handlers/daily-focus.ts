/** Task handler: daily-focus.
 *
 *  Phase 6 producer. Mon-Fri 08:00 morning picker — surfaces two slots
 *  per ADR-003 voice-queue convention:
 *
 *    Slot A — freshest active project (mtime within `freshDays`)
 *             "you've been working on X, nudge to keep going."
 *    Slot B — oldest stalled active project (mtime within
 *             [stalledMinDays, stalledMaxDays])
 *             "haven't touched X in 12 days — still on?"
 *
 *  Writes `inbox/YYYY-MM-DD-daily-focus.md` with `voice_eligible: true`
 *  whenever at least one slot has a pick. Zero-pick days produce no
 *  output (silent — no inbox spam).
 *
 *  Status values that count as "active" for this picker: `active`,
 *  `in-progress` (the soul-hub-scheduler convention).
 *
 *  Settings shape:
 *    {
 *      id: 'daily-focus',
 *      type: 'daily-focus',
 *      cron: '0 8 * * 1-5',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        freshDays: 7,         // optional, default 7
 *        stalledMinDays: 8,    // optional, default 8
 *        stalledMaxDays: 30,   // optional, default 30
 *      }
 *    }
 *
 *  Per ADR-007, daily-focus stays separate from Vault-Scout (Phase 7)
 *  because it has stronger product opinion (always 2 slots, specific
 *  format). The scout will surface other vault moments; daily-focus
 *  owns the "morning kickoff" slot.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getVaultEngine } from '../../vault/index.js';
import type { VaultNote } from '../../vault/types.js';
import type { TaskFn } from '../task-types.js';

interface DailyFocusParams {
	freshDays?: number;
	stalledMinDays?: number;
	stalledMaxDays?: number;
	vaultDir?: string;
}

interface ProjectAggregate {
	folder: string;
	status: string | null;
	maxMtime: number;
	idleDays: number;
	authoritativeNote: VaultNote;
}

const ACTIVE_STATUSES = new Set(['active', 'in-progress']);
const PROJECT_FOLDER_RE = /^projects\/([^/]+)\//;

function isProjectNote(path: string): string | null {
	const m = PROJECT_FOLDER_RE.exec(path);
	return m ? m[1] : null;
}

/** Resolve project status using the dual-file rule (project.md wins
 *  over index.md when they disagree, per the lead-generation-system
 *  false-positive lesson, 2026-05-04). Returns the authoritative note
 *  too — its content/path becomes the wikilink in the digest. */
function resolveProjectStatus(notes: VaultNote[]): { status: string | null; auth: VaultNote } | null {
	if (notes.length === 0) return null;
	const proj = notes.find((n) => n.path.endsWith('/project.md'));
	const idx = notes.find((n) => n.path.endsWith('/index.md'));
	if (proj?.meta.status) return { status: String(proj.meta.status), auth: proj };
	if (idx?.meta.status) return { status: String(idx.meta.status), auth: idx };
	if (proj) return { status: null, auth: proj };
	if (idx) return { status: null, auth: idx };
	return { status: null, auth: notes[0] };
}

export interface PickedSlots {
	slotA: ProjectAggregate | null;
	slotB: ProjectAggregate | null;
	candidatesActive: number;
	now: Date;
}

/** Pure picker — exported for smoke testing without a live vault. */
export function pickSlots(
	allNotes: VaultNote[],
	now: Date,
	freshDays: number,
	stalledMinDays: number,
	stalledMaxDays: number,
): PickedSlots {
	const grouped = new Map<string, VaultNote[]>();
	for (const n of allNotes) {
		const folder = isProjectNote(n.path);
		if (!folder) continue;
		const arr = grouped.get(folder);
		if (arr) arr.push(n);
		else grouped.set(folder, [n]);
	}

	const aggregates: ProjectAggregate[] = [];
	for (const [folder, notes] of grouped) {
		const resolved = resolveProjectStatus(notes);
		if (!resolved || !resolved.status || !ACTIVE_STATUSES.has(resolved.status)) continue;
		const maxMtime = notes.reduce((m, n) => Math.max(m, n.mtime), 0);
		const idleDays = Math.floor((now.getTime() - maxMtime) / (24 * 60 * 60 * 1000));
		aggregates.push({
			folder,
			status: resolved.status,
			maxMtime,
			idleDays,
			authoritativeNote: resolved.auth,
		});
	}

	// Slot A — freshest active within freshDays. Sort by maxMtime desc.
	const fresh = aggregates
		.filter((a) => a.idleDays <= freshDays)
		.sort((a, b) => b.maxMtime - a.maxMtime);

	// Slot B — oldest stalled in [stalledMinDays, stalledMaxDays]. Sort
	// by maxMtime asc (oldest first), pick first.
	const stalled = aggregates
		.filter((a) => a.idleDays >= stalledMinDays && a.idleDays <= stalledMaxDays)
		.sort((a, b) => a.maxMtime - b.maxMtime);

	const slotA = fresh[0] ?? null;
	const slotB = stalled[0] ?? null;

	// Defend against same project landing in both (shouldn't happen given
	// the disjoint thresholds, but cheap to enforce).
	const finalSlotB = slotB && slotA && slotB.folder === slotA.folder ? null : slotB;

	return {
		slotA,
		slotB: finalSlotB,
		candidatesActive: aggregates.length,
		now,
	};
}

function todayInTz(now: Date, tz: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

function renderDigest(picked: PickedSlots, today: string): string | null {
	if (!picked.slotA && !picked.slotB) return null;

	const lines: string[] = [
		'---',
		'type: report',
		`created: ${today}`,
		'tags: [daily-focus, heartbeat, morning]',
		'source: agent',
		'source_agent: daily-focus',
		'source_context: soul-hub-scheduler',
		'voice_eligible: true',
		'voice_priority: normal',
		`voice_summary: "${voiceSummary(picked)}"`,
		'---',
		'',
		`# Daily focus — ${today}`,
		'',
		`Walked \`~/vault/projects/\` for active work. ${picked.candidatesActive} active project${picked.candidatesActive === 1 ? '' : 's'} found.`,
		'',
	];

	if (picked.slotA) {
		const wiki = `[[${picked.slotA.authoritativeNote.path.replace(/\.md$/, '')}|${picked.slotA.folder}]]`;
		lines.push('## Slot A — momentum');
		lines.push('');
		lines.push(`> ${picked.slotA.idleDays === 0 ? 'Touched today' : `Touched ${picked.slotA.idleDays}d ago`} — keep going.`);
		lines.push('');
		lines.push(`- ${wiki}  \`status: ${picked.slotA.status}\``);
		lines.push('');
	}

	if (picked.slotB) {
		const wiki = `[[${picked.slotB.authoritativeNote.path.replace(/\.md$/, '')}|${picked.slotB.folder}]]`;
		lines.push('## Slot B — stalled');
		lines.push('');
		lines.push(`> Stalled ${picked.slotB.idleDays}d. Re-engage today, or flip to \`status: paused\`.`);
		lines.push('');
		lines.push(`- ${wiki}  \`status: ${picked.slotB.status}\``);
		lines.push('');
	}

	if (!picked.slotB) {
		lines.push("_No stalled active projects in the 8-30d window. Either everything is moving or nothing has been parked — both fine._");
		lines.push('');
	}

	lines.push('---');
	lines.push('');
	lines.push('Reply `done` (acknowledged) / `skip` (not today) / `later` (snooze 4h) to clear from voice queue.');
	lines.push('');

	return lines.join('\n');
}

function voiceSummary(picked: PickedSlots): string {
	if (picked.slotA && picked.slotB) {
		return `Momentum: ${picked.slotA.folder} (${picked.slotA.idleDays}d). Stalled: ${picked.slotB.folder} (${picked.slotB.idleDays}d). 2-slot focus.`;
	}
	if (picked.slotA) {
		return `Momentum pick: ${picked.slotA.folder} (${picked.slotA.idleDays === 0 ? 'fresh today' : `${picked.slotA.idleDays}d ago`}). Nothing stalled.`;
	}
	if (picked.slotB) {
		return `Stalled: ${picked.slotB.folder} (${picked.slotB.idleDays}d). Re-engage or flip status.`;
	}
	return '';
}

export function dailyFocusFactory(rawParams: unknown): TaskFn {
	const params: DailyFocusParams =
		typeof rawParams === 'object' && rawParams !== null ? (rawParams as DailyFocusParams) : {};
	const freshDays = params.freshDays ?? 7;
	const stalledMinDays = params.stalledMinDays ?? 8;
	const stalledMaxDays = params.stalledMaxDays ?? 30;
	const vaultDir = params.vaultDir ?? resolve(homedir(), 'vault');

	return async () => {
		const engine = getVaultEngine();
		if (!engine) {
			throw new Error('daily-focus: vault engine is not initialised');
		}
		const now = new Date();
		const today = todayInTz(now, 'Asia/Dubai');

		// Overscan via getRecent — vault has ~1.5k notes, the filter is cheap.
		const allNotes = engine.getRecent(10000);
		const picked = pickSlots(allNotes, now, freshDays, stalledMinDays, stalledMaxDays);
		const digest = renderDigest(picked, today);

		if (!digest) {
			return {
				today,
				wrote: false,
				reason: 'no-active-projects-needing-nudge',
				candidatesActive: picked.candidatesActive,
			};
		}

		const outputPath = resolve(vaultDir, 'inbox', `${today}-daily-focus.md`);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, digest, 'utf-8');

		return {
			today,
			wrote: true,
			outputPath,
			slotA: picked.slotA?.folder ?? null,
			slotB: picked.slotB?.folder ?? null,
			candidatesActive: picked.candidatesActive,
		};
	};
}
