import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { isPathAllowed, findRootForPath } from '$lib/explorer-roots.js';
import { recordAccess } from '$lib/file-audit.js';

// Same character class used by the project-scoped /api/upload endpoint, kept
// in sync so behavior is predictable across both surfaces. Path separators,
// shell metacharacters, and most punctuation collapse to `_`.
const SAFE_NAME_CHARS = /[^\w.\-]/g;

/** Per-file upload cap for the files UI. Mirrors the 10 MB raw-read cap. */
const MAX_UPLOAD_FILE_BYTES = 25_000_000;

/**
 * Strip a user-supplied filename or directory name to something safe to use
 * inside an allowed root. Returns null for inputs that are empty, traversal
 * attempts, or hidden (leading `.`) — callers should reject those with 400.
 */
function sanitizeName(raw: string): string | null {
	const trimmed = basename(raw ?? '').trim();
	if (!trimmed || trimmed === '.' || trimmed === '..') return null;
	const safe = trimmed.replace(SAFE_NAME_CHARS, '_');
	if (!safe || safe.startsWith('.') || safe.length > 255) return null;
	return safe;
}

const MIME_TYPES: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
	gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
	ico: 'image/x-icon', bmp: 'image/bmp', pdf: 'application/pdf',
};

// Skip these directories when listing — universally noisy / never useful in a file browser
const EXCLUDED_DIRS = new Set([
	'node_modules', '.git', '.svelte-kit', '.next', '__pycache__',
	'.venv', 'venv', '.cache', '.turbo', 'dist', 'build', '.output',
	'.nuxt', '.vercel', 'coverage', '.pids', 'logs',
]);

/**
 * Resolve a path through the filesystem (following symlinks) so the final
 * allow-check operates on the canonical path. Returns null if the path
 * doesn't exist — callers should treat that as a 404.
 */
function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function getClientIp(headers: Headers): string {
	return (
		headers.get('cf-connecting-ip') ||
		headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		headers.get('x-real-ip') ||
		'unknown'
	);
}

