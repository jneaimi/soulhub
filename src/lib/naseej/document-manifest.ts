/**
 * Document template loading + the publish gate (ADR-033 CP1).
 *
 * Disk layout: `catalog/documents/<slug>/document.yaml`. Mirrors the brand +
 * component layout and the same tolerant-scan posture.
 *
 * The gate is where `resolveSlots()` finally earns its keep: it partitions the
 * composition to verify every `static` slot carries a value.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAllComponentManifests } from './manifest.js';
import { loadBrandSafe } from './brand-manifest.js';
import { resolveSlots, type SlotCompositionEntry } from './slots.js';
import {
	safeParseDocumentTemplate,
	type DocumentTemplate,
} from './schemas/document.js';
import type { ComponentManifest } from './schemas/component.js';

export const DEFAULT_DOCUMENTS_DIR = resolvePath(process.cwd(), 'catalog/documents');
export const DOCUMENT_SLUG_RE = /^[a-z][a-z0-9-]*$/;

export interface DocumentRecord {
	slug: string;
	template: DocumentTemplate;
	dir: string;
	document_path: string;
}

export type LoadDocumentResult =
	| { ok: true; record: DocumentRecord }
	| { ok: false; reason: 'not_found' | 'invalid_yaml' | 'schema_invalid'; detail?: string; errors?: unknown[] };

export async function loadDocumentSafe(
	slug: string,
	documentsDir: string = DEFAULT_DOCUMENTS_DIR,
): Promise<LoadDocumentResult> {
	const dir = join(documentsDir, slug);
	let raw: string;
	try {
		raw = await readFile(join(dir, 'document.yaml'), 'utf-8');
	} catch {
		return { ok: false, reason: 'not_found', detail: `no document.yaml at ${dir}` };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		return { ok: false, reason: 'invalid_yaml', detail: e instanceof Error ? e.message : String(e) };
	}
	const result = safeParseDocumentTemplate(parsed);
	if (!result.ok) return { ok: false, reason: 'schema_invalid', errors: result.errors };
	return {
		ok: true,
		record: {
			slug,
			template: result.data,
			dir,
			document_path: `catalog/documents/${slug}/document.yaml`,
		},
	};
}

export async function loadAllDocuments(
	documentsDir: string = DEFAULT_DOCUMENTS_DIR,
): Promise<DocumentRecord[]> {
	let entries: string[];
	try {
		entries = await readdir(documentsDir);
	} catch {
		return [];
	}
	const out: DocumentRecord[] = [];
	for (const slug of entries) {
		if (!DOCUMENT_SLUG_RE.test(slug)) continue;
		const r = await loadDocumentSafe(slug, documentsDir);
		if (r.ok) out.push(r.record);
	}
	out.sort((a, b) => a.slug.localeCompare(b.slug));
	return out;
}

// ── Gate ──────────────────────────────────────────────────────────────────

export type DocCheck =
	| { name: 'manifest_schema'; status: 'passed' | 'failed'; errors?: unknown[] }
	| { name: 'brand_exists'; status: 'passed' | 'failed'; detail?: string }
	| { name: 'components_resolve'; status: 'passed' | 'failed'; detail?: string; problems?: string[] }
	| { name: 'static_values_present'; status: 'passed' | 'failed'; detail?: string; problems?: string[] };

export interface DocGateResult {
	ok: boolean;
	checks: DocCheck[];
	template?: DocumentTemplate;
}

/** The 4-check document gate. Takes a RAW value (posted JSON or parsed YAML). */
export async function validateDocumentTemplate(raw: unknown): Promise<DocGateResult> {
	const parsed = safeParseDocumentTemplate(raw);
	if (!parsed.ok) {
		return { ok: false, checks: [{ name: 'manifest_schema', status: 'failed', errors: parsed.errors }] };
	}
	const tpl = parsed.data;
	const checks: DocCheck[] = [{ name: 'manifest_schema', status: 'passed' }];

	// brand_exists
	const brand = await loadBrandSafe(tpl.brand);
	checks.push(
		brand.ok
			? { name: 'brand_exists', status: 'passed' }
			: { name: 'brand_exists', status: 'failed', detail: `brand "${tpl.brand}" not found in catalog/brands/` },
	);

	// components_resolve — every component is a published kind:presentation, and
	// every slot key is a real input of that component.
	const records = await loadAllComponentManifests();
	const byName = new Map<string, ComponentManifest>(records.map((r) => [r.manifest.name, r.manifest]));
	const problems: string[] = [];
	tpl.composition.forEach((entry, i) => {
		const m = byName.get(entry.component);
		if (!m) {
			problems.push(`composition[${i}]: component "${entry.component}" not in catalog`);
			return;
		}
		if (m.kind !== 'presentation') {
			problems.push(`composition[${i}]: "${entry.component}" is kind=${m.kind}, not presentation`);
			return;
		}
		const inputNames = new Set((m.inputs ?? []).map((inp) => inp.name));
		for (const key of Object.keys(entry.slots ?? {})) {
			if (!inputNames.has(key)) {
				problems.push(`composition[${i}].${entry.component}: slot "${key}" is not an input of the component`);
			}
		}
	});
	checks.push(
		problems.length === 0
			? { name: 'components_resolve', status: 'passed' }
			: { name: 'components_resolve', status: 'failed', detail: 'composition references unknown components/inputs', problems },
	);

	// static_values_present — resolveSlots warns on a static slot with no value.
	const resolution = resolveSlots(tpl.composition as SlotCompositionEntry[], byName);
	const staticProblems = resolution.warnings.filter((w) => w.includes('class=static'));
	checks.push(
		staticProblems.length === 0
			? { name: 'static_values_present', status: 'passed' }
			: { name: 'static_values_present', status: 'failed', detail: 'static slots missing values', problems: staticProblems },
	);

	return { ok: !checks.some((c) => c.status === 'failed'), checks, template: tpl };
}
