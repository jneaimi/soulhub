/**
 * SystemHealth — the immune system for Soul Hub.
 *
 * Runs on startup + every 6 hours:
 *   detect() → classify() → auto-fix safe issues → notify for human-required ones
 *
 * This is a SYSTEM service, not a user pipeline. It initializes alongside
 * the vault engine and pipeline scheduler in hooks.server.ts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { getVaultEngine } from '../vault/index.js';
import { NotificationStore } from './notifications.js';
import { healOrphans, healMissingRootIndex, healMissingFrontmatter, healBrokenLinks } from './healers/vault-healer.js';
import type { DetectedIssue, HealthReport, HealResult } from './types.js';

const HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Map raw IssueType keys to digest-friendly category names. Anything not
 *  in here falls back to a snake-case → space conversion. */
const FRIENDLY_NAMES: Record<string, string> = {
	orphan_notes: 'Orphan notes',
	dead_links: 'Broken wikilinks',
	missing_index: 'Missing root index',
	stale_inbox: 'Stale inbox',
	governance_violation: 'Governance violations',
	missing_frontmatter: 'Frontmatter',
};

const DASHBOARD_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
const SAMPLE_PATH_LIMIT = 3;

let instance: SystemHealth | null = null;

function friendlyName(type: string): string {
	return FRIENDLY_NAMES[type] || type.replace(/_/g, ' ');
}

/** Unresolved wikilinks inside `archive/`, `inbox/`, and `operations/hygiene/`
 *  are NOT operational debt — they're frozen historical / transient snapshots
 *  (e.g. an archived projects-audit referencing since-deleted projects). This
 *  mirrors the canonical filter in `vault-hygiene/report.ts` so SystemHealth's
 *  dead-links count + auto-heal agree with the /hygiene dashboard. Before this,
 *  SystemHealth used the raw set and counted 146 broken links while the
 *  dashboard reported 0 — the drift that pushed a misleading "144 skipped"
 *  digest. Keep this predicate in sync with report.ts. */
function isReportableUnresolved(u: { source: string }): boolean {
	const zone = u.source.split('/')[0];
	return zone !== 'archive' && zone !== 'inbox' && !u.source.startsWith('operations/hygiene/');
}

/** Render a `fixed[]` entry as digest lines. The `dead_links` healer uses
 *  a verbose `path: [[raw]] → [[replacement]]` format that wraps badly on
 *  phone screens; we split it into a path line + an indented rewrite line.
 *  Other healers store bare paths and render on a single line. */
function formatFixedEntry(entry: string): string[] {
	const sep = entry.indexOf(': [[');
	if (sep < 0) return [`   \`${entry}\``];
	const path = entry.slice(0, sep);
	const rewrite = entry.slice(sep + 2); // drop the leading ": "
	return [`   \`${path}\``, `      ${rewrite}`];
}

/** Local-time formatted timestamp for digest headers. Telegram clients
 *  already attach their own message timestamp, but an explicit one in the
 *  body removes ambiguity when digests are forwarded or quoted. */
