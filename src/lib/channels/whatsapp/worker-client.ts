/** Thin HTTP client for the `soul-hub-whatsapp` worker process. The
 *  main SvelteKit server uses this when `channels.whatsapp.worker.enabled`
 *  is true, so a Baileys crash doesn't take down the web UI. The worker
 *  exposes the same control surface as the in-process adapter: `/login`,
 *  `/status`, `/logout`, `/send`. Requests time out aggressively so a
 *  hung worker can't pin the SvelteKit request loop. */

import type { ConnectionStatus, WhatsAppWorkerConfig } from './types.js';

const DEFAULT_TIMEOUT_MS = 8_000;

interface WorkerSendBody {
	to: string;
	text?: string;
	attachPath?: string;
	kind?: 'image' | 'video' | 'audio' | 'voice' | 'document';
	caption?: string;
	/** ADR-005 Phase 2 — edit the previously sent message in place. The
	 *  worker reconstructs the WAMessageKey from `{id: editId, remoteJid:
	 *  to, fromMe: true}` and passes it as the Baileys `edit` option. */
	editId?: string;
}

interface WorkerSendResult {
	ok: boolean;
	messageId?: string;
	error?: string;
}

function authHeaders(worker: WhatsAppWorkerConfig): Record<string, string> {
	return worker.bearerToken
		? { Authorization: `Bearer ${worker.bearerToken}` }
		: {};
}

async function call<T>(
	worker: WhatsAppWorkerConfig,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetch(`${worker.url}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				...authHeaders(worker),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		const text = await res.text();
		const json = text ? (JSON.parse(text) as unknown) : ({} as unknown);
		if (!res.ok) {
			const message =
				typeof json === 'object' && json !== null && 'error' in json
					? String((json as { error: unknown }).error)
					: `worker ${method} ${path} → ${res.status}`;
			throw new Error(message);
		}
		return json as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function workerStatus(
	worker: WhatsAppWorkerConfig,
): Promise<ConnectionStatus> {
	return call<ConnectionStatus>(worker, 'GET', '/status');
}

export async function workerLogin(
	worker: WhatsAppWorkerConfig,
): Promise<ConnectionStatus> {
	return call<ConnectionStatus>(worker, 'POST', '/login', {});
}

export async function workerLogout(
	worker: WhatsAppWorkerConfig,
	wipeAuth = true,
): Promise<{ ok: true }> {
	return call<{ ok: true }>(worker, 'POST', '/logout', { wipeAuth });
}

export async function workerSend(
	worker: WhatsAppWorkerConfig,
	body: WorkerSendBody,
): Promise<WorkerSendResult> {
	return call<WorkerSendResult>(worker, 'POST', '/send', body);
}

/** Cheap reachability probe — used by the adapter to fall back to
 *  in-process mode when the worker is unreachable, so dev still works
 *  if the user forgot to start the worker PM2 app. */
export async function workerAlive(
	worker: WhatsAppWorkerConfig,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1_500);
		const res = await fetch(`${worker.url}/status`, {
			method: 'GET',
			headers: authHeaders(worker),
			signal: controller.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}
