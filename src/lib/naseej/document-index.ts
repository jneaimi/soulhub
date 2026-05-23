/**
 * Naseej document-index — AI-discoverable document-template catalog (ADR-033 CP1).
 *
 * Sibling of catalog-index + brand-index. Lists every document template with its
 * brand, language, component count, and the resolveSlots breakdown (how many
 * static / deterministic / judgment slots), so AI + the workbench can reason
 * about a template without re-deriving it.
 */
import { rename, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { loadAllDocuments, DEFAULT_DOCUMENTS_DIR } from './document-manifest.js';
import { loadAllComponentManifests } from './manifest.js';
import { resolveSlots, type SlotCompositionEntry } from './slots.js';
import type { ComponentManifest } from './schemas/component.js';

export const DEFAULT_DOCUMENT_INDEX_PATH = resolvePath(process.cwd(), 'catalog/document-index.json');

export interface DocumentIndexEntry {
	slug: string;
	name: string;
	brand: string;
	lang: string;
	component_count: number;
	slots: { static: number; deterministic: number; judgment: number };
	document_path: string;
}

export interface DocumentIndex {
	schema_version: 1;
	generated_at: string;
	documents: Record<string, DocumentIndexEntry>;
}

export async function buildDocumentIndex(opts?: {
	documentsDir?: string;
	now?: () => Date;
}): Promise<DocumentIndex> {
	const documentsDir = opts?.documentsDir ?? DEFAULT_DOCUMENTS_DIR;
	const now = opts?.now ?? (() => new Date());
	const records = await loadAllDocuments(documentsDir);
	const compRecords = await loadAllComponentManifests();
	const byName = new Map<string, ComponentManifest>(compRecords.map((r) => [r.manifest.name, r.manifest]));

	const documents: Record<string, DocumentIndexEntry> = {};
	for (const rec of records) {
		const res = resolveSlots(rec.template.composition as SlotCompositionEntry[], byName);
		documents[rec.slug] = {
			slug: rec.slug,
			name: rec.template.name,
			brand: rec.template.brand,
			lang: rec.template.lang,
			component_count: rec.template.composition.length,
			slots: {
				static: res.static.length,
				deterministic: res.deterministic.length,
				judgment: res.judgment.length,
			},
			document_path: rec.document_path,
		};
	}
	return { schema_version: 1, generated_at: now().toISOString(), documents };
}

export function serializeDocumentIndex(index: DocumentIndex): string {
	return JSON.stringify(index, null, 2) + '\n';
}

export async function writeDocumentIndexToDisk(
	index: DocumentIndex,
	outPath: string = DEFAULT_DOCUMENT_INDEX_PATH,
): Promise<void> {
	const payload = serializeDocumentIndex(index);
	const tmpPath = join(dirname(outPath), `.document-index.json.tmp.${process.pid}`);
	await writeFile(tmpPath, payload, 'utf-8');
	await rename(tmpPath, outPath);
}

export async function regenDocumentIndexBestEffort(opts?: {
	documentsDir?: string;
	outPath?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const index = await buildDocumentIndex({ documentsDir: opts?.documentsDir });
		await writeDocumentIndexToDisk(index, opts?.outPath);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
