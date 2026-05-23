/**
 * /api/documents/[slug] — read + write one document template (ADR-033 CP1).
 *
 * GET — the full template for the workbench (404 if absent).
 * PUT — validate-then-write: the 4-check document gate; on pass, atomic
 *       tmp+rename of document.yaml (dir-create if new) + doc-index regen;
 *       on fail, return the checks and write nothing.
 *
 * Traversal defence: DOCUMENT_SLUG_RE + resolved-path prefix under
 * DEFAULT_DOCUMENTS_DIR.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	DEFAULT_DOCUMENTS_DIR,
	DOCUMENT_SLUG_RE,
	validateDocumentTemplate,
} from '$lib/naseej/document-manifest.js';
import { regenDocumentIndexBestEffort } from '$lib/naseej/document-index.js';

function documentDir(slug: string): string | null {
	if (!DOCUMENT_SLUG_RE.test(slug)) return null;
	const dir = join(DEFAULT_DOCUMENTS_DIR, slug);
	return dir.startsWith(DEFAULT_DOCUMENTS_DIR + '/') ? dir : null;
}

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug ?? '';
	const dir = documentDir(slug);
	if (!dir) return json({ error: 'invalid slug' }, { status: 400 });
	let text: string;
	try {
		text = await readFile(join(dir, 'document.yaml'), 'utf-8');
	} catch {
		return json({ error: `document not found: catalog/documents/${slug}` }, { status: 404 });
	}
	try {
		return json({ slug, template: parseYaml(text) });
	} catch (e) {
		return json(
			{ error: `document.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 422 },
		);
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const slug = params.slug ?? '';
	const dir = documentDir(slug);
	if (!dir) return json({ error: 'invalid slug (kebab-case, no path segments)' }, { status: 400 });

	let template: unknown;
	try {
		template = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (!template || typeof template !== 'object' || Array.isArray(template)) {
		return json({ error: 'body must be a document template object' }, { status: 400 });
	}

	const gate = await validateDocumentTemplate(template);
	if (!gate.ok) {
		return json({ document: slug, status: 'failed', checks: gate.checks }, { status: 422 });
	}

	await mkdir(dir, { recursive: true });
	const yaml = stringifyYaml(template);
	const tmp = join(dir, `.document.yaml.tmp.${process.pid}`);
	await writeFile(tmp, yaml, 'utf-8');
	await rename(tmp, join(dir, 'document.yaml'));

	void regenDocumentIndexBestEffort();
	return json({ document: slug, status: 'passed', checks: gate.checks }, { status: 200 });
};
