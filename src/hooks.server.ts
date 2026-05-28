import type { Handle } from '@sveltejs/kit';
import { config, reloadConfig } from '$lib/config.js';
import { migrateFeatureFlags } from '$lib/settings-migration.js';
import {
	initSchedulerCore,
	shutdownScheduler,
	registerTaskHandler,
} from '$lib/scheduler/index.js';
import { shellScriptFactory } from '$lib/scheduler/handlers/shell-script.js';
import { dailyFocusFactory } from '$lib/scheduler/handlers/daily-focus.js';
import { vaultScoutFactory } from '$lib/scheduler/handlers/vault-scout.js';
import { inboxDigestFactory } from '$lib/scheduler/handlers/inbox-digest.js';
import { inboxDigestTelegramFactory } from '$lib/scheduler/handlers/inbox-digest-telegram.js';
import { inboxAnomalyTelegramFactory } from '$lib/scheduler/handlers/inbox-anomaly-telegram.js';
import { intentMiningFactory } from '$lib/scheduler/handlers/intent-mining.js';
import { telegramLivenessFactory } from '$lib/scheduler/handlers/telegram-liveness.js';
import { hygieneButtonEscalatorFactory } from '$lib/scheduler/handlers/hygiene-button-escalator.js';
import { auditAssumptionRateFactory } from '$lib/scheduler/handlers/audit-assumption-rate.js';
import { auditNudgeTelegramFactory } from '$lib/scheduler/handlers/audit-nudge-telegram.js';
import { adrStatusDriftWeeklyFactory } from '$lib/scheduler/handlers/adr-status-drift-weekly.js';
import { adrImplementationDriftWeeklyFactory } from '$lib/scheduler/handlers/adr-implementation-drift-weekly.js';
import { heartbeatTaskFactory } from '$lib/scheduler/handlers/heartbeat.js';
import { vaultHygieneTaskFactory } from '$lib/scheduler/handlers/vault-hygiene.js';
import { hygieneDigestFactory } from '$lib/scheduler/handlers/hygiene-digest.js';
import { contractFalsifierFactory } from '$lib/scheduler/handlers/contract-falsifier.js';
import { notificationBudgetFalsifierFactory } from '$lib/scheduler/handlers/notification-budget-falsifier.js';
import { operatorNotificationBudgetFalsifierFactory } from '$lib/scheduler/handlers/operator-notification-budget-falsifier.js';
import { hygieneAgentProposeOnlyCheckFactory } from '$lib/scheduler/handlers/hygiene-agent-propose-only-check.js';
import { updateCheckTaskFactory } from '$lib/scheduler/handlers/update-check.js';
import { worktreeJanitorFactory } from '$lib/scheduler/handlers/worktree-janitor.js';
import { initVault, getVaultEngine } from '$lib/vault/index.js';
import { initSystemHealth, getSystemHealth } from '$lib/system/index.js';
import { listSessions, killSession } from '$lib/pty/manager.js';
import { extractProxyPort, proxyRequest } from '$lib/proxy.js';
import {
	getInboxDb, closeInboxDb, startSync, stopSync,
	startFilterWorker, stopFilterWorker,
	startAutoRouteWorker, stopAutoRouteWorker,
} from '$lib/inbox/index.js';
import { getCrmDb, closeCrmDb } from '$lib/crm/index.js';
import { getFetchPageDb, closeFetchPageDb } from '$lib/fetch-page/index.js';
import { initAgentsWatcher, shutdownAgentsWatcher } from '$lib/agents/watcher.js';
import { sweepInterruptedRuns, sweepAbandonedBudgetApprovals, sweepAbandonedOperatorInputs } from '$lib/agents/runs.js';
import { pruneWorktrees } from '$lib/orchestration/worktree.js';
import { expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import { seedDefaultsIfEmpty } from '$lib/explorer-roots.js';
import { soulHubDataDir, soulHubSettingsPath } from '$lib/paths.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup
import { existsSync } from 'node:fs';
import { reconcileRedeployStatusOnBoot } from '$lib/redeploy/index.js';
import { BUILD_SHA } from '$lib/build-info.js';

const DATA_DIR = soulHubDataDir();

// ADR-055 P3 — settings migration. Back-fill distribution feature-flag defaults
// (e.g. the public `updateCheck: true`) that an install set up on an older
// version never received on `git pull`. Runs BEFORE the scheduler reconcile +
// config-dependent boot steps so a newly-enabled flag-gated task (update-check)
// is registered this boot. reloadConfig() refreshes the in-memory singleton so
// every downstream consumer sees the back-filled value without a restart.
// No-op on the operator's instance (private settings.example.json has no
// `features` block).
try {
	const migrated = migrateFeatureFlags();
	if (Object.keys(migrated.added).length > 0) {
		reloadConfig();
		console.log('[settings-migration] config reloaded after feature-flag back-fill');
	}
} catch (err) {
	console.error('[settings-migration] boot step failed (non-fatal):', err);
}

// Seed file-explorer roots on first run with the previously-hardcoded paths
// so existing flows (vault attachments, project file browsers) keep working
// without manual setup.
try {
	seedDefaultsIfEmpty([
		{ name: 'Dev', path: config.paths.devDir },
		{ name: 'Vault', path: config.paths.vaultDir },
	]);
} catch (err) {
	console.error('[explorer-roots] Failed to seed defaults:', err);
}

// Initialize vault engine (block server until vault is ready)
try {
	await initVault(config.resolved.vaultDir);
} catch (err) {
	console.error('[vault] Failed to initialize:', err);
}

// Initialize system health (detect → heal → notify loop)
try {
	await initSystemHealth(DATA_DIR, config.resolved.vaultDir);
} catch (err) {
	console.error('[system-health] Failed to initialize:', err);
}

// Initialize inbox database + start sync workers
try {
	getInboxDb();
	startSync().then(() => console.log('[inbox] Sync workers started'))
		.catch((err) => console.error('[inbox] Sync start failed:', err));
	// Layer 2 filter worker — ADR 2026-05-11-inbox-processing-filter-layer.
	// Fire-and-forget: auth probe + cold-start may take minutes; we don't
	// want SvelteKit boot to wait. The interval is scheduled inside
	// startFilterWorker() only after cold-start completes.
	startFilterWorker().then(() => console.log('[inbox] Filter worker started'))
		.catch((err) => console.error('[inbox] Filter start failed:', err));
	// Layer 3 Stage 4 auto-route worker — ADR §D5. Idempotent; honors
	// INBOX_AGENT_DISABLED / INBOX_AUTO_ROUTE_DISABLED / cfg.inbox.autoRoute.enabled
	// internally so an unconfigured operator never has rows routed by surprise.
	startAutoRouteWorker(() => config.inbox.autoRoute);
	console.log('[inbox] Database initialized');
} catch (err) {
	console.error('[inbox] Failed to initialize:', err);
}

// Initialize CRM database — ADR 2026-05-11-crm-local-sqlite-transition Stage A.
// Schema-only ship; tools / API / UI follow in later stages. Cheap call
// (file open + migration check) so we run it inline.
try {
	getCrmDb();
	console.log('[crm] Database initialized');
} catch (err) {
	console.error('[crm] Failed to initialize:', err);
}

// Initialize fetch_page database — ADR 2026-05-11-fetch-page-tool.
// Instruments every fetchPage call for the Stagehand resurface decision
// (≥10 distinct js-required hosts over 30 days → resurface trigger).
try {
	getFetchPageDb();
	console.log('[fetch-page] Database initialized');
} catch (err) {
	console.error('[fetch-page] Failed to initialize:', err);
}

// Start agents lane watcher (Phase 2 — bumps store version on file change)
try {
	initAgentsWatcher();
} catch (err) {
	console.error('[agents/watcher] Failed to initialize:', err);
}

// ADR-002 Layer 1 — sweep orphaned `running` agent_runs rows (dispatches lost
// to a process restart before they could finish) to `interrupted`, so killed
// runs stay visible on the audit page instead of vanishing.
try {
	const swept = sweepInterruptedRuns();
	if (swept > 0) console.log(`[agents/runs] swept ${swept} interrupted run(s) on startup`);
} catch (err) {
	console.error('[agents/runs] interrupted-run sweep failed:', err);
}

// ADR-010 (soul-hub-agents) — prune stale git-worktree bookkeeping left by
// coding dispatches whose worktree dir was already removed (e.g. after a ship
// or a crash). `git worktree prune` only clears admin entries for directories
// that no longer exist — it never touches a live worktree pending human review,
// so it's safe to run unconditionally on boot. Best-effort + detached.
void pruneWorktrees(expandHome('~/dev/soul-hub'))
	.then((n) => { if (n > 0) console.log(`[agents/worktree] pruned ${n} stale worktree entr${n === 1 ? 'y' : 'ies'} on startup`); })
	.catch((err) => console.error('[agents/worktree] boot prune failed (non-fatal):', (err as Error).message));

// ADR-006 Phase 2 — sweep budget-approval runs the operator never actioned
// (still `awaiting-budget-approval` past the 6h window) to `budget-exceeded`.
try {
	const swept = sweepAbandonedBudgetApprovals();
	if (swept > 0) console.log(`[agents/runs] swept ${swept} abandoned budget-approval run(s) on startup`);
} catch (err) {
	console.error('[agents/runs] budget-approval sweep failed:', err);
}

// ADR-026 P2 — sweep operator-input runs the operator never answered
// (still `awaiting-operator-input` past the 6h window) to `timeout`.
try {
	const swept = sweepAbandonedOperatorInputs();
	if (swept > 0) console.log(`[agents/runs] swept ${swept} abandoned operator-input run(s) on startup`);
} catch (err) {
	console.error('[agents/runs] operator-input sweep failed:', err);
}

// ADR-018 — reconcile any non-terminal redeploy status left frozen when the
// detached worker was killed by its own `pm2 reload` before it could write
// `done`. A fresh server start proves no redeploy is still in flight, so we
// derive truth from BUILD_SHA: matching toSha → done; mismatch → failed.
// Gated on localRedeploy to skip on public installs that never write the file.
if (config.features.localRedeploy === true) {
	try {
		reconcileRedeployStatusOnBoot(BUILD_SHA);
	} catch (err) {
		console.error('[redeploy] boot reconcile failed (non-fatal):', err);
	}
}

// Register built-in task handlers. Must happen BEFORE initSchedulerCore
// so reconcileFromSettings finds the handlers when it walks the task
// list. New task types (Phase 3+) register here too.
try {
	registerTaskHandler(
		'shell-script',
		shellScriptFactory,
		'Run an arbitrary shell command (e.g. python script) on a cron schedule.',
	);
	registerTaskHandler(
		'daily-focus',
		dailyFocusFactory,
		'Mon-Fri morning focus picker — Slot A (freshest active) + Slot B (oldest stalled).',
	);
	registerTaskHandler(
		'vault-scout',
		vaultScoutFactory,
		'Daily AI-driven vault scout — extracts milestones, synthesizes via Gemini Flash, queues voice-eligible inbox notes.',
	);
	registerTaskHandler(
		'inbox-digest',
		inboxDigestFactory,
		'Daily inbox digest — server-formatted summary of queued mail from the lookback window, excludes already anomaly-pushed rows (Layer 3 Stage 3b).',
	);
	registerTaskHandler(
		'inbox-digest-telegram',
		inboxDigestTelegramFactory,
		'ADR-044 — Telegram-native inbox digest with inline action buttons (Save/Archive/Mute/Draft reply).',
	);
	registerTaskHandler(
		'inbox-anomaly-telegram',
		inboxAnomalyTelegramFactory,
		'ADR-044.H — Telegram-native S3a anomaly push (replaces WhatsApp anomaly rail). Same 4-button keyboard as the digest.',
	);
	registerTaskHandler(
		'intent-mining',
		intentMiningFactory,
		'Daily intent analyst (ADR-023 P1.5) — mines intent_log + chat_history and proposes routing patterns for operator approval.',
	);
	registerTaskHandler(
		'telegram-liveness',
		telegramLivenessFactory,
		'Telegram webhook liveness check (ADR-011 falsifier #5) — calls getWebhookInfo and alerts on pending_update_count > threshold or recent delivery errors.',
	);
	registerTaskHandler(
		'hygiene-button-escalator',
		hygieneButtonEscalatorFactory,
		'Weekly inline-button escalator (ADR-042 pass 2) — runs 1 min after project-hygiene script; reads the fresh digest and sends one Telegram inline-keyboard message per archive_zone_mismatch row.',
	);
	registerTaskHandler(
		'audit-assumption-rate',
		auditAssumptionRateFactory,
		'project-phases ADR-008 S2 — offline scan of ~/.claude/projects/*/*.jsonl session transcripts; runs Layer A scorer + extractLinkedProjects; persists to assumption_audits for the /api/audit/assumption-rate endpoint.',
	);
	registerTaskHandler(
		'audit-nudge-telegram',
		auditNudgeTelegramFactory,
		'project-phases ADR-008 S4 — Telegram nudge for fresh high-score assumption audits; N-in-T threshold, dedup via nudged_at column.',
	);
	registerTaskHandler(
		'adr-status-drift-weekly',
		adrStatusDriftWeeklyFactory,
		'Weekly digest of ADRs whose frontmatter status disagrees with body Status section (per soul-hub/decisions/2026-05-18-adr-status-body-frontmatter-consistency).',
	);
	registerTaskHandler(
		'adr-implementation-drift-weekly',
		adrImplementationDriftWeeklyFactory,
		'soul-hub-hygiene ADR-009 — Weekly digest of ADRs still proposed/accepted whose slug appears in a git log main merge commit. Detect-only; surfaces "Mark shipped" / "Not yet" via /hygiene dashboard.',
	);
	registerTaskHandler(
		'heartbeat',
		heartbeatTaskFactory,
		'ADR-001 P3 — proactive ambient-agent tick (runHeartbeatOnce). Fires every 30m; internal active-hours/mute/cap gates no-op outside the window. Replaces the engine\'s retired private timer.',
	);
	registerTaskHandler(
		'vault-hygiene',
		vaultHygieneTaskFactory,
		'ADR-001 P3 / ADR-008 — deterministic janitor pass (tickVaultHygiene): orphans→index, stale-inbox→zone, frontmatter backfill. Keeper retired 2026-05-26.',
	);
	registerTaskHandler(
		'hygiene-digest',
		hygieneDigestFactory,
		'soul-hub-hygiene ADR-005 P1 — once-daily batched vault-health digest (counts + /hygiene deep-link + bulk fix-links button). Silent on clean days. Replaces per-item escalation spam.',
	);
	registerTaskHandler(
		'contract-registry-falsifier',
		contractFalsifierFactory,
		'soul-hub-governance ADR-002 P2 — recompiles the contract cache from the vault source and runs the registry self-falsifier (resolution + freshness). Errors red on /hygiene when a contract rots; liveness = it keeps firing.',
	);
	registerTaskHandler(
		'notification-budget-falsifier',
		notificationBudgetFalsifierFactory,
		'soul-hub-governance ADR-002 / ADR-008 — keeper-retirement falsifier: asserts zero agent_runs with keeper agent_id after ADR-008 retirement date (2026-05-26). Red on any post-retirement keeper run.',
	);
	registerTaskHandler(
		'operator-notification-budget-falsifier',
		operatorNotificationBudgetFalsifierFactory,
		'soul-hub-governance ADR-004 — falsifier for the operator-notification-budget contract: counts digest-tier operator sends in 24h and errors red on /hygiene if over budget (convergence pile-creep guard).',
	);
	registerTaskHandler(
		'hygiene-agent-propose-only-check',
		hygieneAgentProposeOnlyCheckFactory,
		'ADR-007 P1 — falsifier for hygiene-agent-propose-only contract: asserts zero vault writes attributed to the hygiene-fixer agent (propose-only boundary). Must be green before first fixer dispatch.',
	);
	registerTaskHandler(
		'update-check',
		updateCheckTaskFactory,
		'ADR-010 — daily public-release drift check; fetches GitHub /releases/latest and caches the latest tag for the update-available banner. Task instance only reconciled when features.updateCheck is true.',
	);
	registerTaskHandler(
		'worktree-janitor',
		worktreeJanitorFactory,
		'ADR-038 Layer B — daily safety-net sweep of orchestration worktrees. Reclaims merged worktrees; escalates unmerged (abandoned/errored runs) for operator review. Never force-deletes unreviewed work.',
	);
} catch (err) {
	console.error('[scheduler] handler registration failed:', err);
}

// Initialize the unified scheduler (sweep stale rows → reconcile from
// settings → run catchup-on-boot).
(async () => {
	try {
		const result = await initSchedulerCore(config.scheduler);
		console.log(
			`[scheduler] init: registered=${result.reconcile.registered.length} ` +
				`skipped=${result.reconcile.skipped.length} ` +
				`swept=${result.swept} catchupFired=${result.catchupFired}`,
		);
	} catch (err) {
		console.error('[scheduler] Failed to initialize:', err);
	}
})();

// Recover interrupted orchestration runs on startup
(async () => {
	try {
		const { recoverRuns } = await import('$lib/orchestration/conductor.js');
		const result = await recoverRuns();
		if (result.recovered > 0) {
			console.log(
				`[orchestration] Startup recovery: ${result.recovered} runs, ${result.interrupted} workers interrupted`,
			);
		}
	} catch (err) {
		console.error('[orchestration] Startup recovery failed:', err);
	}
})();

// Graceful teardown for PM2 reload/restart. ADR 2026-05-22-graceful-shutdown-fix:
// signal handling + http-server draining live in `server.js` (the PM2 entry that
// owns the http.Server). This function does the lib-level teardown and is invoked
// by server.js via the `globalThis.__soulHubShutdown` reference set below. It must
// NOT call process.exit — server.js owns exit discipline (flushed exit within
// kill_timeout). Every step here is awaited so teardown completes before exit.
export async function shutdownSoulHub(): Promise<void> {
	console.log(`[soul-hub] Draining connections...`);

	const activeIds = listSessions();
	for (const id of activeIds) {
		killSession(id);
	}
	console.log(`[soul-hub] Cleaned up ${activeIds.length} PTY sessions`);

	// Shutdown system health (stop health loop)
	const systemHealth = getSystemHealth();
	if (systemHealth) systemHealth.shutdown();

	// Shutdown inbox sync + filter + auto-route workers, then close database.
	stopSync().catch(() => {});
	stopFilterWorker().catch(() => {});
	stopAutoRouteWorker();
	closeInboxDb();

	// Close CRM database (no workers — schema-only at Stage A).
	closeCrmDb();

	// Close fetch_page log database.
	closeFetchPageDb();

	// Shutdown vault engine (stop file watcher)
	const vault = getVaultEngine();
	if (vault) vault.shutdown();

	// Stop the agents-lane watcher (close chokidar handles cleanly)
	shutdownAgentsWatcher().catch(() => {});

	// Stop every cron task so PM2 reload doesn't leak intervals.
	shutdownScheduler();

	// Cleanup orchestration workers — awaited so it completes before exit.
	try {
		const { listRuns } = await import('$lib/orchestration/board.js');
		const { killWorkerAsync } = await import('$lib/orchestration/conductor.js');
		const runs = await listRuns(100);
		let orchCount = 0;
		for (const run of runs) {
			if (run.status !== 'running' && run.status !== 'approved') continue;
			for (const [taskId, worker] of Object.entries(run.workers)) {
				if (worker.status === 'running') {
					await killWorkerAsync(run.runId, taskId).catch(() => {});
					orchCount++;
				}
			}
		}
		if (orchCount > 0) console.log(`[soul-hub] Cleaned up ${orchCount} orchestration workers`);
	} catch {
		// Orchestration module may not be ready — skip
	}

	console.log(`[soul-hub] Shutdown complete`);
}

// ADR 2026-05-22-graceful-shutdown-fix P1d — expose teardown to the PM2 entry
// (`server.js`), which owns the http.Server and signal handling. Set on
// globalThis rather than imported by chunk path: the SvelteKit build chunk is
// hash-named (`hooks.server-<hash>.js`) and unresolvable from server.js. The
// entry imports the handler — loading this module top-level — before it calls
// `server.listen`, so this reference is set before any signal can arrive.
(globalThis as typeof globalThis & { __soulHubShutdown?: () => Promise<void> }).__soulHubShutdown =
	shutdownSoulHub;

/**
 * Defense-in-depth gate for /api/files/*. Blocks cross-site reads (the
 * realistic CSRF / exfiltration threat) while leaving legit same-origin
 * fetches from the SvelteKit frontend untouched. API clients (curl,
 * scripts) authenticate explicitly via Authorization: Bearer ${SOUL_HUB_SECRET}.
 *
 * Why this works without a session: Sec-Fetch-Site is set by the browser
 * and can't be forged from JS, so a malicious page embedding
 * <img src="https://soul-hub../api/files?action=raw..."> sends
 * `Sec-Fetch-Site: cross-site` and gets rejected.
 */
function checkFileApiAccess(request: Request): { ok: true } | { ok: false; reason: string } {
	const auth = request.headers.get('authorization') || '';
	const secret = process.env.SOUL_HUB_SECRET;
	if (secret && auth === `Bearer ${secret}`) return { ok: true };

	const fetchSite = request.headers.get('sec-fetch-site');
	// Allowed: same-origin (page fetch), same-site (subdomain), none (direct navigation / SSR fetch).
	// Rejected: cross-site (third-party origin).
	if (fetchSite === 'cross-site') {
		return { ok: false, reason: 'cross-site requests must use Authorization: Bearer header' };
	}
	return { ok: true };
}

/**
 * ADR-016 — map old top-level orchestration URLs to their new
 * `/orchestration/*` equivalents. Returns the new path+search if a
 * redirect is needed, or null otherwise. Order is significant: the
 * `/agents/orchestrator` exact match wins before the `/agents` prefix.
 *
 * API routes (`/api/agents`, `/api/skills`) are NOT redirected — only
 * page URLs moved.
 */
function redirectOrchestration(pathname: string, search: string): string | null {
	// Exact rewrite: /agents/orchestrator → /orchestration/metrics
	if (pathname === '/agents/orchestrator') {
		return '/orchestration/metrics' + search;
	}
	// Prefix rewrite: /agents → /orchestration/agents (covers /, /new, /[id]/runs, etc.)
	if (pathname === '/agents' || pathname.startsWith('/agents/')) {
		return '/orchestration' + pathname + search;
	}
	// Prefix rewrite: /skills → /orchestration/skills (covers /, /install)
	if (pathname === '/skills' || pathname.startsWith('/skills/')) {
		return '/orchestration' + pathname + search;
	}
	// Exact + prefix rewrite: /orchestrator/tools → /orchestration/tools
	if (pathname === '/orchestrator/tools' || pathname.startsWith('/orchestrator/tools/')) {
		return '/orchestration/tools' + pathname.slice('/orchestrator/tools'.length) + search;
	}
	return null;
}

/**
 * ADR-037 — code-workspace pages renamed from `/projects` + `/project/[name]`
 * to `/workspaces` + `/workspace/[name]`. The old `/projects` URL is now
 * the managed-initiative home (vault projects), so we DO NOT redirect it.
 * Only the per-workspace detail URL and the API are redirected.
 */
function redirectWorkspaces(pathname: string, search: string): string | null {
	// Exact + prefix: /project/foo → /workspace/foo (workspace detail pages)
	if (pathname === '/project' || pathname.startsWith('/project/')) {
		return '/workspace' + pathname.slice('/project'.length) + search;
	}
	// API rewrite: /api/projects[/...] → /api/workspaces[/...] (any cached fetch
	// from a stale page bundle keeps working until the operator hard-refreshes)
	if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
		return '/api/workspaces' + pathname.slice('/api/projects'.length) + search;
	}
	return null;
}