export const GET: RequestHandler = async ({ url, request }) => {
	const targetPath = url.searchParams.get('path');
	const action = url.searchParams.get('action') || 'list';
	const file = url.searchParams.get('file');
	const ip = getClientIp(request.headers);

	if (!targetPath) {
		return json({ error: 'Missing path parameter' }, { status: 400 });
	}

	const resolved = resolve(targetPath);
	const realDir = safeRealpath(resolved);
	if (!realDir) {
		return json({ error: 'Directory not found' }, { status: 404 });
	}

	const dirCheck = isPathAllowed(realDir);
	if (!dirCheck.allowed) {
		return json({ error: 'Access denied', reason: dirCheck.reason }, { status: 403 });
	}

	// Lightweight existence check — returns {exists, size} without reading content
	if (action === 'stat' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			return json({ exists: false, error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			return json({ error: 'Access denied' }, { status: 403 });
		}
		try {
			const s = await stat(realFile);
			return json({ exists: true, size: s.size });
		} catch {
			return json({ exists: false, error: 'File not found' }, { status: 404 });
		}
	}

	// Serve binary files (images, PDFs) with correct content-type.
	// Supports ?disposition=attachment to force a download; default is inline.
	if (action === 'raw' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: filePath, status: 'not_found' });
			return json({ error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'denied' });
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(realFile);
			if (s.size > 10_485_760) {
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'too_large', bytes: s.size });
				return json({ error: 'File too large (>10MB)', size: s.size }, { status: 413 });
			}
			const ext = file.split('.').pop()?.toLowerCase() || '';
			const mime = MIME_TYPES[ext] || 'application/octet-stream';
			const buffer = await readFile(realFile);
			// RFC 5987 encoding so non-ASCII filenames round-trip correctly
			const dispositionType = url.searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
			const asciiFallback = file.replace(/[^\x20-\x7E]/g, '_');
			const encodedName = encodeURIComponent(file);
			const contentDisposition = `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'raw', path: realFile, status: 'ok', bytes: s.size });
			return new Response(buffer, {
				headers: {
					'Content-Type': mime,
					'Content-Length': String(s.size),
					'Cache-Control': 'private, max-age=60',
					'Content-Disposition': contentDisposition,
				},
			});
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	if (action === 'read' && file) {
		const filePath = resolve(realDir, file);
		const realFile = safeRealpath(filePath);
		if (!realFile) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: filePath, status: 'not_found' });
			return json({ error: 'File not found' }, { status: 404 });
		}
		const fileCheck = isPathAllowed(realFile);
		if (!fileCheck.allowed) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'denied' });
			return json({ error: 'Access denied' }, { status: 403 });
		}

		try {
			const s = await stat(realFile);
			// Limit file reads to 1MB
			if (s.size > 1_048_576) {
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'too_large', bytes: s.size });
				return json({ error: 'File too large (>1MB)', size: s.size }, { status: 413 });
			}
			const content = await readFile(realFile, 'utf-8');
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'read', path: realFile, status: 'ok', bytes: s.size });
			return json({ content, size: s.size, path: realFile });
		} catch {
			return json({ error: 'File not found' }, { status: 404 });
		}
	}

	// Default: list directory.
	// Hidden files (`.dotfiles`) are filtered out unless the containing root opts in
	// via showHidden. `.claude/` stays visible regardless because the agent system
	// stores user-relevant config there.
	try {
		const entries = await readdir(realDir, { withFileTypes: true });
		const result = [];
		const root = findRootForPath(realDir);
		const showHidden = root?.showHidden ?? false;

		for (const entry of entries) {
			if (entry.name.startsWith('.') && entry.name !== '.claude' && !showHidden) continue;
			if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

			const entryPath = join(realDir, entry.name);
			try {
				const s = await stat(entryPath);
				result.push({
					name: entry.name,
					type: entry.isDirectory() ? 'dir' : 'file',
					size: entry.isFile() ? s.size : undefined,
				});
			} catch {
				// Skip entries we can't stat (broken symlinks etc)
				continue;
			}
		}

		// Sort: dirs first, then alphabetical
		result.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return json({ entries: result, path: realDir });
	} catch {
		return json({ error: 'Directory not found' }, { status: 404 });
	}
};

/**
 * Resolve and allow-check a target *parent* directory for a write op.
 * Returns the canonical (realpath'd) directory, or a Response that the
 * caller should return verbatim. Discriminated by `kind` so TypeScript
 * narrows cleanly inside callers.
 */
type WriteTarget = { kind: 'ok'; dir: string } | { kind: 'err'; response: Response };

async function resolveWriteTarget(targetPath: string | null): Promise<WriteTarget> {
	if (!targetPath) {
		return { kind: 'err', response: json({ error: 'Missing path parameter' }, { status: 400 }) };
	}
	const resolved = resolve(targetPath);
	let real: string;
	try {
		real = realpathSync(resolved);
	} catch {
		return { kind: 'err', response: json({ error: 'Directory not found' }, { status: 404 }) };
	}
	const check = isPathAllowed(real);
	if (!check.allowed) {
		return { kind: 'err', response: json({ error: 'Access denied', reason: check.reason }, { status: 403 }) };
	}
	try {
		const s = await stat(real);
		if (!s.isDirectory()) {
			return { kind: 'err', response: json({ error: 'Target is not a directory' }, { status: 400 }) };
		}
	} catch {
		return { kind: 'err', response: json({ error: 'Directory not found' }, { status: 404 }) };
	}
	return { kind: 'ok', dir: real };
}

/**
 * POST /api/files?action=mkdir|upload — write operations against an allowed root.
 *
 *   ?action=mkdir   JSON body { path, name }       → create a single subdirectory
 *   ?action=upload  multipart form (path, files[]) → write files into `path`
 *
 * Both flows resolve the target parent through `realpathSync` first so symlink
 * escapes hit `isPathAllowed` before any write happens. Filenames are
 * sanitized via `sanitizeName` (no traversal, no hidden files, no separators).
 */
export const POST: RequestHandler = async ({ url, request }) => {
	const action = url.searchParams.get('action');
	const ip = getClientIp(request.headers);

	if (action === 'mkdir') {
		let body: { path?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		const target = await resolveWriteTarget(body.path ?? null);
		if (target.kind === 'err') return target.response;

		const safeName = sanitizeName(body.name ?? '');
		if (!safeName) {
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'mkdir', path: target.dir, status: 'invalid' });
			return json({ error: 'Invalid folder name' }, { status: 400 });
		}

		const newDir = join(target.dir, safeName);
		try {
			await mkdir(newDir, { recursive: false });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'EEXIST') {
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'mkdir', path: newDir, status: 'conflict' });
				return json({ error: 'A file or folder with that name already exists' }, { status: 409 });
			}
			void recordAccess({ ts: new Date().toISOString(), ip, action: 'mkdir', path: newDir, status: 'denied' });
			return json({ error: 'Failed to create folder', code }, { status: 500 });
		}

		void recordAccess({ ts: new Date().toISOString(), ip, action: 'mkdir', path: newDir, status: 'ok' });
		return json({ ok: true, path: newDir, name: safeName }, { status: 201 });
	}

	if (action === 'upload') {
		let formData: FormData;
		try {
			formData = await request.formData();
		} catch (err) {
			// Most common cause: request body exceeded BODY_SIZE_LIMIT (default 512KB)
			// → adapter truncates the stream → multipart parser chokes. Surface the
			// real error so this is diagnosable from the client banner.
			const msg = (err as Error).message || 'unknown';
			return json({
				error: `Could not parse upload body: ${msg}. If the file is large, the server's BODY_SIZE_LIMIT may need to be raised.`,
			}, { status: 400 });
		}

		const target = await resolveWriteTarget((formData.get('path') as string) ?? null);
		if (target.kind === 'err') return target.response;

		const files = formData.getAll('files').filter((f): f is File => f instanceof File);
		if (files.length === 0) {
			return json({ error: 'No files provided' }, { status: 400 });
		}

		const uploaded: { name: string; path: string; size: number }[] = [];
		const skipped: { name: string; reason: string }[] = [];

		for (const file of files) {
			const safeName = sanitizeName(file.name);
			if (!safeName) {
				skipped.push({ name: file.name, reason: 'invalid name' });
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'upload', path: target.dir, status: 'invalid' });
				continue;
			}
			if (file.size > MAX_UPLOAD_FILE_BYTES) {
				skipped.push({ name: safeName, reason: `over ${MAX_UPLOAD_FILE_BYTES} bytes` });
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'upload', path: join(target.dir, safeName), status: 'too_large', bytes: file.size });
				continue;
			}

			const filePath = join(target.dir, safeName);
			// Block clobbering existing entries — caller must delete or rename first.
			try {
				await stat(filePath);
				skipped.push({ name: safeName, reason: 'already exists' });
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'upload', path: filePath, status: 'conflict' });
				continue;
			} catch {
				// ENOENT — proceed with write
			}

			try {
				const buffer = Buffer.from(await file.arrayBuffer());
				await writeFile(filePath, buffer);
				uploaded.push({ name: safeName, path: filePath, size: buffer.length });
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'upload', path: filePath, status: 'ok', bytes: buffer.length });
			} catch {
				skipped.push({ name: safeName, reason: 'write failed' });
				void recordAccess({ ts: new Date().toISOString(), ip, action: 'upload', path: filePath, status: 'denied' });
			}
		}

		const status = uploaded.length === 0 ? 400 : 201;
		return json({ uploaded, skipped }, { status });
	}

	return json({ error: 'Unknown action — expected mkdir or upload' }, { status: 400 });
};
