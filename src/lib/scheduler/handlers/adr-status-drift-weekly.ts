/** Scheduler handler: adr-status-drift-weekly.
 *
 *  Per `~/vault/projects/soul-hub/decisions/2026-05-18-adr-status-body-frontmatter-consistency.md`.
 *
 *  Runs weekly (Monday 09:00 Dubai by default). Walks every `type:
 *  decision` note in the vault, compares the frontmatter `status` value
 *  to what the body's `## Status` section claims, and sends a single
 *  Telegram digest message grouped by project.
 *
 *  Detect-only — the operator decides which side (body or frontmatter)
 *  is correct per ADR. Auto-fix and chokepoint enforcement are
 *  explicitly deferred to Phase 2/3 in the ADR.
 *
 *  Mirrors the resolution + delivery pattern from
 *  `audit-nudge-telegram.ts`.
 *
 *  Settings shape:
 *    {
 *      id: 'adr-status-drift-weekly',
 *      type: 'adr-status-drift-weekly',
 *      cron: '0 9 * * 1',
 *      timezone: 'Asia/Dubai',
 *      params: { maxPerProject?: number, maxTotal?: number }
 *    } */

import { config as soulHubConfig } from '../../config.js';
import { sendText } from '../../channels/telegram/outbound.js';
import { getVaultEngine } from '../../vault/index.js';
import {
	getAdrStatusDrift,
	groupByProject,
	type AdrStatusDriftIssue,
} from '../../vault-hygiene/adr-status-drift.js';
import type { TaskFn } from '../task-types.js';

interface AdrStatusDriftParams {
	/** Cap rows surfaced per project in the digest. Excess rolled up
	 *  into a trailing "+N more" line per project. Default 8. */
	maxPerProject?: number;
	/** Hard cap on total rows in the digest. Default 40. */
	maxTotal?: number;
}

export interface AdrStatusDriftSummary {
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

function arrow(direction: AdrStatusDriftIssue['direction']): string {
	if (direction === 'body-ahead') return '← body ahead (flip FM?)';
	if (direction === 'fm-ahead') return '← FM ahead (refresh body?)';
	return '← sideways';
}

function formatDigest(
	groups: Map<string, AdrStatusDriftIssue[]>,
	totalDrift: number,
	maxPerProject: number,
): string {
	const date = new Date().toISOString().slice(0, 10);
	const lines: string[] = [
		`📋 ADR status drift — week of ${date}`,
		`${groups.size} project${groups.size === 1 ? '' : 's'}, ${totalDrift} ADR${totalDrift === 1 ? '' : 's'} out of sync`,
	];

	for (const [project, issues] of groups) {
		lines.push('');
		lines.push(`${project} (${issues.length}):`);
		const shown = issues.slice(0, maxPerProject);
		for (const issue of shown) {
			lines.push(
				`  • ${adrSlug(issue.path)}: fm=${issue.fmStatus} body=${issue.bodyStatus} ${arrow(issue.direction)}`,
			);
		}
		const extra = issues.length - shown.length;
		if (extra > 0) {
			lines.push(`  • …+${extra} more`);
		}
	}

	const dashboard = soulHubConfig.host
		? `${soulHubConfig.host.replace(/\/$/, '')}/projects`
		: null;
	if (dashboard) {
		lines.push('');
		lines.push(`Review: ${dashboard}`);
	}

	return lines.join('\n');
}

export function adrStatusDriftWeeklyFactory(rawParams: unknown): TaskFn {
	const params: AdrStatusDriftParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as AdrStatusDriftParams)
			: {};
	const maxPerProject = params.maxPerProject ?? 8;
	const maxTotal = params.maxTotal ?? 40;

	return async (): Promise<AdrStatusDriftSummary> => {
		const startedAt = Date.now();
		const summary: AdrStatusDriftSummary = {
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

		const allIssues = getAdrStatusDrift(engine);
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

		const message = formatDigest(groups, allIssues.length, maxPerProject);
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
