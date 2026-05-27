/** POST /api/chat/web — Orchestrator web engine (ADR-003).
 *
 *  Streaming SSE endpoint that runs one web chat turn through the orchestrator
 *  and forwards all output (tool events, bubble morphs, final reply) as
 *  Server-Sent Events so the browser drawer (ADR-004) can render live state.
 *
 *  Request body (JSON):
 *  ```json
 *  {
 *    "message":     "...",              // required — the user's text
 *    "scopeKind":   "project",          // required — current scope kind (ADR-002/ADR-006)
 *    "scopeParams": { "slug": "..." }   // required — scope-specific params
 *  }
 *  ```
 *
 *  Scope kinds + required scopeParams (ADR-002 P1 + ADR-006 P3):
 *    - `"project"`      → `{ slug: string }`
 *    - `"vault-note"`   → `{ notePath: string }`
 *    - `"inbox-thread"` → `{}`
 *    - `"crm-contact"`  → `{ contactId: string }`
 *    - `"global"`       → `{}`
 *
 *  Response: `text/event-stream` — a sequence of `data: <JSON>\n\n` lines.
 *  Each event is one of:
 *
 *    Presence events (from `_shared/presence.ts` via `webPresenceAdapter`):
 *      `{ kind: 'bubble',        messageId, text }`
 *      `{ kind: 'bubble-update', messageId, text }`
 *
 *    Orchestrator stream events (forwarded from `decideV2.onStreamEvent`):
 *      `{ kind: 'tool-call-start', toolName }`
 *      `{ kind: 'tool-result',     toolName, ok }`
 *
 *    Terminal event — exactly one per turn:
 *      `{ kind: 'complete', output: V2Output }`
 *      `{ kind: 'error',    message: string  }`
 *
 *  Scope resolution:
 *    - `scopeKind + scopeParams` → `resolveScope` (ADR-002/ADR-006) with a
 *      `ScopeReader` backed by the live vault engine + CRM DB.
 *    - The resulting `scope.contextPayload` is injected as a `system` history
 *      entry into `decideV2` so the orchestrator sees the area context on
 *      every turn without it being stored in `chat_history`.
 *
 *  Conversation key:
 *    - `project`     scope → `web:project:<slug>`
 *    - `vault-note`  scope → `web:vault-note:<notePath>`
 *    - `crm-contact` scope → `web:crm:<contactId>`
 *    - any other scope     → `web:global`
 *    Per ADR-021 the proactive-turn rules apply (same `saveTurn` store).
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { resolveScope } from '$lib/chat/scope/resolve.js';
import type { ScopeReader, CrmContactScopeShape, CrmInteractionScopeItem } from '$lib/chat/scope/types.js';
import { getContact, listInteractions } from '$lib/crm/index.js';
import { dispatchWebTurn } from '$lib/channels/web/dispatch.js';

// ── Scope reader adapter ─────────────────────────────────────────────────────

/**
 * Build a `ScopeReader` backed by the live vault engine + CRM DB.
 *
 * ADR-002 baseline: `getNote` + `listProjectNotes` (vault engine).
 * ADR-006 extensions: `getVaultNoteBacklinks`, `getCrmContact`,
 * `getCrmInteractions` — all wrapped in try/catch so the reader degrades
 * gracefully when the engine or CRM DB is unavailable.
 */
function buildScopeReader(): ScopeReader {
	const engine = getVaultEngine();

	return {
		// ── ADR-002 baseline ────────────────────────────────────────────────
		getNote: (path) => {
			if (!engine) return undefined;
			const note = engine.getNote(path);
			if (!note) return undefined;
			return { meta: note.meta, content: note.content, title: note.title };
		},
		listProjectNotes: (slug, opts) => {
			if (!engine) return [];
			const prefix = `projects/${slug}/`;
			const wantType = opts?.type;
			return engine
				.getAllNotes()
				.filter(
					(n) =>
						n.path.startsWith(prefix) &&
						(wantType === undefined || n.meta.type === wantType),
				)
				.slice(0, 10)
				.map((n) => ({ path: n.path, title: n.title, meta: n.meta }));
		},

		// ── ADR-006 extensions ───────────────────────────────────────────────
		getVaultNoteBacklinks: (path) => {
			if (!engine) return [];
			try {
				return engine.getBacklinks(path).map((n) => n.title);
			} catch {
				return [];
			}
		},
		getCrmContact: (contactId): CrmContactScopeShape | undefined => {
			try {
				const c = getContact(contactId);
				if (!c) return undefined;
				return {
					id: c.id,
					displayName: c.displayName,
					company: c.company,
					role: c.role,
					stage: c.stage,
					notes: c.notes,
				};
			} catch {
				return undefined;
			}
		},
		getCrmInteractions: (contactId, limit): CrmInteractionScopeItem[] => {
			try {
				return listInteractions(contactId, limit).map((ix) => ({
					channel: ix.channel,
					direction: ix.direction,
					summary: ix.summary,
					timestamp: ix.timestamp,
				}));
			} catch {
				return [];
			}
		},
	};
}

