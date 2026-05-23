/**
 * SSRF guard for fetchPage. Rejects URLs whose final resolution targets
 * private/loopback/link-local/CGNAT IP space OR our own domains. The
 * caller is responsible for re-running `isSafeUrl` on every redirect
 * target (see `index.ts`'s manual redirect loop).
 *
 * The trust model: any HTTP-fetching tool exposed to LLM-driven flows
 * MUST refuse to hit internal services. Soul Hub runs on the same Mac
 * Mini that hosts banking sessions, vault git remotes, and internal
 * dashboards — a fetchPage call to `http://localhost:2400` would let the
 * LLM read its own admin surface and reflect it back through `vaultSave`
 * or `crm-attach-note`.
 *
 * Hostname-level blocks fire BEFORE DNS resolution (so `localhost`,
 * `*.local`, `*.internal` never even leak a resolution attempt).
 * Network-level blocks fire AFTER `dns.lookup()` resolves the hostname,
 * so DNS rebinding can't sneak past a hostname allow.
 */

import { promises as dns } from 'node:dns';
import { internalDomainSuffixes } from '../branding.js';

// Own-infra domain suffixes moved to `branding.ts` (`internalDomainSuffixes()`),
// read at call-time so a fresh clone defaults to its own host, not the author's.

/** Hostnames blocked at the parse layer — never even attempt resolution. */
const HOSTNAME_BLOCKLIST = new Set([
	'localhost',
	'localhost.localdomain',
	'ip6-localhost',
	'ip6-loopback',
	'broadcasthost',
]);

export class UnsafeUrlError extends Error {
	constructor(message: string, readonly url: string) {
		super(message);
		this.name = 'UnsafeUrlError';
	}
}

/**
 * Throws `UnsafeUrlError` when the URL targets:
 *   - A non-http(s) scheme
 *   - A hostname in HOSTNAME_BLOCKLIST (localhost & friends)
 *   - A hostname ending in `.local` / `.internal` / our INTERNAL_DOMAIN_SUFFIXES
 *   - An IP literal in private/loopback/link-local/CGNAT space (v4 or v6)
 *   - A hostname whose DNS resolution lands in any of the above ranges
 *
 * Returns silently on safe URLs. The caller re-invokes this on each
 * redirect hop.
 */
export async function isSafeUrl(rawUrl: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new UnsafeUrlError('malformed URL', rawUrl);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new UnsafeUrlError(`scheme not allowed: ${parsed.protocol}`, rawUrl);
	}

	const host = parsed.hostname.toLowerCase();

	if (HOSTNAME_BLOCKLIST.has(host)) {
		throw new UnsafeUrlError(`hostname blocked: ${host}`, rawUrl);
	}
	if (host.endsWith('.local') || host.endsWith('.internal')) {
		throw new UnsafeUrlError(`hostname blocked by suffix: ${host}`, rawUrl);
	}
	for (const suffix of internalDomainSuffixes()) {
		if (host === suffix || host.endsWith(`.${suffix}`)) {
			throw new UnsafeUrlError(`hostname is internal: ${host}`, rawUrl);
		}
	}

	// IP literal — validate without DNS.
	if (isIpLiteral(host)) {
		if (isPrivateIp(host)) {
			throw new UnsafeUrlError(`private IP literal: ${host}`, rawUrl);
		}
		return;
	}

	// Hostname — resolve all A/AAAA records and ensure NONE are private.
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await dns.lookup(host, { all: true });
	} catch (err) {
		throw new UnsafeUrlError(`DNS resolution failed: ${(err as Error).message}`, rawUrl);
	}
	if (addresses.length === 0) {
		throw new UnsafeUrlError(`no DNS records for ${host}`, rawUrl);
	}
	for (const a of addresses) {
		if (isPrivateIp(a.address)) {
			throw new UnsafeUrlError(`hostname resolves to private IP: ${host} → ${a.address}`, rawUrl);
		}
	}
}

/** Crude IPv4/IPv6 literal detector — good enough; the real validation
 *  happens via `isPrivateIp`. */
function isIpLiteral(host: string): boolean {
	// IPv6 literals in URLs come bracketed (`[::1]`), but URL.hostname
	// strips the brackets — so the bare `::1` form is what we see here.
	if (host.includes(':')) return true;
	const parts = host.split('.');
	if (parts.length !== 4) return false;
	return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Return true if the IP literal falls in any private/loopback/link-local
 *  range. IPv4 covers RFC1918 + loopback + link-local + CGNAT + 0/8.
 *  IPv6 covers loopback (`::1`), link-local (`fe80::/10`), and ULA
 *  (`fc00::/7`). */
function isPrivateIp(ip: string): boolean {
	// IPv6 — case-insensitive matching against the standard private prefixes.
	if (ip.includes(':')) {
		const lower = ip.toLowerCase();
		if (lower === '::1' || lower === '::') return true;
		if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
		// fc00::/7 — first byte in [0xfc, 0xfd]
		if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
		// IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract the v4 part and re-check.
		const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
		if (mapped) return isPrivateIp(mapped[1]);
		return false;
	}

	const parts = ip.split('.').map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
	const [a, b] = parts;

	if (a === 0) return true;            // 0.0.0.0/8
	if (a === 10) return true;           // 10.0.0.0/8
	if (a === 127) return true;          // 127.0.0.0/8 — loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 0) return true;  // 192.0.0.0/24 — IETF protocol assignments
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
	if (a === 255) return true;          // 255.0.0.0/8 — broadcast
	return false;
}
