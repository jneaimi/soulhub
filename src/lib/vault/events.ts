/**
 * Vault event bus — a process-wide EventEmitter for reindex signals.
 *
 * Consumers:
 *   - /api/vault/events (SSE endpoint) subscribes to stream 'reindexed' events
 *     to connected browsers.
 *   - Any future analytics / log tailing can piggyback here.
 *
 * Producers:
 *   - VaultEngine emits after chokidar-driven reindex and explicit reindex() calls.
 *   - Healer endpoints can emit after applying fixes (already flow through reindex()).
 */

import { EventEmitter } from 'node:events';

export interface VaultReindexEvent {
	type: 'reindexed';
	/** 'watcher' for chokidar-driven, 'manual' for explicit reindex() calls. */
	reason: 'watcher' | 'manual';
	/** Relative note path for watcher events; omitted for full-scan manual reindex. */
	path?: string;
	/** ms since epoch. */
	at: number;
}

const _global = globalThis as unknown as {
	__soulhub_vault_events?: EventEmitter;
};
if (!_global.__soulhub_vault_events) {
	const bus = new EventEmitter();
	bus.setMaxListeners(100); // many SSE clients may subscribe
	_global.__soulhub_vault_events = bus;
}

export function getVaultEvents(): EventEmitter {
	return _global.__soulhub_vault_events!;
}

export function emitReindex(event: Omit<VaultReindexEvent, 'type' | 'at'>): void {
	const full: VaultReindexEvent = { type: 'reindexed', at: Date.now(), ...event };
	getVaultEvents().emit('reindexed', full);
}
