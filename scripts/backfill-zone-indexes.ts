/** One-shot backfill for the existing orphans in auto-route zones.
 *
 *  Context: ADR-044 Phase C added `engine.appendToZoneIndex` and wired
 *  it into the L3 S4 auto-route worker so new routes land linked from
 *  their zone's index.md. But the 30 notes already routed BEFORE
 *  Phase C shipped are still orphans — the worker only updates the
 *  index on a fresh route, not for historical ones.
 *
 *  This script reuses the same helper to backfill those existing
 *  orphans. Same code path the running worker now uses on every tick,
 *  just applied to the historical set. Idempotent — the helper skips
 *  any note whose path is already in the zone index.
 *
 *  Safety:
 *    - Skips zones without an `index.md` (no auto-create).
 *    - Only touches notes in the named target zones (security/, finance/,
 *      shipping/, otp/) — won't bulk-link operator-curated zones.
 *    - DRY-RUN by default. Pass `--apply` to actually write.
 *
 *  Usage:
 *    npx tsx scripts/backfill-zone-indexes.ts          # dry-run
 *    npx tsx scripts/backfill-zone-indexes.ts --apply  # actually writes
 */

import { config as soulHubConfig } from '../src/lib/config.js';
import { initVault, getVaultEngine } from '../src/lib/vault/index.js';

const TARGET_ZONES = new Set(['security', 'finance', 'shipping', 'otp']);
const APPLY = process.argv.includes('--apply');

async function main() {
	await initVault(soulHubConfig.resolved.vaultDir);
	const engine = getVaultEngine();
	if (!engine) {
		console.error('Vault engine failed to initialise.');
		process.exit(1);
	}

	const orphans = engine.getOrphans();
	const candidates = orphans.filter((n) => {
		const zone = n.path.split('/')[0];
		return TARGET_ZONES.has(zone);
	});

	console.log(`Found ${orphans.length} total orphans, ${candidates.length} in target zones.`);
	console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`);
	console.log('');

	let appended = 0;
	let alreadyIn = 0;
	let noIndex = 0;
	let failed = 0;

	for (const n of candidates) {
		const zone = n.path.split('/')[0];
		const indexPath = `${zone}/index.md`;
		const index = engine.getNote(indexPath);

		if (!index) {
			console.log(`  [no-index]  ${n.path}`);
			noIndex++;
			continue;
		}

		const linkTarget = n.path.replace(/\.md$/, '');
		if (index.content.includes(linkTarget)) {
			alreadyIn++;
			continue;
		}

		if (!APPLY) {
			console.log(`  [+append]   ${n.path}  →  ${indexPath}  (title: ${n.title})`);
			appended++;
			continue;
		}

		const result = await engine.appendToZoneIndex(zone, n.path, n.title);
		if ('success' in result && result.success) {
			console.log(`  [appended]  ${n.path}  →  ${indexPath}`);
			appended++;
		} else {
			const err = 'error' in result ? result.error : 'unknown';
			console.log(`  [FAIL]      ${n.path}: ${err}`);
			failed++;
		}
	}

	console.log('');
	console.log(`Summary: ${appended} ${APPLY ? 'appended' : 'would append'}, ${alreadyIn} already in index, ${noIndex} no zone-index, ${failed} failed.`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
