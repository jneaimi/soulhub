/** Public surface for the web channel module — ADR-003.
 *
 *  Mirrors the shape of `channels/telegram/index.ts` and
 *  `channels/whatsapp/index.ts` so the registry can wire all three
 *  channels uniformly: `import { adapter, bootstrap }`.
 *
 *  The web channel has no external service to connect to at startup —
 *  `bootstrap()` is a no-op stub that satisfies the registry's expected
 *  shape without adding latency to the server boot path. */

export { adapter, meta, isConfigured, send } from './adapter.js';
export { webPresenceAdapter } from './presence-adapter.js';
export { dispatchWebTurn } from './dispatch.js';
export type { WebTurnOpts } from './dispatch.js';

/** Idempotent no-op bootstrap — the web channel is always ready.
 *  Included so the registry can call `webBootstrap()` unconditionally
 *  without special-casing the web channel. */
export function bootstrap(): void {
	// No external connection, no credential cache, no watcher to start.
}
