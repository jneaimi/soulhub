/**
 * /api/brands/[slug]/preview — live render preview (ADR-032 CP3).
 *
 * POST { profile, lang? } — render a fixed sample document (cover + module +
 * callout) through doc-render with the IN-PROGRESS brand passed inline, so the
 * editor can preview an unsaved brand. Returns the PDF bytes (application/pdf)
 * or 422 JSON on a render error.
 *
 * The logo (if any) is resolved to an absolute path against the brand dir —
 * an inline brand has no source dir, so a relative logo.primary wouldn't
 * resolve. The asset must already be on disk (uploaded via the logo endpoint).
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, isAbsolute } from 'node:path';
import { DEFAULT_CATALOG_DIR } from '$lib/naseej/manifest.js';
import { DEFAULT_BRANDS_DIR, BRAND_SLUG_RE } from '$lib/naseej/brand-manifest.js';

const DOC_RENDER_DIR = resolvePath(DEFAULT_CATALOG_DIR, 'doc-render');
const DOC_RENDER_ENTRY = join(DOC_RENDER_DIR, 'run.py');
const RENDER_TIMEOUT_MS = 60_000;

/** Fixed sample doc that exercises the three Phase-1 presentation components. */
function sampleComposition(lang: 'en' | 'ar') {
	const ar = lang === 'ar';
	return [
		{
			component: 'cover-page',
			inputs: {
				eyebrow: ar ? 'نموذج' : 'Sample',
				title: ar ? 'معاينة العلامة' : 'Brand Preview',
				subtitle: ar
					? 'مستند تجريبي يطبّق ألوان وخطوط وشعار هذه العلامة.'
					: 'A sample document applying this brand’s colors, fonts, and logo.',
				reference_code: 'PREVIEW',
			},
		},
		{
			component: 'module',
			inputs: {
				eyebrow: ar ? 'القسم ١' : 'Section 1',
				title: ar ? 'عنوان القسم' : 'Section heading',
				intro: ar ? 'فقرة تمهيدية قصيرة.' : 'A short introductory paragraph.',
				body: ar
					? 'نص أساسي يوضح كيف تظهر الطباعة والألوان عبر هذه العلامة في مستند فعلي.'
					: 'Body text showing how this brand’s typography and color read in a real document.',
			},
		},
		{
			component: 'callout',
			inputs: {
				tone: 'info',
				title: ar ? 'ملاحظة' : 'Note',
				body: ar
					? 'يستخدم هذا الصندوق ألوان التنبيه من العلامة.'
					: 'This box uses the brand’s callout colors.',
			},
		},
	];
}

function runDocRender(
	payload: Record<string, unknown>,
): Promise<{ exit_code: number; stderr: string; timed_out: boolean }> {
	return new Promise((resolveP) => {
		const proc = spawn('uv', ['run', DOC_RENDER_ENTRY], {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: DOC_RENDER_DIR,
		});
		let stderr = '';
		proc.stderr.on('data', (d) => {
			stderr += d;
			if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
		});
		const t = setTimeout(() => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.kill('SIGKILL'), 2000);
		}, RENDER_TIMEOUT_MS);
		proc.on('close', (code, signal) => {
			clearTimeout(t);
			resolveP({
				exit_code: code ?? -1,
				stderr,
				timed_out: signal === 'SIGTERM' || signal === 'SIGKILL',
			});
		});
		proc.stdin.end(JSON.stringify(payload));
	});
}

export const POST: RequestHandler = async ({ params, request }) => {
	const slug = params.slug ?? '';
	if (!BRAND_SLUG_RE.test(slug)) return json({ error: 'invalid slug' }, { status: 400 });

	let body: { profile?: unknown; lang?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const profile = body.profile;
	if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
		return json({ error: 'body must include a brand `profile` object' }, { status: 400 });
	}
	const lang = body.lang === 'ar' ? 'ar' : 'en';

	// Resolve a relative logo to absolute against the brand dir (inline brand has
	// no source dir, so doc-render can't resolve a relative logo on its own).
	const brand: Record<string, unknown> = { ...(profile as Record<string, unknown>) };
	const logo = brand.logo as { primary?: unknown } | undefined;
	if (logo && typeof logo.primary === 'string' && logo.primary && !isAbsolute(logo.primary)) {
		brand.logo = { ...logo, primary: join(DEFAULT_BRANDS_DIR, slug, logo.primary) };
	}

	const dir = await mkdtemp(join(tmpdir(), 'brand-preview-'));
	const outPdf = join(dir, 'preview.pdf');
	try {
		const res = await runDocRender({
			composition: sampleComposition(lang),
			brand,
			lang,
			out_pdf: outPdf,
			catalog_root: DEFAULT_CATALOG_DIR,
		});
		if (res.exit_code !== 0 || res.timed_out) {
			return json(
				{ error: `render failed: ${res.stderr.trim().slice(-500) || `exit ${res.exit_code}`}` },
				{ status: 422 },
			);
		}
		const pdf = await readFile(outPdf);
		return new Response(new Uint8Array(pdf), {
			headers: {
				'content-type': 'application/pdf',
				'content-disposition': 'inline; filename="brand-preview.pdf"',
				'cache-control': 'no-store',
			},
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
};
