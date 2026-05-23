/**
 * Custom server wrapper for Soul Hub.
 * Intercepts requests BEFORE SvelteKit's static asset handler,
 * enabling the port proxy to work for ALL paths (including /_app/).
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { handler } from './build/handler.js';

const PORT = parseInt(process.env.PORT || '2400');

// Resolve settings.json from ~/.soul-hub/ first, falling back to repo root
// (legacy). Returns parsed JSON or null when no settings file exists.
function resolveSettings() {
	const home = process.env.SOUL_HUB_HOME || resolve(homedir(), '.soul-hub');
	const candidates = [
		process.env.SOUL_HUB_SETTINGS,
		resolve(home, 'settings.json'),
		new URL('./settings.json', import.meta.url).pathname,
	].filter(Boolean);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { /* try next */ }
	}
	return null;
}

// Lazy-load proxy module from the build output
let proxyModule = null;
async function getProxy() {
	if (!proxyModule) {
		// Import the built hooks which contain extractProxyPort and proxyRequest
		const hooks = await import('./build/server/chunks/hooks.server.js').catch(() => null);
		if (!hooks) {
			// Fallback: inline the proxy logic
			const { request: httpRequest } = await import('node:http');
			const settingsJson = resolveSettings();
			const proxyConfig = settingsJson?.proxy || { enabled: true, allowedPortRange: [1024, 9999], blockedPorts: [2400] };
			const PORT_RE = /^p(\d+)\./;

			proxyModule = {
				extractPort(hostname) {
					if (!proxyConfig.enabled) return null;
					const m = hostname.match(PORT_RE);
					if (!m) return null;
					const port = parseInt(m[1], 10);
					const [min, max] = proxyConfig.allowedPortRange;
					if (port < min || port > max) return null;
					if (proxyConfig.blockedPorts.includes(port)) return null;
					return port;
				},
				proxy(req, res, targetPort) {
					const fwdHeaders = { ...req.headers };
					const originalHost = fwdHeaders.host || '';
					const originalReferer = fwdHeaders.referer;
					fwdHeaders.host = `localhost:${targetPort}`;
					// Rewrite (don't strip) origin/referer — SvelteKit CSRF compares origin
					// to url.origin; stripping origin causes `undefined !== 'http://localhost:PORT'`.
					fwdHeaders.origin = `http://localhost:${targetPort}`;
					if (originalReferer) {
						try {
							const refUrl = new URL(originalReferer);
							fwdHeaders.referer = `http://localhost:${targetPort}${refUrl.pathname}${refUrl.search}`;
						} catch { delete fwdHeaders.referer; }
					}
					fwdHeaders['x-forwarded-host'] = originalHost;
					fwdHeaders['x-forwarded-proto'] = 'https';

					const proxyReq = httpRequest({
						hostname: 'localhost',
						port: targetPort,
						path: req.url,
						method: req.method,
						headers: fwdHeaders,
					}, (proxyRes) => {
						res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
						proxyRes.pipe(res);
					});

					proxyReq.on('error', (err) => {
						res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
						res.end(`<html><body style="font-family:system-ui;padding:2rem">
<h1>502 Bad Gateway</h1>
<p>Could not reach <code>localhost:${targetPort}</code></p>
<p style="color:#666">${err.message}</p>
<p>Make sure a dev server is running on port ${targetPort}.</p>
</body></html>`);
					});

					proxyReq.setTimeout(30000, () => {
						proxyReq.destroy(new Error('Proxy request timed out'));
					});

					req.pipe(proxyReq);
				}
			};
		}
	}
	return proxyModule;
}

const server = http.createServer(async (req, res) => {
	const host = req.headers.host || '';
	const proxy = await getProxy();

	if (proxy) {
		const targetPort = proxy.extractPort(host);
		if (targetPort !== null) {
			return proxy.proxy(req, res, targetPort);
		}
	}

	// Not a proxy request — pass to SvelteKit
	handler(req, res);
});

// ADR 2026-05-22-graceful-shutdown-fix P1b — track open sockets (including
// long-lived SSE streams) so they can be force-destroyed on shutdown. Otherwise
// they hold the event loop open past the exit path and PM2 SIGKILLs at kill_timeout.
const openSockets = new Set();
server.on('connection', (sock) => {
	openSockets.add(sock);
	sock.on('close', () => openSockets.delete(sock));
});

