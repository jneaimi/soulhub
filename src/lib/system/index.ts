/** System module — public API */
export { SystemHealth, getSystemHealth, initSystemHealth, buildDigestMessage } from './health.js';
export { NotificationStore } from './notifications.js';
export type {
	SystemNotification, SystemAction, NotificationSource, NotificationSeverity,
	ActionType, IssueType, IssueRisk, DetectedIssue, HealResult, HealthReport,
} from './types.js';
