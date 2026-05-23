/**
 * ADR-055 — operator-facing branding / host values.
 *
 * Sourced from ~/.soul-hub/.env (loaded by `secrets.ts` at boot) with neutral
 * localhost defaults, so a fresh clone never carries the author's domain.
 *
 * Exposed as FUNCTIONS (not module consts) on purpose: every read happens at
 * call-time — after boot-time `loadSecrets()` has populated `process.env` —
 * which avoids any module-import-order race. The `no-owner-domain-in-defaults`
 * falsifier (ADR-055) guards the defaults in this file.
 */

const DEFAULT_PUBLIC_URL = 'http://localhost:2400';

/** Public base URL for deeplinks back into Soul Hub. No trailing slash. */
export function publicUrl(): string {
	return (process.env.SOUL_HUB_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '');
}

/** Hostname (no port) of the public URL — e.g. "soul-hub.example.com" or "localhost". */
export function publicHostname(): string {
	try {
		return new URL(publicUrl()).hostname;
	} catch {
		return 'localhost';
	}
}

/** Operator domain for branding strings. Falls back to the public hostname
 *  when `SOUL_HUB_DOMAIN` is unset. */
export function operatorDomain(): string {
	return process.env.SOUL_HUB_DOMAIN || publicHostname();
}

/** Operator display name for legal pages. Neutral default for a fresh clone. */
export function operatorName(): string {
	return process.env.SOUL_HUB_OPERATOR_NAME || 'the Operator';
}

/** Operator contact email for legal pages. Empty string when unconfigured. */
export function operatorEmail(): string {
	return process.env.SOUL_HUB_OPERATOR_EMAIL || '';
}

/** `fetchPage` User-Agent. Appends a contact domain only when one is configured. */
export function userAgent(): string {
	const d = process.env.SOUL_HUB_DOMAIN;
	return d ? `SoulHub/1.0 (+${d})` : 'SoulHub/1.0';
}

/** Domain suffixes the SSRF guard treats as own-infra. Operator may override via
 *  `SOUL_HUB_INTERNAL_DOMAINS` (comma-separated); otherwise derived from the
 *  operator domain + public hostname (deduped). */
export function internalDomainSuffixes(): readonly string[] {
	const explicit = process.env.SOUL_HUB_INTERNAL_DOMAINS
		?.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (explicit && explicit.length) return explicit;
	return [...new Set([operatorDomain().toLowerCase(), publicHostname().toLowerCase()])];
}
