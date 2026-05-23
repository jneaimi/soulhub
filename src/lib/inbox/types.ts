/** Inbox module types */

export type InboxProvider = 'icloud' | 'gmail' | 'outlook' | 'imap';

export type AccountStatus = 'connected' | 'syncing' | 'error' | 'disconnected';

/** Layer 2 filter — see ADR 2026-05-11-inbox-processing-filter-layer. */
export type FilterCategory =
	| 'personal'
	| 'transactional'
	| 'notification'
	| 'promotional'
	| 'bulk'
	| 'unclassified';

/** process_status derived from category. queued surfaces to agents; skipped is hidden. */
export const CATEGORY_TO_STATUS: Record<FilterCategory, 'queued' | 'skipped'> = {
	personal: 'queued',
	transactional: 'queued',
	notification: 'queued',
	unclassified: 'queued',
	promotional: 'skipped',
	bulk: 'skipped',
};

export type FilterRuleMatchType =
	| 'header_present'
	| 'header_value'
	| 'sender_domain'
	| 'sender_pattern'
	| 'subject_pattern';

export interface FilterRule {
	id: number;
	accountId: string | null;
	precedence: number;
	matchType: FilterRuleMatchType;
	matchValue: string;
	actionCategory: FilterCategory;
	reason: string | null;
	createdAt: number;
	createdBy: 'system' | 'user' | 'agent';
	enabled: boolean;
}

export interface FilterCacheEntry {
	signature: string;
	category: FilterCategory;
	reason: string | null;
	hitCount: number;
	firstHitAt: number;
	lastHitAt: number;
	userCorrected: boolean;
}

/** Parsed signals from RFC822 headers, persisted as JSON in messages.header_signals. */
export interface HeaderSignals {
	listUnsubscribe?: boolean;
	listId?: string;
	precedence?: string;
	autoSubmitted?: string;
	isNoreplySender?: boolean;
	isMarketingDomain?: boolean;
	dmarcPass?: boolean;
}

export interface InboxAccount {
	id: string;
	label: string;
	provider: InboxProvider;
	email: string;
	host?: string;
	port?: number;
	status: AccountStatus;
	lastSync: number | null;
	lastError: string | null;
	createdAt: number;
	retentionDays: number;
	/** FK into `oauth_clients.id`. NULL for providers that don't use OAuth
	 *  (e.g. iCloud app-specific password). See ADR
	 *  2026-05-11-oauth-clients-as-first-class-connections. */
	oauthClientRef: string | null;
}

/** A reusable OAuth client identity (provider + credentials). Accounts
 *  reference these by FK. Managed via Settings → Connections. */
export interface OauthClient {
	id: string;
	provider: InboxProvider;
	label: string;
	clientId: string;
	clientSecretEncrypted: string;
	isDefault: boolean;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface InboxMessage {
	id: number;
	accountId: string;
	uid: number;
	uidValidity: number;
	folder: string;
	messageId: string | null;
	threadId: string | null;
	inReplyTo: string | null;
	subject: string;
	fromAddress: string;
	fromName: string | null;
	toAddress: string;
	dateSent: number | null;
	dateReceived: number;
	flags: string[];
	hasAttachments: boolean;
	bodyPreview: string;
	rawSize: number;
	syncedAt: number;
	processStatus: string;
	attachmentsMeta: AttachmentMeta[];
	attachmentCount: number;
	isFlagged: boolean;
	/** Layer 2 filter outputs. NULL until classified. */
	category: FilterCategory | null;
	filterReason: string | null;
	filteredAt: number | null;
	/** Raw HeaderSignals as JSON string. Populated lazily. */
	headerSignals: string | null;
	/** Layer 3 marker — epoch ms when an agent called inbox-mark-processed.
	 *  NULL while the row is anything other than `processed`. Drives the
	 *  365-day retention window for processed mail. */
	processedAt: number | null;
	/** Layer 3 Stage 2 — JSON-encoded TransactionalExtract (see extractor.ts).
	 *  NULL when extraction has not yet run for this row. */
	extractedData: string | null;
	/** Epoch ms when the extractor wrote `extracted_data` (success or
	 *  cached-failure stub). NULL until first extraction attempt. */
	extractedAt: number | null;
}

export interface AttachmentMeta {
	filename: string;
	size: number;
	mimeType: string;
	part?: string;
	isInline: boolean;
}

export interface SyncState {
	accountId: string;
	folder: string;
	lastUid: number;
	uidValidity: number;
	lastSync: number;
}

/** Credential stored encrypted at rest */
export interface StoredCredential {
	type: 'password' | 'oauth2';
	/** For password: the app-specific password. For oauth2: JSON { accessToken, refreshToken, expiresAt } */
	data: string;
}
