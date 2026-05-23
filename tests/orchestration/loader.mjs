// ESM loader hook that remaps $lib/* → src/lib/*
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathResolve(fileURLToPath(import.meta.url), '../../..');

export function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('$lib/')) {
		const mapped = specifier.replace('$lib/', ROOT + '/src/lib/');
		return nextResolve(mapped, context);
	}
	return nextResolve(specifier, context);
}
