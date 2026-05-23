/** `soul contracts …` — soul-hub-governance ADR-002 (P2).
 *
 *  Design-time contract awareness from the terminal (the main interaction
 *  shape). `touching <path>` answers "what cross-area contract does a change to
 *  this file participate in, and what's its falsifier?"; `check` runs the
 *  registry's own self-falsifier (resolution + cache freshness). Dumb pipe to
 *  /api/contracts/* — the server reads the compiled cache. */

import { apiGet } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface TouchingResp {
	ok?: boolean;
	path?: string;
	registryLoaded?: boolean;
	compiledAt?: string | null;
	count?: number;
	contracts?: Array<{ id: string; area: string; guarantees: string; falsifier: string; dependsOn: string[] }>;
}

interface CheckResp {
	ok?: boolean;
	check?: {
		ok: boolean;
		count: number;
		cacheStale: boolean;
		unresolvedFiles: { id: string; glob: string }[];
		danglingFalsifiers: { id: string; falsifier: string }[];
		danglingDeps: { id: string; dep: string }[];
	};
}

export async function touching(args: Record<string, string | undefined>, opts: OutputOpts) {
	const path = args._;
	if (!path) fail('contracts touching: missing PATH (e.g. soul contracts touching src/lib/vault/governance.ts)');
	const data = await apiGet<TouchingResp>('/api/contracts/touching', { path });
	emit(data, opts, (d: TouchingResp) => {
		if (!d.registryLoaded) return '(no contract registry compiled yet — run `soul contracts check` with soul-hub up)';
		if (!d.contracts || d.contracts.length === 0) return `No contracts touch ${d.path}`;
		const lines = [`${d.count} contract(s) touch ${d.path}:`, ''];
		for (const c of d.contracts) {
			lines.push(`  ${c.id}  [${c.area}]`);
			lines.push(`    guarantees: ${c.guarantees}`);
			lines.push(`    falsifier:  ${c.falsifier}`);
			if (c.dependsOn.length) lines.push(`    dependsOn:  ${c.dependsOn.join(', ')}`);
		}
		return lines.join('\n');
	});
}

export async function check(_args: Record<string, string | undefined>, opts: OutputOpts) {
	const data = await apiGet<CheckResp>('/api/contracts/compile');
	emit(data, opts, (d: CheckResp) => {
		const c = d.check;
		if (!c) return '(no check result)';
		const lines = [`Registry self-check: ${c.ok ? '✓ ok' : '⚠ violations'}  (${c.count} contracts)`];
		if (c.cacheStale) lines.push('  ⚠ cache stale vs vault source — recompile (POST /api/contracts/compile)');
		for (const u of c.unresolvedFiles) lines.push(`  ⚠ ${u.id}: glob resolves to nothing — ${u.glob}`);
		for (const f of c.danglingFalsifiers) lines.push(`  ⚠ ${f.id}: falsifier not a known task/command — ${f.falsifier}`);
		for (const d2 of c.danglingDeps) lines.push(`  ⚠ ${d2.id}: dependsOn unknown contract — ${d2.dep}`);
		return lines.join('\n');
	});
}
