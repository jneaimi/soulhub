/**
 * Orchestrator public surface — the WhatsApp inbound handler imports from
 * here. The classifier itself lives in `src/lib/orchestrator-v2/` (ADR-009);
 * this module owns the shared infrastructure both v2 and the inbound flow
 * use: dispatch worker, active-run registry, capacity caps, pending
 * proposals + audit history, and metrics.
 */

export { runInBackground } from './worker.js';
export type { RunInBackgroundArgs } from './worker.js';
export {
	setActive,
	clearActive,
	cancelByJid,
	listActive,
	listActiveByJid,
} from './active-runs.js';
export type { ActiveRun } from './active-runs.js';
export type { OrchestratorAction, OrchestratorDecision, DecideResult } from './types.js';
export { getOrchestratorMetrics } from './metrics.js';
export type { OrchestratorMetrics } from './metrics.js';
export { checkCapacity, formatCapacityRejection, PER_JID_CAP, GLOBAL_CAP } from './concurrency.js';
export type { CapacityResult } from './concurrency.js';
export {
	setPending,
	getPending,
	clearPending,
	resolvePending,
	classifyProposalReply,
	formatProposal,
	formatExpiredPrompt,
} from './pending-proposals.js';
export type { PendingProposal, ProposalReplyKind } from './pending-proposals.js';
export {
	recentProposals,
	statsByAgent,
} from './proposal-history.js';
export type {
	ProposalResolution,
	ProposalOrigin,
	ProposalHistoryRow,
	ProposalStats,
} from './proposal-history.js';
