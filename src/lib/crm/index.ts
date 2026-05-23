/** CRM module — public API. See ADR 2026-05-11-crm-local-sqlite-transition. */

export {
	getCrmDb, closeCrmDb,
	addContact, getContact, listContacts, countContacts, searchContacts,
	updateContact, updateContactStage, setNextFollowup, deleteContact,
	addContactEmail, setPrimaryEmail, removeContactEmail, listContactEmails, findContactByEmail,
	// Phones — mirror of emails (Stage F2 — phone support)
	addContactPhone, setPrimaryPhone, removeContactPhone, listContactPhones, findContactByPhone,
	addInteraction, listInteractions,
	addTag, tagContact, listContactTags,
	listStageHistory, listFollowups,
	// D10 — vault-note attachments
	listContactNotes, attachNote, detachNote, findContactsByVaultPath,
	type ListContactsOptions, type AddContactEmailInput, type AddContactPhoneInput, type AddInteractionInput,
	type ListFollowupsOptions, type UpdateContactFields, type RemoveContactEmailResult, type RemoveContactPhoneResult,
} from './db.js';

export type {
	Contact, ContactEmail, ContactEmailMatch, ContactPhone, ContactPhoneMatch, ContactWithEmails,
	Interaction, StageHistory, Tag,
	ContactStage, ContactSource,
	InteractionChannel, InteractionDirection,
	NewContactInput,
	// D10
	ContactNote, ContactNoteKind, AttachNoteInput, AttachNoteResult,
} from './types.js';
export { CONTACT_STAGES, CONTACT_NOTE_KINDS } from './types.js';

// Stage B — cross-DB bridge.
export {
	listMessagesForContact,
	enrichInboxRowsWithContact,
	findWebsiteLeads,
	isCrmContact,
	type ListMessagesForContactOptions,
	type InboxRowEnrichment,
	type WebsiteLeadsOptions,
	type WebsiteLeadCandidate,
} from './inbox-bridge.js';

// Stage B — vault frontmatter sync.
export {
	syncContactToVault,
	defaultContactPath,
	archiveCrmFrontmatter,
	type SyncContactResult,
} from './vault-sync.js';
