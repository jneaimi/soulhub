/** Vault-actions barrel — public surface for the WhatsApp `/save`,
 *  `/find`, `/recent` slash commands. Mirrors the `vault-chat/index.ts`
 *  shape so the dispatcher imports stay consistent across intents.
 *
 *  Renamed from `src/lib/brain/` per ADR-028 Phase 3 (May 2026). The
 *  module backed the legacy "second brain" terminology that
 *  [[../../projects/soul-hub-whatsapp/adr-019-vault-git-migration|ADR-019]]
 *  obsoleted when the standalone Soul Hub vault landed. `dispatchVaultSaveNote`
 *  carries the `-Note` suffix to disambiguate from the orchestrator-v2
 *  `vaultSave` tool, which writes via the engine's createNote API. */

export { dispatchVaultSaveNote } from './save.js';
export type { VaultSaveNoteInput, VaultSaveNoteResult } from './save.js';
export { dispatchVaultFind } from './find.js';
export type { VaultFindResult } from './find.js';
export { dispatchVaultRecent } from './recent.js';
export type { VaultRecentResult } from './recent.js';
