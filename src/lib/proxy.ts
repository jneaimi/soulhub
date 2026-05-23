/**
 * Dev Port Proxy — routes pXXXX.soul-hub.jneaimi.com to localhost:XXXX
 *
 * Uses Node.js http module instead of fetch because Node 24's undici fetch
 * doesn't resolve localhost to ::1 on IPv6-only listeners.
 */

import { request as httpRequest } from 'node:http';
import { config } from '$lib/config.js';

const MAX_PROXY_BODY = 10 * 1024 * 1024; // 10 MB

const PORT_SUBDOMAIN_RE = /^p(\d+)\./;

/**
 * Extract proxy port from hostname.
 * Returns port number if hostname matches pXXXX.* pattern and port is allowed, null otherwise.
 */
export function extractProxyPort(hostname: string): number | null {
	const proxyConfig = config.proxy;
	if (!proxyConfig.enabled) return null;

	const match = hostname.match(PORT_SUBDOMAIN_RE);
	if (!match) return null;

	const port = parseInt(match[1], 10);
	const [minPort, maxPort] = proxyConfig.allowedPortRange;

	if (port < minPort || port > maxPort) return null;
	if (proxyConfig.blockedPorts.includes(port)) return null;

	return port;
}

/**
 * Proxy a full HTTP request to localhost:targetPort using Node http module.
 * Forwards method, headers, and body. Returns the upstream response.
 */
export async function proxyRequest(request: Request, targetPort: number): Promise<Response> {
	const url = new URL(request.url);
	const originalHost = request.headers.get('host') || '';

	// Build forwarded headers. Strip hop-by-hop + platform-injected headers that
	// confuse dev servers, but keep auth (cookie/authorization) so the proxied
	// app's own sessions survive, and REWRITE origin/referer to the target so
	// SvelteKit/Next/etc CSRF checks pass (they compare origin to url.origin —
	// stripping origin makes `undefined !== 'http://localhost:PORT'` fail).
	const fwdHeaders: Record<string, string> = {};
	const skipHeaders = new Set([
		'host', 'origin', 'referer',
		'proxy-authorization', 'x-real-ip', 'x-forwarded-for',
	]);
	request.headers.forEach((value, key) => {
		if (!skipHeaders.has(key)) fwdHeaders[key] = value;
	});
	fwdHeaders['host'] = `localhost:${targetPort}`;
	fwdHeaders['origin'] = `http://localhost:${targetPort}`;
	const originalReferer = request.headers.get('referer');
	if (originalReferer) {
		// Rewrite referer path onto localhost so SvelteKit accepts same-origin form posts.
		try {
			const refUrl = new URL(originalReferer);
			fwdHeaders['referer'] = `http://localhost:${targetPort}${refUrl.pathname}${refUrl.search}`;
		} catch { /* malformed referer, drop it */ }
	}
	fwdHeaders['x-forwarded-host'] = originalHost;
	fwdHeaders['x-forwarded-proto'] = 'https';

	try {
		if (request.body) {
			const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
			if (contentLength > MAX_PROXY_BODY) {
				return new Response('413 Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain' } });
			}
		}
		const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;

		const upstream = await new Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }>((resolve, reject) => {
			const req = httpRequest(
				{
					hostname: 'localhost',
					port: targetPort,
					path: `${url.pathname}${url.search}`,
					method: request.method,
					headers: fwdHeaders,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('end', () => {
						resolve({
							status: res.statusCode || 502,
							headers: (res.headers || {}) as Record<string, string | string[]>,
							body: Buffer.concat(chunks),
						});
					});
				},
			);

			req.on('error', reject);
			req.setTimeout(30000, () => {
				req.destroy(new Error('Proxy request timed out'));
			});

			if (body) req.write(body);
			req.end();
		});

		const responseHeaders = new Headers();
		for (const [key, val] of Object.entries(upstream.headers)) {
			const skipResponseHeaders = new Set(['transfer-encoding', 'set-cookie', 'server', 'x-powered-by']);
			if (skipResponseHeaders.has(key)) continue;
			if (val) responseHeaders.set(key, Array.isArray(val) ? val.join(', ') : val);
		}

		return new Response(new Uint8Array(upstream.body), {
			status: upstream.status,
			headers: responseHeaders,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(
			`<html><body style="font-family:system-ui;padding:2rem">
<h1>502 Bad Gateway</h1>
<p>Could not reach <code>localhost:${targetPort}</code></p>
<p style="color:#666">${message}</p>
<p>Make sure a dev server is running on port ${targetPort}.</p>
</body></html>`,
			{
				status: 502,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			},
		);
	}
}
