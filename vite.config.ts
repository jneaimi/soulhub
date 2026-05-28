import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		external: ['node-pty'],
		// @xterm/headless + addon-serialize are CommonJS-`main` but ship an `.mjs`
		// `module` build. Bundling them for SSR makes Vite use that ESM build so
		// `import { Terminal }` / `{ SerializeAddon }` resolve in dev SSR too —
		// otherwise dev externalizes them and raw Node loads the CJS main, which
		// has no named exports. (The prod adapter-node build already bundles them.)
		noExternal: ['@xterm/headless', '@xterm/addon-serialize']
	}
});
