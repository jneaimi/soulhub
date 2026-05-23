/** Vault chat orchestrator — see ADR-004 (lexical-first vault chat).
 *  Public surface intentionally tiny: callers only need `dispatchVaultChat`
 *  and the result/trace types. Internal modules (tools, selector, retrieval,
 *  format) are implementation details. */

export { dispatchVaultChat } from './orchestrate.js';
export type { VaultChatResult, VaultChatTrace } from './orchestrate.js';
export {
	loadHistory,
	saveTurn,
	resetConversation,
	pruneStaleHistory,
	isResetCommand,
	HISTORY_POLICY,
} from './history.js';
