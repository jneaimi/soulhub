/** System Health types — the immune system for Soul Hub */

// ── Notifications ──────────────────────────────────────────

export type NotificationSource = 'vault' | 'pipeline' | 'playbook' | 'system';
export type NotificationSeverity = 'info' | 'warning' | 'action_required';
export type ActionType = 'script' | 'claude' | 'api';

export interface SystemAction {
	id: string;
	label: string;
	type: ActionType;
	/** For type: script — shell command to run */
	command?: string;
	/** For type: claude — prompt to send to headless Claude session */
	prompt?: string;
	/** Working directory for script/claude actions */
	cwd?: string;
	/** For type: api — internal Soul Hub endpoint */
	endpoint?: string;
	/** For type: api — HTTP method */
	method?: string;
	/** For type: api — JSON body */
	body?: Record<string, unknown>;
}

export interface SystemNotification {
	id: string;
	source: NotificationSource;
	severity: NotificationSeverity;
	title: string;
	detail: string;
	/** Available actions the human can take */
	actions: SystemAction[];
	created: number;
	/** When the user dismissed this notification */
	dismissed?: number;
	/** Resolution record — what action was taken */
	resolved?: {
		actionId: string;
		at: number;
		result: string;
	};
}

// ── Health Detection ───────────────────────────────────────

export type IssueType =
	| 'orphan_notes'
	| 'dead_links'
	| 'missing_index'
	| 'stale_inbox'
	| 'governance_violation'
	| 'missing_frontmatter';

export type IssueRisk = 'safe' | 'needs_human' | 'needs_claude';

export interface DetectedIssue {
	type: IssueType;
	risk: IssueRisk;
	title: string;
	detail: string;
	/** Affected file paths */
	paths: string[];
	/** Auto-generated actions for this issue */
	actions: SystemAction[];
}

// ── Heal Results ───────────────────────────────────────────

export interface HealResult {
	type: IssueType;
	fixed: string[];
	skipped: string[];
	errors: { path: string; error: string }[];
}

export interface HealthReport {
	timestamp: string;
	totalNotes: number;
	issues: DetectedIssue[];
	autoFixed: HealResult[];
	notificationsCreated: number;
}