// Dev port proxy — intercept pXXXX.soul-hub.jneaimi.com before SvelteKit router
/**
 * ADR-008 (oss-hardening) — feature-flag page guard. Returns '/' when the
 * requested path belongs to a module whose visibility flag is off, else null.
 * Guards only PAGE routes (the frontend surface) so deep-links can't bypass the
 * hidden nav; `/api/*` is intentionally left intact so core code paths that
 * call those endpoints keep working. Operator default is all-flags-true (no-op);
 * the public export seeds them false.
 */
function featureGuardRedirect(pathname: string): string | null {
	const f = config.features;
	const hits = (prefixes: string[]) =>
		prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));
	if (!f.naseej && hits(['/naseej'])) return '/';
	// `/projects` is vault project tracking — core vault surface, always visible.
	// Only the code-WORKSPACES launcher (`/workspaces`, `/workspace`) is gated;
	// `/project/*` is 301'd to `/workspace/*` upstream and caught there.
	if (!f.workspaces && hits(['/workspaces', '/workspace'])) return '/';
	if (!f.playbook && hits(['/playbooks'])) return '/';
	return null;
}

export const handle: Handle = async ({ event, resolve: svelteResolve }) => {
	const hostname = event.request.headers.get('host') || '';
	const proxyPort = extractProxyPort(hostname);

	if (process.env.DEBUG) {
		console.log(`[proxy-debug] host="${hostname}" url="${event.request.url}" port=${proxyPort}`);
	}

	if (proxyPort !== null) {
		console.log(`[proxy] ${hostname} → localhost:${proxyPort} ${event.request.method} ${new URL(event.request.url).pathname}`);
		return proxyRequest(event.request, proxyPort);
	}

	const pathname = event.url.pathname;

	// ADR-016 — 301 redirects for the old orchestration cluster URLs.
	// Order matters: more-specific prefixes first so `/agents/orchestrator`
	// doesn't get rewritten to `/orchestration/agents/orchestrator`.
	const orchestrationRedirect = redirectOrchestration(pathname, event.url.search);
	if (orchestrationRedirect) {
		return new Response(null, { status: 301, headers: { location: orchestrationRedirect } });
	}

	// ADR-037 — 301 redirects for the workspace pages (renamed from /project/*).
	// /projects is intentionally NOT redirected because that URL now hosts the
	// new managed-initiative page. Operators with bookmarks to /projects will
	// see the new page, which is the desired V1 behaviour.
	const workspacesRedirect = redirectWorkspaces(pathname, event.url.search);
	if (workspacesRedirect) {
		return new Response(null, { status: 301, headers: { location: workspacesRedirect } });
	}

	// ADR-008 — feature-flag page guard. Hide not-yet-released module pages
	// (Naseej, Workspaces) and the decommissioning Playbook engine when their
	// flag is off. 302 (not 301) because flags can flip when a feature ships.
	const featureRedirect = featureGuardRedirect(pathname);
	if (featureRedirect) {
		return new Response(null, { status: 302, headers: { location: featureRedirect } });
	}

	// First-run gate: if ~/.soul-hub/settings.json is missing, redirect HTML
	// page loads to /setup. API requests and asset fetches pass through so the
	// wizard itself can call /api/settings, /api/secrets, and load its bundle.
	// The check is gated on `Accept: text/html` so only top-level navigations
	// see the redirect — fetch/XHR responses stay normal.
	if (!pathname.startsWith('/setup')) {
		const accept = event.request.headers.get('accept') || '';
		const isHtmlNav = accept.includes('text/html');
		if (isHtmlNav && !existsSync(soulHubSettingsPath())) {
			return new Response(null, { status: 302, headers: { location: '/setup' } });
		}
	}

	if (pathname.startsWith('/api/files') || pathname.startsWith('/api/settings/explorer-roots')) {
		const check = checkFileApiAccess(event.request);
		if (!check.ok) {
			return new Response(JSON.stringify({ error: 'Unauthorized', reason: check.reason }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	return svelteResolve(event);
};
