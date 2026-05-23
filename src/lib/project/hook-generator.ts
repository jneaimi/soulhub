import type { SoulHubConfig } from './schema.js';

const STACK_BLOCKS: Record<string, string[]> = {
	sveltekit: ['svelte.config.js', 'svelte.config.ts', 'vite.config.ts', 'vite.config.js'],
	nextjs: ['next.config.js', 'next.config.ts', 'next.config.mjs'],
	astro: ['astro.config.mjs', 'astro.config.ts'],
	fastapi: ['pyproject.toml', 'setup.py', 'setup.cfg'],
	express: [],
	hono: [],
	'python-click': ['setup.py', 'pyproject.toml'],
	'node-commander': [],
	'ts-package': [],
	'py-package': ['pyproject.toml'],
	'react-native': ['app.json'],
	flutter: ['pubspec.yaml', 'build.gradle'],
	python: ['pyproject.toml', 'setup.py', 'setup.cfg'],
	bash: [],
	node: []
};

const TYPE_BLOCKS: Record<string, string[]> = {
	cli: ['setup.py', 'pyproject.toml'],
	library: ['package.json'],
	mobile: ['app.json', 'build.gradle'],
};

export function generateGuardHook(config: SoulHubConfig): string {
	const blockedPaths: string[] = [
		'node_modules/',
		'.env',
		'.env.*',
		'package-lock.json',
		'pnpm-lock.yaml',
		'yarn.lock',
		'bun.lockb'
	];

	// Add type-specific blocks
	const typeBlocks = TYPE_BLOCKS[config.type];
	if (typeBlocks) {
		blockedPaths.push(...typeBlocks);
	}

	// Add governance "avoid" rules as path blocks
	if (config.governance?.avoid) {
		for (const rule of config.governance.avoid) {
			if (rule.includes('/') || rule.includes('.')) {
				blockedPaths.push(rule);
			}
		}
	}

	// Add stack-specific config file blocks
	if (config.stack?.framework) {
		const stackFiles = STACK_BLOCKS[config.stack.framework];
		if (stackFiles) {
			blockedPaths.push(...stackFiles);
		}
	}

	// Automation projects get minimal hooks
	if (config.type === 'automation') {
		const patterns = blockedPaths.slice(0, 4).map((p) => `  "${p}"`).join('\n');
		return `#!/usr/bin/env bash
# Auto-generated guard hook for: ${config.name} (automation)
# Minimal hooks — this project is pipeline-managed.

set -euo pipefail

FILE_PATH="\${1:-}"

if [ -z "$FILE_PATH" ]; then
  echo "Usage: guard-writes.sh <file-path>" >&2
  exit 1
fi

BLOCKED_PATTERNS=(
${patterns}
)

for pattern in "\${BLOCKED_PATTERNS[@]}"; do
  case "$FILE_PATH" in
    *"$pattern"*)
      echo "BLOCKED: Writing to '$FILE_PATH' is not allowed (matched: $pattern)." >&2
      echo "If this is intentional, pass --force to override." >&2
      exit 1
      ;;
  esac
done

exit 0
`;
	}

	// Deduplicate
	const unique = [...new Set(blockedPaths)];
	const patterns = unique.map((p) => `  "${p}"`).join('\n');

	return `#!/usr/bin/env bash
# Auto-generated guard hook for: ${config.name}
# Blocks writes to protected paths unless explicitly overridden.

set -euo pipefail

FILE_PATH="\${1:-}"

if [ -z "$FILE_PATH" ]; then
  echo "Usage: guard-writes.sh <file-path>" >&2
  exit 1
fi

BLOCKED_PATTERNS=(
${patterns}
)

for pattern in "\${BLOCKED_PATTERNS[@]}"; do
  case "$FILE_PATH" in
    *"$pattern"*)
      echo "BLOCKED: Writing to '$FILE_PATH' is not allowed (matched: $pattern)." >&2
      echo "If this is intentional, pass --force to override." >&2
      exit 1
      ;;
  esac
done

exit 0
`;
}
