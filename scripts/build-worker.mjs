#!/usr/bin/env node
/** Bundle the WhatsApp worker (TypeScript) into a single ESM JS file
 *  that PM2 can run directly. We can't rely on Node's native TS strip
 *  because the worker imports `.js`-suffixed paths (NodeNext convention)
 *  that resolve to `.ts` source files — Node's stripper doesn't rewrite
 *  the extension. Vite (already a dependency via SvelteKit) handles
 *  both the strip and the resolution in one pass. */

import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(__filename), '..');

const externals = [
	'@whiskeysockets/baileys',
	'@hapi/boom',
	'qrcode',
	'ai',
	'@ai-sdk/anthropic',
	'@ai-sdk/google',
	'@openrouter/ai-sdk-provider',
	'zod',
];

const isExternal = (id) => {
	if (id.startsWith('node:')) return true;
	if (id.startsWith('.') || id.startsWith('/')) return false;
	if (externals.includes(id)) return true;
	// Match scoped or unscoped package roots, e.g. `pino/foo` is still
	// from a package.
	const root = id.split('/')[0].startsWith('@')
		? id.split('/').slice(0, 2).join('/')
		: id.split('/')[0];
	return externals.includes(root);
};

await build({
	root,
	configFile: false,
	logLevel: 'info',
	build: {
		ssr: true,
		target: 'node22',
		outDir: 'build',
		emptyOutDir: false,
		minify: false,
		sourcemap: true,
		rollupOptions: {
			input: resolve(root, 'scripts/whatsapp-worker.ts'),
			external: isExternal,
			output: {
				entryFileNames: 'whatsapp-worker.js',
				format: 'esm',
			},
		},
	},
});

console.log('[build-worker] wrote build/whatsapp-worker.js');
