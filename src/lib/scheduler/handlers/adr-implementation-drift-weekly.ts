/** Scheduler handler: adr-implementation-drift-weekly.
 *
 *  Soul-hub-hygiene ADR-009.
 *
 *  Runs weekly (joined to the `adr-status-drift-weekly` cadence — Monday
 *  09:05 Dubai by default, 5 min after the status-drift check).  Walks
 *  every `type: decision` note with `proposed` or `accepted` status,
 *  searches a bounded `git log main` for merge commits that reference the
 *  ADR slug, and sends a single Telegram digest message when matches exist.
 *
 *  Detect-only — operators decide which phase is "fully shipped" (per
 *  ADR-024 D3).  Each digest row has a "Mark shipped" inline note and a
 *  redirect to /hygiene where the "Mark shipped" / "Not yet" buttons live.
 *
 *  Settings shape:
 *    {
 *      id: 'adr-implementation-drift-weekly',
 *      type: 'adr-implementation-drift-weekly',
 *      cron: '5 9 * * 1',
 *      timezone: 'Asia/Dubai',
 *      params: { maxPerProject?: number, maxTotal?: number }
 *    } */

import { config as soulHubConfig } from '../../config.js';
import { sendText } from '../../channels/telegram/outbound.js';
import { getVaultEngine } from '../../vault/index.js';
import {
	getAdrImplementationDrift,
	groupByProject,
	type AdrImplementationDriftIssue,
} from '../../vault-hygiene/adr-implementation-drift.js';
import type { TaskFn } from '../task-types.js';

interface AdrImplDriftParams {
	/** Cap rows surfaced per project in the digest. Excess rolled into
	 *  a trailing "+N more" line per project. Default 8. */
	maxPerProject?: number;
	/** Hard cap on total rows in the digest. Default 40. */
	maxTotal?: number;
}

export interface AdrImplDriftSummary {
	totalDrift: number;
	projects: number;
	sent: boolean;
	failed: boolean;
	error?: string;
	took_ms: number;
}

/** Same fallback chain as audit-nudge / vault-escalator: prefer the
 *  configured `channels.telegram.access.allowFrom` first entry; fall
 *  back to the legacy `TELEGRAM_CHAT_ID` env var. */
function resolveTelegramChatId(): string | null {
	const allow = soulHubConfig.channels?.telegram?.access?.allowFrom;
	if (Array.isArray(allow) && allow.length > 0 && typeof allow[0] === 'string') {
		return allow[0];
	}
	const env = process.env.TELEGRAM_CHAT_ID;
	return env && env.trim() ? env.trim() : null;
}

function adrSlug(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.md$/, '');
}

function formatDigest(
	groups: Map<string, AdrImplementationDriftIssue[]>,
	totalDrift: number,
	maxPerProject: number,
	dashboardUrl: string | null,
): string {
	const date = new Date().toISOString().slice(0, 10);
	const lines: string[] = [
		`🔀 ADR implementation drift — week of ${date}`,
		`${groups.size} project${groups.size === 1 ? '' : 's'}, ${totalDrift} ADR${totalDrift === 1 ? '' : 's'} merged but not shipped`,
		'',
		'Code referencing these ADRs has landed on main — check if they are fully shipped:',
	];

	for (const [project, issues] of groups) {
		lines.push('');
		lines.push(`${project} (${issues.length}):`);
		const shown = issues.slice(0, maxPerProject);
		for (const issue of shown) {
			lines.push(
				`  • ${adrSlug(issue.path)}: status=${issue.currentStatus} ← merged`,
			);
			lines.push(
				`    Evidence: ${issue.mergeEvidence}`,
			);
		}
		const extra = issues.length - shown.length;
		if (extra > 0) {
			lines.push(`  • …+${extra} more`);
		}
	}

	lines.push('');
	lines.push('Action: open /hygiene → "Needs your call" for one-click Mark shipped / Not yet.');
	if (dashboardUrl) {
		lines.push(`${dashboardUrl}/orchestration/hygiene`);
	}

	return lines.join('\n');
}

export function adrImplementationDriftWeeklyFactory(rawParams: unknown): TaskFn {
	const params: AdrImplDriftParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as AdrImplDriftParams)
			: {};
	const maxPerProject = params.maxPerProject ?? 8;
	const maxTotal = params.maxTotal ?? 40;

	return async (): Promise<AdrImplDriftSummary> => {
		const startedAt = Date.now();
		const summary: AdrImplDriftSummary = {
			totalDrift: 0,
			projects: 0,
			sent: false,
			failed: false,
			took_ms: 0,
		};

		const engine = getVaultEngine();
		if (!engine) {
			summary.failed = true;
			summary.error = 'no-vault-engine';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const allIssues = await getAdrImplementationDrift(engine);
		summary.totalDrift = allIssues.length;

		if (allIssues.length === 0) {
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		// Apply hard total cap before grouping so per-project budgets are
		// drawn from the trimmed pool. Path-ordered slice keeps the
		// behaviour deterministic across runs.
		const issues = allIssues
			.slice()
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, maxTotal);
		const groups = groupByProject(issues);
		summary.projects = groups.size;

		const chatId = resolveTelegramChatId();
		if (!chatId) {
			summary.failed = true;
			summary.error = 'no-telegram-chat-id';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const delivery = soulHubConfig.channels?.telegram?.delivery;
		if (!delivery) {
			summary.failed = true;
			summary.error = 'no-telegram-delivery-config';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		const dashboardUrl = soulHubConfig.host
			? soulHubConfig.host.replace(/\/$/, '')
			: null;

		const message = formatDigest(groups, allIssues.length, maxPerProject, dashboardUrl);
		const result = await sendText(chatId, message, delivery);
		if (!result.ok || result.messageIds.length === 0) {
			summary.failed = true;
			summary.error = result.error ?? 'send-failed';
			summary.took_ms = Date.now() - startedAt;
			return summary;
		}

		summary.sent = true;
		summary.took_ms = Date.now() - startedAt;
		return summary;
	};
}
