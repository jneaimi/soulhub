/** Curated registry of the health/hygiene automations the `/orchestration/hygiene`
 *  dashboard renders (soul-hub-hygiene ADR-004; falsifier instrumentation P3).
 *
 *  The scheduler runs ~26 tasks, but only a subset are *health* automations —
 *  checks whose job is to detect drift, rot, or breakage. The rest (signal-forge,
 *  peer-brief content, daily-focus, vault-scout…) are content/workflow tasks and
 *  belong on other surfaces. This allowlist is the curation; `taskId` matches the
 *  scheduler task id so the dashboard can join against `scheduler_runs`.
 *
 *  `expectedMaxStaleHours` is the ADR-004 P3 / ADR-003 P1 falsifier: an automation
 *  that has not *run* within this window has silently stopped — the exact failure
 *  ADR-002 caught by hand (a check that goes blind because it stopped firing).
 *  Windows are deliberately generous (well past the normal cadence + buffer) so
 *  routine gaps never false-positive; only a genuinely stalled task flags `stale`. */

export type AutomationCategory = 'hygiene' | 'falsifier' | 'backup' | 'liveness' | 'anomaly';

export interface HealthAutomation {
	/** Scheduler task id — joins to `scheduler_runs.task_id`. */
	taskId: string;
	/** Human label for the dashboard row. */
	label: string;
	category: AutomationCategory;
	/** What the check is for, one line. */
	purpose: string;
	/** ADR-004 P3 falsifier: max hours since last *run* before the automation is
	 *  considered to have silently stopped (blind). Generous = cadence + buffer. */
	expectedMaxStaleHours: number;
}

/** The curated set. Order is the dashboard's display order (hygiene first). */
export const HEALTH_AUTOMATIONS: readonly HealthAutomation[] = [
	{
		taskId: 'project-hygiene',
		label: 'Project hygiene',
		category: 'hygiene',
		purpose: 'Weekly project-folder anomaly digest (status, staleness, naming, stubs).',
		expectedMaxStaleHours: 192, // weekly + buffer (8d)
	},
	{
		taskId: 'vault-hygiene',
		label: 'Vault hygiene',
		category: 'hygiene',
		purpose: 'Deterministic janitor pass: orphans → index, stale-inbox → zone, missing frontmatter → backfill (ADR-008; keeper retired).',
		expectedMaxStaleHours: 4, // every 30m
	},
	{
		taskId: 'adr-status-drift-weekly',
		label: 'ADR status drift',
		category: 'hygiene',
		purpose: 'Flags ADRs whose status contradicts their open tasks / phase markers.',
		expectedMaxStaleHours: 192, // weekly + buffer
	},
	{
		taskId: 'adr-implementation-drift-weekly',
		label: 'ADR implementation drift',
		category: 'hygiene',
		purpose: 'Flags ADRs still proposed/accepted whose slug appears in a git log main merge commit (ADR-009).',
		expectedMaxStaleHours: 192, // weekly + buffer
	},
	{
		taskId: 'contract-registry-falsifier',
		label: 'Contract registry',
		category: 'falsifier',
		purpose: 'Recompiles the contract cache + self-checks resolution/freshness (governance ADR-002).',
		expectedMaxStaleHours: 4, // hourly + buffer
	},
	{
		taskId: 'notification-budget-falsifier',
		label: 'Keeper retirement',
		category: 'falsifier',
		purpose: 'Asserts zero agent_runs with keeper agent_id after ADR-008 retirement date; red on any post-retirement keeper run (regression guard).',
		expectedMaxStaleHours: 18, // every 6h + buffer
	},
	{
		taskId: 'operator-notification-budget-falsifier',
		label: 'Operator notif budget',
		category: 'falsifier',
		purpose: 'Counts digest-tier operator sends/24h; red if over budget (ADR-004 convergence pile-creep guard).',
		expectedMaxStaleHours: 18, // every 6h + buffer
	},
	{
		taskId: 'audit-assumption-rate-scan',
		label: 'Assumption-rate scan',
		category: 'hygiene',
		purpose: 'Scans recent agent sessions for unverified assumptions.',
		expectedMaxStaleHours: 18, // every 6h
	},
	{
		taskId: 'inbox-anomaly-telegram',
		label: 'Inbox spend anomaly',
		category: 'anomaly',
		purpose: 'Detects above-threshold inbox spend signals and alerts.',
		expectedMaxStaleHours: 30, // every 10m (8-22) + overnight gap
	},
	{
		taskId: 'telegram-liveness',
		label: 'Telegram liveness',
		category: 'liveness',
		purpose: 'Confirms the Telegram channel round-trips.',
		expectedMaxStaleHours: 2, // every 10m
	},
	{
		taskId: 'claude-cli-goal-flag-probe',
		label: 'claude --goal probe',
		category: 'falsifier',
		purpose: 'Falsifier: re-checks whether `claude -p` exposes a `--goal` flag.',
		expectedMaxStaleHours: 800, // monthly + buffer (~33d)
	},
	{
		taskId: 'vault-backup-daily',
		label: 'Vault backup',
		category: 'backup',
		purpose: 'Daily push of the vault git mirror to the private GitHub remote.',
		expectedMaxStaleHours: 36, // daily + buffer
	},
	{
		taskId: 'soul-hub-backup-daily',
		label: 'Soul Hub backup',
		category: 'backup',
		purpose: 'Daily backup of Soul Hub operator state.',
		expectedMaxStaleHours: 36, // daily + buffer
	},
	{
		taskId: 'worktree-janitor-daily',
		label: 'Worktree janitor',
		category: 'hygiene',
		purpose: 'ADR-038 Layer B — daily sweep of orchestration worktrees: reclaims merged, escalates unmerged (abandoned/errored runs).',
		expectedMaxStaleHours: 36, // daily + buffer
	},
];

/** Just the task ids — handy for `IN (...)` filters. */
export const HEALTH_AUTOMATION_IDS: readonly string[] = HEALTH_AUTOMATIONS.map((a) => a.taskId);
