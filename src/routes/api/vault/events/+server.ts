import type { RequestHandler } from './$types';
import { getVaultEvents, type VaultReindexEvent } from '$lib/vault/events.js';

/**
 * GET /api/vault/events — Server-Sent Events stream of vault reindex signals.
 *
 * Clients receive one `data: {...}\n\n` frame per emit. Heartbeats every 30s
 * keep proxies from timing out the connection.
 */
export const GET: RequestHandler = async ({ request }) => {
	const bus = getVaultEvents();

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (event: VaultReindexEvent) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				} catch {
					// Client already disconnected — silent.
				}
			};

			const heartbeat = setInterval(() => {
				try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { /* closed */ }
			}, 30_000);

			// Send a hello so clients know the connection is live
			controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`));

			bus.on('reindexed', send);

			request.signal.addEventListener('abort', () => {
				clearInterval(heartbeat);
				bus.off('reindexed', send);
				try { controller.close(); } catch { /* already closed */ }
			});
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
};
