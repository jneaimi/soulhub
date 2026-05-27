/**
 * ESM loader hook for chat tests.
 * Mirrors tests/agents/loader.mjs exactly.
 */
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = pathResolve(fileURLToPath(import.meta.url), '../../..');

export function resolve(specifier, context, nextResolve) {
	// 1. Remap SvelteKit path alias $lib/* → src/lib/*
	if (specifier.startsWith('$lib/')) {
		const mapped = specifier.replace('$lib/', ROOT + '/src/lib/');
		return nextResolve(mapped, context);
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
