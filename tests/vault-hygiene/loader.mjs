/**
 * ESM loader hook for vault-hygiene tests.
 *
 * Two remappings applied to the loader chain:
 *  1. `$lib/*`   → `<root>/src/lib/*`          (SvelteKit path alias)
 *  2. `*.js`     → `*.ts` for files inside src/ (TypeScript source imports
 *                  use .js extensions per the TS/ESM convention; Node.js
 *                  --experimental-strip-types needs the physical .ts path)
 *
 * Mirrors tests/orchestration/loader.mjs but adds the .js→.ts rewrite.
 */
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = pathResolve(fileURLToPath(import.meta.url), '../../..');

export function resolve(specifier, context, nextResolve) {
	// 1. Remap SvelteKit path alias $lib/* → src/lib/*
	//    Also apply .js → .ts rewrite for the mapped absolute path so that
	//    transitive imports inside src/lib/ (e.g. `import '...' from '$lib/vault/index.js'`)
	//    resolve correctly when loaded with --experimental-strip-types.
	if (specifier.startsWith('$lib/')) {
		let mapped = specifier.replace('$lib/', ROOT + '/src/lib/');
		if (mapped.endsWith('.js')) {
			const mappedTs = mapped.slice(0, -3) + '.ts';
			if (existsSync(mappedTs)) mapped = mappedTs;
		}
		return nextResolve(pathToFileURL(mapped).href, context);
	}

	// 2. Remap relative .js imports to .ts when the .ts file exists inside
	//    the project root (skips bare specifiers and external packages).
	if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
		const parentDir = pathResolve(fileURLToPath(context.parentURL), '..');
		const resolvedJs = pathResolve(parentDir, specifier);
		const resolvedTs = resolvedJs.slice(0, -3) + '.ts';
		if (resolvedTs.startsWith(ROOT) && existsSync(resolvedTs)) {
			return nextResolve(pathToFileURL(resolvedTs).href, context);
		}
	}

	return nextResolve(specifier, context);
}
