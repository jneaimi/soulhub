/** Inbox module — public API */
export {
	getInboxDb, closeInboxDb,
	addAccount, getAccount, listAccounts, removeAccount,
	updateAccountStatus, updateAccountLastSync, getAccountCredential,
	upsertMessage, upsertMessages, listMessages, getMessage, getMessageCount,
	getSyncState, upsertSyncState, getInboxStats,
	pruneOldMessages, deleteMessagesByFolder, updateAccountSettings, updateAccountCredential,
	listOauthClients, getOauthClient, getDefaultOauthClient, countAccountsUsingOauthClient,
	createOauthClient, updateOauthClient, deleteOauthClient, touchOauthClientUsage,
	// Layer 2 filter
	listFilterRules, getFilterRule, insertFilterRule, setFilterRuleEnabled, deleteFilterRule,
	getFilterCache, setFilterCache, bumpFilterCacheHit,
	applyClassification, setMessageHeaderSignals, markMessageProcessed,
	listMessagesForFiltering, reclassifyBySignature, getFilterStats,
	rowToMessage,
	// Layer 3 Stage 2 — structured extraction + agent audit log
	getExtractedData, setExtractedData, recordAgentAction, listAgentActions,
	countConfirmedMarkProcessed, queryAgentActions,
	type MessageListOptions, type AgentActionInput, type AgentActionRow,
	type AgentActionsQuery, type AgentActionsResult,
} from './db.js';

export type {
	InboxAccount, InboxMessage, SyncState,
	InboxProvider, AccountStatus, StoredCredential,
	AttachmentMeta, OauthClient,
	FilterCategory, FilterRule, FilterRuleMatchType, FilterCacheEntry,
	HeaderSignals,
} from './types.js';
export { CATEGORY_TO_STATUS } from './types.js';

export {
	startFilterWorker, stopFilterWorker, getFilterWorkerStatus,
	correctClassification,
} from './filter.js';
export { cacheSignature } from './filter-rules.js';

export {
	routeMessageToVault,
	type RouteToVaultResult,
	type RouteToVaultOptions,
} from './route-to-vault.js';
export {
	startAutoRouteWorker, stopAutoRouteWorker,
	runAutoRouteTick, listAutoRouteCandidates, evaluateAutoRouteRule,
	type AutoRouteDecision, type AutoRouteReason, type AutoRouteTickResult,
} from './auto-route.js';

export { encrypt, decrypt } from './crypto.js';

export {
	getAuthUrl, exchangeCode, refreshAccessToken, getValidToken, isTokenExpired,
	resolveClientCredsByRef, resolveClientCredsForAccount,
} from './oauth.js';
export type { OAuthTokens, ClientCreds } from './oauth.js';

export { getOutlookAuthUrl, exchangeOutlookCode, getValidOutlookToken, getOutlookUserEmail } from './outlook.js';
export type { OutlookTokens } from './outlook.js';

export {
	startSync, stopSync, startAccountSync, stopAccountSync,
	getSyncEmitter, getSyncStatus,
} from './sync.js';

export { fetchImapBody, fetchImapHeaders, fetchImapAttachment } from './body.js';
export type { MessageBody, AttachmentBytes } from './body.js';

// Layer 3 Stage 2 — structured extraction
export { extractTransactional, inputFromMessage } from './extractor.js';
export type {
	TransactionalKind,
	TransactionalExtract,
	ExtractInput,
	ExtractResult,
} from './extractor.js';

// Layer 3 Stage 3a — real-time anomaly push
export {
	listAnomalyPushCandidates,
	evaluateAnomalyGate,
	formatAnomalyMessage,
} from './anomaly.js';
export type {
	AnomalyConfig,
	AnomalyReason,
	AnomalyDecision,
	ListAnomalyCandidatesOptions,
} from './anomaly.js';

// Layer 3 — composite drill-down (envelope + extract + audit + preview)
export { composeDrillDown } from './drill-down.js';
