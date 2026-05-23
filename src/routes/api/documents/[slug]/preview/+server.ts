/**
 * /api/documents/[slug]/preview — composition preview (ADR-033 CP3).
 *
 * POST { template, lang? } — render the in-progress document template through
 * doc-render so the workbench previews it pre-run. Each slot is resolved:
 *   - static        → its value
 *   - deterministic  } → the component's sample_inputs value for that input,
 *   - judgment       }   else a "[computed]" / "[AI-drafted]" placeholder
 * so the human sees the real layout before the pipeline fills the dynamic slots.
 *
 * The brand is passed by SLUG (doc-render resolves it from catalog/brands/,
 * including the logo) — so unlike the brand preview, no logo path juggling.
 *
 * Returns application/pdf, or 422 JSON on a render error.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { DEFAULT_CATALOG_DIR, loadAllComponentManifests } from '$lib/naseej/manifest.js';
import { DOCUMENT_SLUG_RE } from '$lib/naseej/document-manifest.js';
import type { ComponentManifest } from '$lib/naseej/schemas/component.js';

const DOC_RENDER_DIR = resolvePath(DEFAULT_CATALOG_DIR, 'doc-render');
const DOC_RENDER_ENTRY = join(DOC_RENDER_DIR, 'run.py');
const RENDER_TIMEOUT_MS = 60_000;

function runDocRender(
	payload: Record<string, unknown>,
): Promise<{ exit_code: number; stderr: string; timed_out: boolean }> {
	return new Promise((resolveP) => {
		const proc = spawn('uv', ['run', DOC_RENDER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], cwd: DOC_RENDER_DIR });
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
			resolveP({ exit_code: code ?? -1, stderr, timed_out: signal === 'SIGTERM' || signal === 'SIGKILL' });
		});
		proc.stdin.end(JSON.stringify(payload));
	});
}

export const POST: RequestHandler = async ({ params, request }) => {
	const slug = params.slug ?? '';
	if (!DOCUMENT_SLUG_RE.test(slug)) return json({ error: 'invalid slug' }, { status: 400 });

	let body: { template?: any; lang?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const tpl = body.template;
	if (!tpl || typeof tpl !== 'object' || !Array.isArray(tpl.composition)) {
		return json({ error: 'body must include a template with a composition' }, { status: 400 });
	}
	if (typeof tpl.brand !== 'string' || !tpl.brand) {
		return json({ error: 'template.brand (slug) is required to preview' }, { status: 400 });
	}
	const lang = (body.lang ?? tpl.lang) === 'ar' ? 'ar' : 'en';

	const records = await loadAllComponentManifests();
	const byName = new Map<string, ComponentManifest>(records.map((r) => [r.manifest.name, r.manifest]));

	// Resolve each slot to a concrete input value for the render.
	const composition = tpl.composition.map((entry: any) => {
		const manifest = byName.get(entry.component);
		const sample = (manifest?.sample_inputs ?? {}) as Record<string, unknown>;
		const inputs: Record<string, unknown> = {};
		for (const [key, binding] of Object.entries(entry.slots ?? {})) {
			const b = binding as { class?: string; value?: unknown };
			if (b.class === 'static') {
				inputs[key] = b.value ?? '';
			} else if (key in sample) {
				inputs[key] = sample[key];
			} else {
				inputs[key] = b.class === 'deterministic' ? '[computed]' : '[AI-drafted]';
			}
		}
		return { component: entry.component, inputs, ...(entry.variant ? { variant: entry.variant } : {}) };
	});

	const dir = await mkdtemp(join(tmpdir(), 'doc-preview-'));
	const outPdf = join(dir, 'preview.pdf');
	try {
		const res = await runDocRender({
			composition,
			brand: tpl.brand,
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
				'content-disposition': 'inline; filename="document-preview.pdf"',
				'cache-control': 'no-store',
			},
		});
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
};
