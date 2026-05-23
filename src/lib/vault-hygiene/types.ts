/** Shared shape for the vault hygiene report. Consumed by the API
 *  endpoint, the heartbeat hook, and (read-only) by the keeper agent
 *  prompt. The shape is contract-stable; new fields go on the end so
 *  older keeper prompts continue to parse. */

export interface OrphanIssue {
	path: string;
	title: string;
	suggestedFix: string;
}

export interface UnresolvedIssue {
	source: string;
	raw: string;
	suggestedFix: string;
}

export interface StaleInboxIssue {
	path: string;
	title: string;
	ageDays: number;
	suggestedFix: string;
}

export interface StatusContradictionIssue {
	path: string;
	status: string;
	openTaskCount: number;
	suggestedFix: string;
}

export interface GovernanceViolationIssue {
	path: string;
	violations: string[];
}

/** A note that's in the wrong zone based on its content/source. Surfaced
 *  by the misplacement detector, which uses the same `classifyZone` logic
 *  as `dispatchVaultSave` — so an after-the-fact misplacement check stays
 *  in lockstep with the at-save smart-routing.
 *
 *  `confidence: 'high'` rows are auto-fixable (move + reindex). `'low'`
 *  rows are escalated to the keeper for human judgment — typically project
 *  meetings whose target folder doesn't exist yet ("urbanvision-meeting-recap"
 *  with no `projects/urbanvision/` folder).
 */
export interface MisplacedNoteIssue {
	path: string;
	title: string;
	currentZone: string;
	suggestedZone: string;
	confidence: 'high' | 'low';
	reason: string;
	suggestedFix: string;
}

/** Recommendation the system has generated for a stuck-transactional row.
 *  The operator can ACCEPT (apply the recommendation) or ADVISE (override
 *  with a different kind/zone/tag set). When confidence is 'high' the
 *  keeper can include "I'll route this as X if you don't object" framing;
 *  for 'low' it should ask plainly.
 */
export interface InboxRouteRecommendation {
	suggestedKind: string;        // 'statement', 'payment', 'alert', etc.
	suggestedZone: string;        // 'finance', 'security', 'inbox/shipping', etc.
	suggestedTags: string[];      // additional tags to add
	confidence: 'high' | 'medium' | 'low';
	reasoning: string;            // one-line explanation operator can audit
}

/** A queued inbox row awaiting operator decision — personal mail or
 *  stuck-unknown transactional. Surfaced by the keeper so the operator
 *  sees the queue on every heartbeat tick instead of having to manually
 *  browse the inbox UI. */
export interface InboxDecisionIssue {
	messageId: number;
	bucket: 'personal' | 'stuck-transactional';
	fromAddress: string;
	subject: string;
	ageDays: number;
	receivedAt: string;
	suggestedFix: string;
	/** Auto-generated recommendation for stuck-transactional rows. Absent
	 *  for personal mail (operator-only territory). */
	recommendation?: InboxRouteRecommendation;
}

export interface HygieneTotals {
	indexed: number;
	orphans: number;
	unresolved: number;
	staleInbox: number;
	statusContradictions: number;
	governanceViolations: number;
	misplacedNotes: number;
	inboxDecisions: number;
}

export interface HygieneReport {
	generatedAt: string;
	totals: HygieneTotals;
	healthScore: number;
	orphans: OrphanIssue[];
	unresolved: UnresolvedIssue[];
	staleInbox: StaleInboxIssue[];
	statusContradictions: StatusContradictionIssue[];
	governanceViolations: GovernanceViolationIssue[];
	misplacedNotes: MisplacedNoteIssue[];
	inboxDecisions: InboxDecisionIssue[];
}

/** Heartbeat dispatch threshold — defaults match ADR-010 open Q2.
 *  Tunable in Phase D after live observation. */
export interface HygieneThreshold {
	orphansPlusContradictions: number;
	staleInbox: number;
	governanceViolations: number;
}

export const DEFAULT_HYGIENE_THRESHOLD: HygieneThreshold = {
	orphansPlusContradictions: 1,
	staleInbox: 5,
	governanceViolations: 10,
};

/** Cap noisy issue lists in the dispatch payload — keeper doesn't need
 *  to see all 458 stale items; the first N are enough to triage and the
 *  totals are still accurate. */
export const ISSUE_LIST_CAP = 20;
