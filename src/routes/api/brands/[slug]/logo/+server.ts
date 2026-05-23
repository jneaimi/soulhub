/**
 * /api/brands/[slug]/logo — multipart logo upload (ADR-032 CP1).
 *
 * POST a `multipart/form-data` body with a `logo` file field. Validates the
 * extension (.png/.jpg/.jpeg/.svg) and a size cap, writes the asset into the
 * brand dir under a fixed name (`logo.<ext>` — avoids traversal + odd names),
 * and returns the relative path the editor sets as `logo.primary`.
 *
 * Path-traversal defence: slug must match BRAND_SLUG_RE and the resolved brand
 * dir must stay under DEFAULT_BRANDS_DIR.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { DEFAULT_BRANDS_DIR, BRAND_SLUG_RE } from '$lib/naseej/brand-manifest.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const EXT_BY_TYPE: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/svg+xml': 'svg',
};
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'svg']);

function extFor(file: File): string | null {
	// Prefer the declared MIME; fall back to the filename extension.
	const byType = EXT_BY_TYPE[file.type];
	if (byType) return byType;
	const dot = file.name.lastIndexOf('.');
	if (dot === -1) return null;
	const ext = file.name.slice(dot + 1).toLowerCase();
	return ALLOWED_EXT.has(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : null;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const slug = params.slug ?? '';
	if (!BRAND_SLUG_RE.test(slug)) {
		return json({ error: 'invalid slug' }, { status: 400 });
	}
	const dir = join(DEFAULT_BRANDS_DIR, slug);
	if (!dir.startsWith(DEFAULT_BRANDS_DIR + '/')) {
		return json({ error: 'slug resolves outside catalog/brands/' }, { status: 400 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'expected multipart/form-data' }, { status: 400 });
	}
	const file = form.get('logo');
	if (!(file instanceof File)) {
		return json({ error: 'missing `logo` file field' }, { status: 400 });
	}
	if (file.size > MAX_BYTES) {
		return json({ error: `logo exceeds ${MAX_BYTES} bytes (${file.size})` }, { status: 413 });
	}
	const ext = extFor(file);
	if (!ext) {
		return json(
			{ error: 'logo must be .png, .jpg, .jpeg, or .svg' },
			{ status: 415 },
		);
	}

	await mkdir(dir, { recursive: true });
	const rel = `logo.${ext}`;
	const buf = Buffer.from(await file.arrayBuffer());
	await writeFile(join(dir, rel), buf);

	return json({ slug, logoPath: rel, bytes: buf.length }, { status: 200 });
};
