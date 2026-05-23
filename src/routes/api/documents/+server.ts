/**
 * /api/documents — Naseej document-template catalog (ADR-033 CP1).
 *
 * GET ?q=  — list document templates (substring on slug + name).
 * POST { slug } — validate the on-disk template against the document gate.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	DEFAULT_DOCUMENTS_DIR,
	DOCUMENT_SLUG_RE,
	loadAllDocuments,
	validateDocumentTemplate,
} from '$lib/naseej/document-manifest.js';
import { regenDocumentIndexBestEffort } from '$lib/naseej/document-index.js';

export const GET: RequestHandler = async ({ url }) => {
	const records = await loadAllDocuments();
	const q = url.searchParams.get('q')?.toLowerCase() || null;
	const results = records
		.map((r) => ({
			slug: r.slug,
			name: r.template.name,
			brand: r.template.brand,
			lang: r.template.lang,
			component_count: r.template.composition.length,
			document_path: r.document_path,
		}))
		.filter((d) => !q || `${d.slug} ${d.name}`.toLowerCase().includes(q));
	return json({ results, total: results.length });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { slug } = (body as Record<string, unknown>) ?? {};
	if (typeof slug !== 'string' || !DOCUMENT_SLUG_RE.test(slug)) {
		return json({ error: 'valid slug (string) is required' }, { status: 400 });
	}
	const dir = join(DEFAULT_DOCUMENTS_DIR, slug);
	let rawText: string;
	try {
		rawText = await readFile(join(dir, 'document.yaml'), 'utf-8');
	} catch {
		return json({ error: `document not found: catalog/documents/${slug}` }, { status: 404 });
	}
	let raw: unknown;
	try {
		raw = parseYaml(rawText);
	} catch (e) {
		return json(
			{
				document: slug,
				status: 'failed',
				checks: [{ name: 'manifest_schema', status: 'failed', errors: [{ path: [], message: `invalid_yaml: ${e instanceof Error ? e.message : String(e)}` }] }],
			},
			{ status: 422 },
		);
	}
	const gate = await validateDocumentTemplate(raw);
	if (gate.ok) void regenDocumentIndexBestEffort();
	return json(
		{ document: slug, status: gate.ok ? 'passed' : 'failed', checks: gate.checks },
		{ status: gate.ok ? 200 : 422 },
	);
};