// ── Conversation key ──────────────────────────────────────────────────────────

/**
 * Derive a stable `conversationKey` from the scope kind + params.
 * Always prefixed with `web:` so it can never collide with WhatsApp E.164
 * numbers (`+971…`) or Telegram keys (`tg:…`).
 *
 * ADR-006: extended with vault-note and crm-contact keys so each note/contact
 * gets its own isolated conversation history.
 */
function conversationKeyForScope(
	kind: string,
	params: Record<string, string>,
): string {
	if (kind === 'project' && params.slug) {
		return `web:project:${params.slug}`;
	}
	if (kind === 'vault-note' && params.notePath) {
		return `web:vault-note:${params.notePath}`;
	}
	if (kind === 'crm-contact' && params.contactId) {
		return `web:crm:${params.contactId}`;
	}
	if (kind === 'inbox-thread') {
		return 'web:inbox';
	}
	return 'web:global';
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function sseChunk(event: object): Uint8Array {
	return enc.encode(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {
	// Parse + validate the request body.
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (
		typeof body !== 'object' ||
		body === null ||
		typeof (body as Record<string, unknown>).message !== 'string' ||
		typeof (body as Record<string, unknown>).scopeKind !== 'string' ||
		typeof (body as Record<string, unknown>).scopeParams !== 'object'
	) {
		return json(
			{ error: 'Body must include string fields: message, scopeKind, and object scopeParams' },
			{ status: 400 },
		);
	}

	const { message, scopeKind, scopeParams } = body as {
		message: string;
		scopeKind: string;
		scopeParams: Record<string, string>;
	};

	if (!message.trim()) {
		return json({ error: 'message must not be empty' }, { status: 400 });
	}

	// Resolve the scope (ADR-002) to get contextPayload.
	const reader = buildScopeReader();
	const scope = resolveScope(scopeKind, scopeParams, reader);

	const conversationKey = conversationKeyForScope(scope.kind, scopeParams);

	// Build the SSE response stream.  All orchestrator work runs inside
	// `start(controller)` so we can return the Response immediately while
	// the async LLM call proceeds.
	const abortController = new AbortController();
	const requestSignal = request.signal;
	if (requestSignal) {
		// Forward browser abort (tab close / navigation) to the LLM call.
		requestSignal.addEventListener('abort', () => abortController.abort(), {
			once: true,
		});
	}

	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;

			function safeEnqueue(chunk: Uint8Array): void {
				if (!closed) {
					try {
						controller.enqueue(chunk);
					} catch {
						// Stream already closed — swallow silently.
						closed = true;
					}
				}
			}

			function write(event: object): void {
				safeEnqueue(sseChunk(event));
			}

			function safeClose(): void {
				if (!closed) {
					closed = true;
					try {
						controller.close();
					} catch {
						// Already closed.
					}
				}
			}

			try {
				await dispatchWebTurn({
					message,
					conversationKey,
					contextPayload: scope.contextPayload,
					write,
					signal: abortController.signal,
				});
			} catch (err) {
				const msg = (err as Error).message;
				console.error(`[api/chat/web] dispatchWebTurn threw: ${msg}`);
				write({ kind: 'error', message: 'Internal server error — please try again.' });
			} finally {
				safeClose();
			}
		},

		cancel() {
			abortController.abort();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			// Prevent nginx / reverse-proxy buffering from delaying events.
			'X-Accel-Buffering': 'no',
		},
	});
};