function formatDigestTimestamp(iso: string): string {
	const d = new Date(iso);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** Build the human-facing digest body. Returns null when nothing notable
 *  happened (no human-required issues, no auto-fixes, no errors), so the
 *  caller can stay silent. Pure function — no I/O — so it's trivially
 *  testable and previewable from the system-health endpoint.
 *
 *  Skipped items alone never raise a digest — that's the "self-heal, not
 *  nag" contract. Errors do raise a digest because they signal the healer
 *  itself is broken, which a human needs to see. */
export function buildDigestMessage(
	report: HealthReport,
	previousReport: HealthReport | null = null,
): string | null {
	const humanIssues = report.issues.filter((i) => i.risk !== 'safe');
	const totalFixed = report.autoFixed.reduce((s, r) => s + r.fixed.length, 0);
	const totalErrors = report.autoFixed.reduce((s, r) => s + r.errors.length, 0);
	const healersWithSkipped = report.autoFixed.filter((r) => r.skipped.length > 0);
	const healersWithErrors = report.autoFixed.filter((r) => r.errors.length > 0);

	if (humanIssues.length === 0 && totalFixed === 0 && totalErrors === 0) return null;

	const emoji = humanIssues.length > 0 || totalErrors > 0 ? '🟡' : '🟢';
	const issueCount = humanIssues.length;
	let issuePhrase = issueCount === 1
		? '1 issue needs attention'
		: `${issueCount} issues need attention`;

	// Day-over-day delta on the action-item count. Only shown when a previous
	// report is available (skipped on first run / fresh restart) and the delta
	// is non-zero — flat counts add no signal.
	if (previousReport) {
		const prevIssueCount = previousReport.issues.filter((i) => i.risk !== 'safe').length;
		const delta = issueCount - prevIssueCount;
		if (delta !== 0) {
			const arrow = delta > 0 ? '↑' : '↓';
			issuePhrase += ` (${arrow}${Math.abs(delta)} from last check)`;
		}
	}

	const lines: string[] = [];
	lines.push(`${emoji} *[Soul Hub] Vault Health* — ${formatDigestTimestamp(report.timestamp)}`);
	lines.push(`${report.totalNotes} notes · ${issuePhrase}`);

	if (humanIssues.length > 0) {
		lines.push('');
		lines.push('⚠️ *Action items*');
		for (const i of humanIssues) {
			lines.push(`• ${i.title}`);
		}
	}

	if (totalFixed > 0) {
		lines.push('');
		lines.push('✅ *Auto-fixed*');
		for (const r of report.autoFixed) {
			if (r.fixed.length === 0) continue;
			const pct = report.totalNotes > 0
				? ` (${(r.fixed.length / report.totalNotes * 100).toFixed(1)}%)`
				: '';
			lines.push(`• ${friendlyName(r.type)} — ${r.fixed.length} ${r.fixed.length === 1 ? 'note' : 'notes'}${pct}`);
			for (const entry of r.fixed.slice(0, SAMPLE_PATH_LIMIT)) {
				for (const line of formatFixedEntry(entry)) lines.push(line);
			}
			if (r.fixed.length > SAMPLE_PATH_LIMIT) {
				lines.push(`   …+${r.fixed.length - SAMPLE_PATH_LIMIT} more`);
			}
		}
	}

	if (healersWithSkipped.length > 0) {
		lines.push('');
		lines.push('⏭️ *Skipped*');
		for (const r of healersWithSkipped) {
			const n = r.skipped.length;
			lines.push(`• ${friendlyName(r.type)} — ${n} ${n === 1 ? 'item' : 'items'}`);
		}
	}

	if (healersWithErrors.length > 0) {
		lines.push('');
		lines.push('❌ *Errors*');
		for (const r of healersWithErrors) {
			const n = r.errors.length;
			lines.push(`• ${friendlyName(r.type)} — ${n} ${n === 1 ? 'error' : 'errors'}`);
			const first = r.errors[0];
			lines.push(`   \`${first.path}\``);
			lines.push(`      ${first.error.slice(0, 120)}`);
		}
	}

	lines.push('');
	lines.push(`📊 ${DASHBOARD_URL}/vault`);

	return lines.join('\n');
}

export class SystemHealth {
	readonly notifications: NotificationStore;
	private healthInterval: ReturnType<typeof setInterval> | null = null;
	private vaultRoot: string;
	private reportFile: string;
	private lastReport: HealthReport | null = null;
	private previousReport: HealthReport | null = null;
	private running = false;

	constructor(dataDir: string, vaultRoot: string) {
		this.notifications = new NotificationStore(dataDir);
		this.vaultRoot = vaultRoot;
		this.reportFile = resolve(dataDir, 'last-health-report.json');
	}

	async init(): Promise<void> {
		await this.notifications.load();
		await this.loadPersistedReport();

		// Run health check on startup (delayed 10s to let vault finish indexing)
		setTimeout(() => this.runHealthCheck(), 10_000);

		// Then every 6 hours
		this.healthInterval = setInterval(() => this.runHealthCheck(), HEALTH_INTERVAL_MS);

		console.log(`[system-health] Initialized (${this.notifications.activeCount} active notifications)`);
	}

	shutdown(): void {
		if (this.healthInterval) clearInterval(this.healthInterval);
	}

	/** Get the last health report */
	getLastReport(): HealthReport | null {
		return this.lastReport;
	}

	/** Get the report from before lastReport — used to compute day-over-day
	 *  deltas in digest previews so the API matches what the next real digest
	 *  would say. */
	getPreviousReport(): HealthReport | null {
		return this.previousReport;
	}

	/** Restore the last persisted report from disk so day-over-day deltas
	 *  survive restarts. The loaded report becomes `lastReport`; `previousReport`
	 *  stays null until the next cycle runs (and shifts lastReport into it). */
	private async loadPersistedReport(): Promise<void> {
		try {
			const raw = await readFile(this.reportFile, 'utf-8');
			const parsed = JSON.parse(raw) as HealthReport;
			if (parsed && typeof parsed === 'object' && Array.isArray(parsed.issues)) {
				this.lastReport = parsed;
			}
		} catch {
			// No persisted report yet — that's fine on first run.
		}
	}

	private async savePersistedReport(report: HealthReport): Promise<void> {
		try {
			await mkdir(dirname(this.reportFile), { recursive: true });
			await writeFile(this.reportFile, JSON.stringify(report, null, 2), 'utf-8');
		} catch (err) {
			console.warn('[system-health] Failed to persist report:', err);
		}
	}

	/** Force a health check now (called by API) */
	async forceCheck(): Promise<HealthReport> {
		return this.runHealthCheck();
	}

	/** Run the full detect → classify → heal → notify cycle */
	private async runHealthCheck(): Promise<HealthReport> {
		if (this.running) {
			console.log('[system-health] Skipping — check already in progress');
			return this.lastReport ?? this.emptyReport();
		}

		this.running = true;
		const start = Date.now();

		try {
			const vault = getVaultEngine();
			if (!vault) {
				console.log('[system-health] Vault not ready — skipping health check');
				return this.emptyReport();
			}

			// ── Phase 1: Detect ──
			const issues = await this.detect(vault);

			// ── Phase 2: Auto-fix safe issues ──
			const autoFixed: HealResult[] = [];
			for (const issue of issues.filter((i) => i.risk === 'safe')) {
				const result = await this.heal(issue);
				if (result) autoFixed.push(result);
			}

			// ── Phase 3: Create notifications for human-required issues ──
			let notificationsCreated = 0;
			for (const issue of issues.filter((i) => i.risk !== 'safe')) {
				this.notifications.add({
					source: 'vault',
					severity: issue.risk === 'needs_claude' ? 'action_required' : 'warning',
					title: issue.title,
					detail: issue.detail,
					actions: issue.actions,
				});
				notificationsCreated++;
			}

			// Auto-resolve vault notifications whose issues no longer exist
			const currentIssueTitles = new Set(issues.filter((i) => i.risk !== 'safe').map((i) => i.title));
			for (const n of this.notifications.getActive()) {
				if (n.source === 'vault' && !currentIssueTitles.has(n.title)) {
					this.notifications.resolve(n.id, 'auto', 'Issue no longer detected');
				}
			}

			// Prune old resolved notifications
			this.notifications.prune(7);
			await this.notifications.save();

			// Reindex vault if we made changes
			if (autoFixed.some((r) => r.fixed.length > 0)) {
				await vault.reindex();
			}

			const report: HealthReport = {
				timestamp: new Date().toISOString(),
				totalNotes: vault.getStats().totalNotes,
				issues,
				autoFixed,
				notificationsCreated,
			};

			// Shift the previous report before overwriting — gives buildDigestMessage
			// a baseline for day-over-day deltas. On first run after restart this
			// uses the disk-loaded report; on first run ever it stays null.
			this.previousReport = this.lastReport;
			this.lastReport = report;
			await this.savePersistedReport(report);

			const fixedCount = autoFixed.reduce((sum, r) => sum + r.fixed.length, 0);
			const errorCount = autoFixed.reduce((sum, r) => sum + r.errors.length, 0);
			const elapsed = Date.now() - start;
			console.log(
				`[system-health] Check complete in ${elapsed}ms: ` +
				`${issues.length} issues found, ${fixedCount} auto-fixed, ${errorCount} errors, ${notificationsCreated} notifications`
			);

			// NOTE: outbound channel digest retired 2026-05-22. Hygiene
			// notification is owned solely by the `hygiene-digest-daily`
			// Telegram task (vault-hygiene/daily-digest.ts, filtered counts +
			// Fix-all buttons) and the /orchestration/hygiene dashboard.
			// SystemHealth still detects, auto-heals, and feeds the dashboard +
			// in-app NotificationStore — it just no longer pushes its own
			// (unfiltered, every-6h) digest to the default channel. The digest
			// text remains viewable on demand via `buildDigestMessage` in the
			// /api/system/health endpoint's `digestPreview`.

			return report;
		} catch (err) {
			console.error('[system-health] Health check failed:', err);
			return this.emptyReport();
		} finally {
			this.running = false;
		}
	}

	/** Detect all vault issues and classify by risk */
	private async detect(vault: ReturnType<typeof getVaultEngine> & object): Promise<DetectedIssue[]> {
		const issues: DetectedIssue[] = [];
		const allNotes = (vault as any).getRecent?.(99999) ?? [];
		// Use the methods we know exist
		const orphans = vault.getOrphans();
		const unresolved = vault.getUnresolved().filter(isReportableUnresolved);
		const stats = vault.getStats();

		const VALID_ZONES = new Set(['inbox', 'projects', 'knowledge', 'content', 'operations', 'archive', 'finance', 'security']);
		// Auto-routed financial + security records carry no body links by design
		// (one-note-per-email format), so exempt them from orphan flagging the
		// same way inbox + archive are exempted.
		const EXEMPT_ZONES = new Set(['inbox', 'archive', 'finance', 'security']);

		// ── Orphan Notes ──
		if (orphans.length > 0) {
			// Group by zone for classification — only recognized vault zones
			const byZone = new Map<string, string[]>();
			for (const note of orphans) {
				const zone = note.path.split('/')[0];
				if (!VALID_ZONES.has(zone) || EXEMPT_ZONES.has(zone)) continue;
				if (!byZone.has(zone)) byZone.set(zone, []);
				byZone.get(zone)!.push(note.path);
			}

			for (const [zone, paths] of byZone) {
				// Check if zone has an index — if yes, safe to auto-link
				const hasIndex = allNotes.some((n: any) => n.path === `${zone}/index.md`);

				if (paths.length <= 50 && hasIndex) {
					issues.push({
						type: 'orphan_notes',
						risk: 'safe',
						title: `${paths.length} orphan notes in ${zone}/`,
						detail: `Notes with no wikilinks can be auto-linked to ${zone}/index.md`,
						paths,
						actions: [],
					});
				} else {
					issues.push({
						type: 'orphan_notes',
						risk: paths.length > 100 ? 'needs_claude' : 'needs_human',
						title: `${paths.length} orphan notes in ${zone}/`,
						detail: paths.length > 50
							? `Too many orphans to auto-fix (${paths.length}). Review and approve batch linking.`
							: `No index.md found in ${zone}/ — create one first or link manually.`,
						paths,
						actions: [
							{
								id: `fix-orphans-${zone}`,
								label: `Auto-link orphans in ${zone}/`,
								type: 'api',
								endpoint: '/api/system/actions',
								method: 'POST',
								body: { action: 'heal-orphans', zone },
							},
							{
								id: `claude-orphans-${zone}`,
								label: 'Launch Claude to investigate',
								type: 'claude',
								prompt: `Review the ${paths.length} orphan notes in ~/vault/${zone}/ and organize them. Link each to the appropriate index or move to the correct zone. Paths:\n${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n... and ${paths.length - 20} more` : ''}`,
								cwd: '~/vault',
							},
						],
					});
				}
			}
		}

		// ── Dead Links ──
		// `risk: 'safe'` lets the auto-heal loop in tick() rewrite the
		// high-confidence (≥0.88 fuzzy match) ones each cycle without a
		// human click. Anything below threshold gets left in place — it'll
		// reappear next cycle until either a target shows up or someone
		// edits the source manually. Genuinely-unfixable links go quiet
		// rather than nag the digest forever; the user explicitly asked
		// for self-healing on this surface.
		if (unresolved.length > 0) {
			issues.push({
				type: 'dead_links',
				risk: 'safe',
				title: `${unresolved.length} broken wikilinks`,
				detail: unresolved.slice(0, 10).map((u) => `${u.source} → [[${u.raw}]]`).join('\n'),
				paths: unresolved.map((u) => u.source),
				actions: [],
			});
		}

		// ── Missing Root Index ──
		const rootIndexExists = allNotes.some((n: any) => n.path === 'index.md');
		if (!rootIndexExists) {
			issues.push({
				type: 'missing_index',
				risk: 'safe',
				title: 'Root index.md missing',
				detail: 'Vault has no root entry point. Will auto-generate from zone list.',
				paths: [],
				actions: [],
			});
		}

		// ── Missing Frontmatter ──
		const missingCreated = allNotes.filter((n: any) => !n.meta?.created);
		if (missingCreated.length > 0) {
			const paths = missingCreated.map((n: any) => n.path);
			issues.push({
				type: 'missing_frontmatter',
				risk: paths.length <= 50 ? 'safe' : 'needs_human',
				title: `${paths.length} notes missing 'created' field`,
				detail: 'Will backfill from file modification time.',
				paths,
				actions: paths.length > 50 ? [
					{
						id: 'fix-frontmatter',
						label: 'Backfill created dates',
						type: 'api',
						endpoint: '/api/system/actions',
						method: 'POST',
						body: { action: 'heal-frontmatter' },
					},
				] : [],
			});
		}

		return issues;
	}

	/** Execute auto-fix for a safe issue */
	private async heal(issue: DetectedIssue): Promise<HealResult | null> {
		const vault = getVaultEngine();
		if (!vault) return null;

		// Get all notes via stats-based approach
		const allNotes = vault.getRecent(99999);

		switch (issue.type) {
			case 'orphan_notes': {
				const orphanNotes = vault.getOrphans().filter((n) => issue.paths.includes(n.path));
				return healOrphans(this.vaultRoot, orphanNotes, allNotes);
			}
			case 'missing_index':
				return healMissingRootIndex(this.vaultRoot, allNotes);
			case 'missing_frontmatter':
				return healMissingFrontmatter(this.vaultRoot, allNotes);
			case 'dead_links': {
				// Re-fetch from the engine rather than relying on the issue's
				// frozen `paths` — paths is per-source-file but healBrokenLinks
				// needs the original {source, raw} pairs. Same archive/inbox/
				// hygiene-snapshot filter as detect() so we never rewrite links
				// inside frozen historical records.
				const unresolved = vault.getUnresolved().filter(isReportableUnresolved);
				return healBrokenLinks(this.vaultRoot, unresolved, allNotes);
			}
			default:
				return null;
		}
	}

	private emptyReport(): HealthReport {
		return {
			timestamp: new Date().toISOString(),
			totalNotes: 0,
			issues: [],
			autoFixed: [],
			notificationsCreated: 0,
		};
	}
}

// ── Module-level singleton ──

export function getSystemHealth(): SystemHealth | null {
	return instance;
}

export async function initSystemHealth(dataDir: string, vaultRoot: string): Promise<SystemHealth> {
	if (instance) return instance;
	const health = new SystemHealth(dataDir, vaultRoot);
	await health.init();
	instance = health;
	return instance;
}
