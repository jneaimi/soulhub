/**
 * ADR-031 CP2 proof — run with: npx tsx src/lib/naseej/slots.proof.mts
 *
 * Asserts resolveSlots() partitions a composition correctly (manifest-declared
 * slot_class + per-instance override + static-without-value warning), and that
 * a `static` slot renders straight from config through doc-render with zero LLM
 * call (doc-render has no LLM dependency — the static value is injected verbatim).
 *
 * Not wired to a test runner (the repo has none for TS libs); it's the CP2
 * worked example, run on demand. Exit 0 all pass, 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { stat, rm } from 'node:fs/promises';
import { loadAllComponentManifests, DEFAULT_CATALOG_DIR } from './manifest.ts';
import { resolveSlots, staticInputsForEntry, type SlotCompositionEntry } from './slots.ts';
import type { ComponentManifest } from './schemas/component.ts';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) {
		pass++;
		console.log(`  ok   ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}  ${detail}`);
	}
}

function runDocRender(payload: Record<string, unknown>): Promise<{ code: number; out: string }> {
	const dir = resolvePath(DEFAULT_CATALOG_DIR, 'doc-render');
	return new Promise((res) => {
		const proc = spawn('uv', ['run', join(dir, 'run.py')], { cwd: dir });
		let out = '';
		proc.stdout.on('data', (d) => (out += d));
		proc.on('close', (code) => res({ code: code ?? -1, out }));
		proc.stdin.end(JSON.stringify(payload));
	});
}

async function main(): Promise<number> {
	const records = await loadAllComponentManifests();
	const byName = new Map<string, ComponentManifest>(records.map((r) => [r.manifest.name, r.manifest]));

	check('cover-page in catalog', byName.has('cover-page'));

	// Composition: cover-page with an inline eyebrow (static, has value) + title
	// (judgment) + reference_code (deterministic) + a per-instance override that
	// flips `subtitle` from judgment → static with a config value.
	const composition: SlotCompositionEntry[] = [
		{
			component: 'cover-page',
			inputs: { eyebrow: 'Signal Forge', title: 'Daily Peer Brief', reference_code: 'PB-2026-05-20' },
			slots: { subtitle: { class: 'static', value: 'A standing methodology line, set once.' } },
		},
	];

	const r = resolveSlots(composition, byName);

	const cls = (input: string) =>
		[...r.static, ...r.deterministic, ...r.judgment].find((s) => s.input === input)?.class;

	check('eyebrow → static (manifest default)', cls('eyebrow') === 'static', String(cls('eyebrow')));
	check('title → judgment (manifest default)', cls('title') === 'judgment', String(cls('title')));
	check('reference_code → deterministic (manifest default)', cls('reference_code') === 'deterministic', String(cls('reference_code')));
	check('subtitle → static (per-instance override beats manifest judgment)', cls('subtitle') === 'static', String(cls('subtitle')));
	check('no warnings on a well-formed composition', r.warnings.length === 0, JSON.stringify(r.warnings));

	// static-without-value warning: an eyebrow (static) with no inline value.
	const r2 = resolveSlots([{ component: 'cover-page', inputs: { title: 'x' } }], byName);
	check(
		'static slot without value warns',
		r2.warnings.some((w) => w.includes('eyebrow') && w.includes('static')),
		JSON.stringify(r2.warnings),
	);

	// unknown component → warning, not throw.
	const r3 = resolveSlots([{ component: 'no-such', inputs: {} }], byName);
	check('unknown component warns, no throw', r3.warnings.length === 1 && r3.static.length === 0);

	// Zero-LLM render proof: assemble the known-value inputs and render through
	// doc-render. The static + deterministic + supplied values render verbatim;
	// no LLM is involved (doc-render has no model dependency).
	const inputs = staticInputsForEntry(r, 0);
	check('staticInputsForEntry carries the static eyebrow + subtitle', inputs.eyebrow === 'Signal Forge' && inputs.subtitle === 'A standing methodology line, set once.', JSON.stringify(inputs));

	const outPdf = join(tmpdir(), `slots-proof-${Date.now()}.pdf`);
	const rendered = await runDocRender({
		composition: [{ component: 'cover-page', inputs }],
		lang: 'en',
		out_pdf: outPdf,
		catalog_root: DEFAULT_CATALOG_DIR,
		brand: 'jneaimi',
	});
	let bytes = 0;
	try {
		bytes = (await stat(outPdf)).size;
	} catch {
		/* not written */
	}
	check('static slot renders via doc-render (zero LLM)', rendered.code === 0 && bytes > 1000, `code=${rendered.code} bytes=${bytes} out=${rendered.out.slice(0, 200)}`);
	await rm(outPdf, { force: true }).catch(() => {});

	console.log(`\n${pass} passed, ${fail} failed`);
	return fail === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