// WebSocket upgrade for proxied dev servers (HMR support)
server.on('upgrade', async (req, socket, head) => {
	const host = req.headers.host || '';
	const proxy = await getProxy();

	if (proxy) {
		const targetPort = proxy.extractPort(host);
		if (targetPort !== null) {
			const { request: httpRequest } = await import('node:http');
			const fwdHeaders = { ...req.headers };
			fwdHeaders.host = `localhost:${targetPort}`;
			delete fwdHeaders.origin;

			const proxyReq = httpRequest({
				hostname: 'localhost',
				port: targetPort,
				path: req.url,
				method: req.method,
				headers: fwdHeaders,
			});

			proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\n` +
					Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
					'\r\n\r\n'
				);
				if (proxyHead.length) socket.write(proxyHead);
				proxySocket.pipe(socket);
				socket.pipe(proxySocket);
			});

			proxyReq.on('error', () => socket.destroy());
			proxyReq.end();
			return;
		}
	}

	// Not a proxy request — SvelteKit doesn't handle WebSocket, just close
	socket.destroy();
});

// ADR 2026-05-22-graceful-shutdown-fix P1a/P1c — this entry owns the http.Server,
// so it owns graceful shutdown (previously a handler in hooks.server.ts that had no
// reference to the server, so SSE sockets held the loop open until SIGKILL). On
// SIGINT/SIGTERM: stop accepting, destroy open sockets, then run the lib teardown
// that hooks.server.ts exposes via globalThis.__soulHubShutdown.
let _shutdownCalled = false;
async function triggerShutdown(signal) {
	if (_shutdownCalled) return;
	_shutdownCalled = true;
	console.log(`[soul-hub] ${signal} — starting graceful shutdown`);

	// Bounded fallback — armed only now (NOT at boot). If teardown stalls past 8s
	// (inside the 10s PM2 kill_timeout), force exit. .unref() so a clean drain can
	// exit earlier without waiting on this timer.
	setTimeout(() => {
		console.error('[soul-hub] Shutdown timed out — forcing exit');
		process.exit(1);
	}, 8000).unref();

	server.close();
	for (const sock of openSockets) sock.destroy();
	openSockets.clear();

	try {
		const shutdown = globalThis.__soulHubShutdown;
		if (typeof shutdown === 'function') {
			await shutdown();
		} else {
			console.error('[soul-hub] __soulHubShutdown not registered — skipping lib teardown');
		}
	} catch (err) {
		console.error('[soul-hub] shutdownSoulHub() threw:', err);
	}

	console.log('[soul-hub] Shutdown complete — exiting');
	// Verification (2026-05-22) showed natural drain does NOT exit: best-effort
	// teardown leaves lingering handles alive (IMAP inbox-sync sockets, workers
	// that are `.catch()`'d not awaited), so the loop never empties and the 8s
	// fallback had to fire. Exit deterministically instead. The 150ms beat lets
	// the final log flush to the PM2 pipe (avoids the process.exit-truncates-
	// stdout footgun). Integrity-critical SQLite closes already ran synchronously
	// inside shutdownSoulHub(); the remaining handles are safe to drop abruptly.
	setTimeout(() => process.exit(0), 150);
}

process.on('SIGTERM', () => triggerShutdown('SIGTERM'));
process.on('SIGINT', () => triggerShutdown('SIGINT'));

// CRITICAL: ecosystem.config.cjs sets `shutdown_with_message: true`, so PM2's
// reload/restart does NOT deliver a Unix signal — it sends an IPC `shutdown`
// message via process.send(). Without this listener the SIGINT/SIGTERM handlers
// above never fire on a normal `pm2 reload` and PM2 SIGKILLs at kill_timeout
// (this was the real reason graceful shutdown never ran for 8 days; a manual
// `kill -TERM` worked only because it IS a real signal). See ADR
// 2026-05-22-graceful-shutdown-fix.
process.on('message', (msg) => {
	if (msg === 'shutdown') triggerShutdown('shutdown-message');
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Listening on http://0.0.0.0:${PORT}`);
});
