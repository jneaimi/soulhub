#!/usr/bin/env node
/**
 * vault-write component v1.0.0 — explicit vault note creation.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { path, frontmatter, body, mode?, api_base? }
 *   stdout: { vault_path, note_uri, bytes_written, action, warnings }
 *   exit:   0 success | 1 api down | 2 bad input | 4 not found | 5 api rejected
 *
 * No direct-fs fallback. Fail-loud when the API is unreachable.
 * Routes through POST/PUT /api/vault/notes — the canonical chokepoint
 * (ADR-046) + link validation (ADR-047) + stub scaffolding (ADR-049).
 *
 * Node 18+ for built-in fetch. ESM. No external deps.
 */

const EXIT = {
	OK: 0,
	API_DOWN: 1,
	BAD_INPUT: 2,
	NOT_FOUND: 4,
	API_REJECTED: 5,
};

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, msg, extra = {}) {
	emit({ error: msg, ...extra });
	process.exit(code);
}

async function readStdin() {
	return new Promise((resolve, reject) => {
		let buf = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => { buf += chunk; });
		process.stdin.on('end', () => resolve(buf));
		process.stdin.on('error', reject);
	});
}

function validatePath(path) {
	if (typeof path !== 'string' || !path) return 'must be a non-empty string';
	if (path.startsWith('/')) return 'must not start with /';
	if (path.includes('..')) return 'must not contain ..';
	if (path.includes('\0')) return 'must not contain null byte';
	if (!path.endsWith('.md')) return 'must end with .md';
	if (!path.includes('/')) return 'must include at least one /';
	return null;
}

function splitZoneFilename(path) {
	const lastSlash = path.lastIndexOf('/');
	return {
		zone: path.slice(0, lastSlash),
		filename: path.slice(lastSlash + 1),
	};
}

async function fetchJson(url, init = {}) {
	let res;
	try {
		res = await fetch(url, init);
	} catch (err) {
		fail(EXIT.API_DOWN, `cannot reach ${url}: ${err.message}`);
	}
	let body;
	try {
		body = await res.json();
	} catch {
		fail(EXIT.API_REJECTED, `non-JSON response from ${url}`, { status: res.status });
	}
	return { status: res.status, body };
}

function computeBytes(meta, body) {
	const fm = Object.entries(meta || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
	return Buffer.byteLength(`---\n${fm}\n---\n\n${body}`, 'utf-8');
}

async function modeCreate(api, zone, filename, frontmatter, body) {
	const { status, body: out } = await fetchJson(`${api}/api/vault/notes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ zone, filename, meta: frontmatter, content: body }),
	});
	if (status === 201 && out.success) {
		return {
			vault_path: out.path,
			note_uri: `vault://${out.path}`,
			bytes_written: computeBytes(frontmatter, body),
			action: 'created',
			warnings: out.warnings || [],
		};
	}
	if (status === 503) fail(EXIT.API_DOWN, out.error || 'vault not initialized', { status });
	fail(EXIT.API_REJECTED, out.error || `POST refused (status ${status})`, { status, field: out.field });
}

function isNotFound(status, body) {
	if (status === 404) return true;
	if (typeof body?.error === 'string' && /not found/i.test(body.error)) return true;
	return false;
}

async function modeReplace(api, path, frontmatter, body) {
	const { status, body: out } = await fetchJson(`${api}/api/vault/notes/${path}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ meta: frontmatter, content: body }),
	});
	if (status === 200 && out.success !== false) {
		return {
			vault_path: out.path || path,
			note_uri: `vault://${out.path || path}`,
			bytes_written: computeBytes(frontmatter, body),
			action: 'updated',
			warnings: out.warnings || [],
		};
	}
	if (isNotFound(status, out)) fail(EXIT.NOT_FOUND, `note not found: ${path}`, { status });
	if (status === 503) fail(EXIT.API_DOWN, out.error || 'vault not initialized', { status });
	fail(EXIT.API_REJECTED, out.error || `PUT refused (status ${status})`, { status });
}

async function modeAppend(api, path, frontmatter, body) {
	const { status: getStatus, body: existing } = await fetchJson(`${api}/api/vault/notes/${path}`);
	if (isNotFound(getStatus, existing)) fail(EXIT.NOT_FOUND, `note not found: ${path}`, { status: getStatus });
	if (getStatus === 503) fail(EXIT.API_DOWN, existing.error || 'vault not initialized', { status: getStatus });
	if (getStatus !== 200) fail(EXIT.API_REJECTED, existing.error || `GET refused (status ${getStatus})`, { status: getStatus });

	const mergedMeta = { ...(existing.meta || {}), ...frontmatter };
	const combinedBody = (existing.content || '').replace(/\n*$/, '') + '\n\n' + body;
	const { status: putStatus, body: out } = await fetchJson(`${api}/api/vault/notes/${path}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ meta: mergedMeta, content: combinedBody }),
	});
	if (putStatus === 200 && out.success !== false) {
		return {
			vault_path: out.path || path,
			note_uri: `vault://${out.path || path}`,
			bytes_written: computeBytes(mergedMeta, combinedBody),
			action: 'updated',
			warnings: out.warnings || [],
		};
	}
	fail(EXIT.API_REJECTED, out.error || `append PUT refused (status ${putStatus})`, { status: putStatus });
}

async function main() {
	let raw;
	try {
		raw = await readStdin();
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin read failed: ${err.message}`);
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin is not valid JSON: ${err.message}`);
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}

	const { path, frontmatter, body, mode = 'create', api_base = 'http://localhost:2400' } = payload;

	const pathErr = validatePath(path);
	if (pathErr) fail(EXIT.BAD_INPUT, `path ${pathErr}`);
	if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
		fail(EXIT.BAD_INPUT, 'frontmatter must be an object');
	}
	if (typeof body !== 'string') fail(EXIT.BAD_INPUT, 'body must be a string');
	if (!['create', 'append', 'replace'].includes(mode)) fail(EXIT.BAD_INPUT, `unknown mode: ${mode}`);

	const api = String(api_base).replace(/\/$/, '');
	let result;
	if (mode === 'create') {
		const { zone, filename } = splitZoneFilename(path);
		result = await modeCreate(api, zone, filename, frontmatter, body);
	} else if (mode === 'replace') {
		result = await modeReplace(api, path, frontmatter, body);
	} else {
		result = await modeAppend(api, path, frontmatter, body);
	}

	emit(result);
	process.exit(EXIT.OK);
}

main().catch((err) => {
	fail(EXIT.BAD_INPUT, `unexpected error: ${err.message || err}`);
});
