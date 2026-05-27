import type { DispatchMode } from './types.js';

/** ADR-026 follow-up — only cheap test-mode probes abort when the browser
 *  disconnects; production/workbench runs are detached and survive refresh.
 *
 *  Found live 2026-05-26: a browser refresh at 7s/0 turns cancelled a
 *  production run because the disconnect signal was wired unconditionally
 *  through the AbortController in `api/agents/[id]/test/+server.ts`.
 *  This predicate is the seam that lets the route guard both abort paths
 *  without tangling them in mode-detection logic inline. */
export function abortsOnClientDisconnect(mode: DispatchMode): boolean {
	return mode !== 'production';
}
