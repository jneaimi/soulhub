import type { SoulHubConfig } from './schema.js';
import type { PipelineInfo } from './pipeline-info.js';

const STACK_RULES: Record<string, string[]> = {
	sveltekit: [
		'Use Svelte 5 syntax ($state, $derived, $props). Use adapter-node.',
		'Use SvelteKit load functions for data fetching.',
		'Use form actions for mutations.'
	],
	nextjs: [
		'Use App Router. Use Server Components by default.',
		'Use Server Actions for mutations.',
		'Colocate loading.tsx and error.tsx with page.tsx.'
	],
	astro: [
		'Use Astro content collections. Use islands architecture.',
	],
	fastapi: [
		'Use Pydantic models for request/response validation.',
		'Use async endpoints.',
		'Use dependency injection for shared resources.'
	],
	express: [
		'Use async middleware with proper error handling.',
		'Validate request bodies at the boundary.',
		'Use Router for modular route definitions.'
	],
	hono: [
		'Use Hono middleware pattern. Deploy to edge runtime.',
	],
	'python-click': [
		'Use Click decorators for commands. Use rich for output formatting.',
	],
	'node-commander': [
		'Use Commander.js for CLI. Use chalk for colored output.',
	],
	'ts-package': [
		'Export from index.ts. Include proper tsconfig for library builds. Use vitest for tests.',
	],
	'py-package': [
		'Use pyproject.toml. Include proper __init__.py. Use pytest.',
	],
	'react-native': [
		'Use Expo. Use functional components with hooks.',
	],
	flutter: [
		'Use StatelessWidget/StatefulWidget. Follow BLoC pattern.',
	],
	python: [
		'Use type hints on all function signatures.',
		'Use uv for dependency management (uv init, uv add, uv run). Never use pip or venv directly.',
		'Use pathlib for file operations.'
	],
	bash: [
		'Use set -euo pipefail. Use functions for organization.',
	],
	node: [
		'Use ES modules (import/export).',
		'Handle process signals for graceful shutdown.',
		'Use structured logging.'
	]
};

const ANTI_PATTERNS: Record<string, string[]> = {
	sveltekit: [
		"Don't use Svelte 4 syntax (export let, $: reactive statements).",
		"Don't use adapter-auto in production.",
		"Don't access the DOM directly; use Svelte bindings."
	],
	nextjs: [
		"Don't use pages/ router.",
		"Don't use getServerSideProps or getStaticProps.",
		"Don't use next/router; use next/navigation."
	],
	astro: [
		"Don't use client-side JavaScript unless necessary.",
		"Don't import heavy frameworks for static content."
	],
	fastapi: [
		"Don't use synchronous database calls in async endpoints.",
		"Don't return raw dicts; use Pydantic response models."
	],
	express: [
		"Don't use callback-style middleware; use async/await.",
		"Don't expose stack traces in production error responses."
	],
	hono: [
		"Don't use Node.js-specific APIs; keep it runtime-agnostic.",
	],
	'python-click': [
		"Don't use argparse; use Click decorators.",
	],
	'node-commander': [
		"Don't use process.argv directly; use Commander options.",
	],
	'ts-package': [
		"Don't bundle dependencies; list them as peerDependencies where appropriate.",
	],
	'py-package': [
		"Don't use setup.py; use pyproject.toml.",
	],
	python: [
		"Don't use print() for logging; use the logging module.",
		"Don't use mutable default arguments.",
		"Don't catch bare exceptions (except Exception)."
	],
	bash: [
		"Don't use unquoted variables.",
		"Don't rely on external commands without checking availability.",
	],
	node: [
		"Don't use require(); use import.",
		"Don't use var; use const/let.",
		"Don't swallow errors silently."
	]
};

export function generateClaudeMd(config: SoulHubConfig, availablePipelines?: PipelineInfo[]): string {
	// Automation projects get a special CLAUDE.md
	if (config.type === 'automation') {
		return generateAutomationClaudeMd(config, availablePipelines);
	}

	const sections: string[] = [];

	sections.push(`# ${config.name}\n`);
	sections.push(`${config.description}\n`);
	sections.push(`Project type: ${config.type}\n`);

	// Stack section
	if (config.stack?.framework) {
		const rules = STACK_RULES[config.stack.framework];
		if (rules) {
			sections.push('## Stack\n');
			if (config.stack.language) {
				sections.push(`Language: ${config.stack.language}`);
			}
			if (config.stack.styling && config.stack.styling !== 'none') {
				sections.push(`Styling: ${config.stack.styling}`);
			}
			if (config.stack.database && config.stack.database !== 'none') {
				sections.push(`Database: ${config.stack.database}`);
			}
			sections.push('');
			for (const rule of rules) {
				sections.push(`- ${rule}`);
			}
			sections.push('');
		}
	}

	// Governance / Rules section
	if (config.governance) {
		sections.push('## Rules\n');
		if (config.governance.focus && config.governance.focus.length > 0) {
			sections.push(`Focus on: ${config.governance.focus.join(', ')}\n`);
		}
		if (config.governance.avoid && config.governance.avoid.length > 0) {
			sections.push(`Do NOT: ${config.governance.avoid.join(', ')}\n`);
		}
		if (config.governance.style) {
			sections.push(`Code style: ${config.governance.style}\n`);
		}
	}

	// ADR-002: pipeline module retired 2026-05-16. The "Linked Pipelines" section
	// the generator used to emit referenced /pipelines (which is now 410). A
	// Naseej "Linked Recipes" section will replace it once the orchestrator-v2
	// fold lands. `config.pipelines` (if present from a legacy workspace) is now
	// ignored rather than rendered into misleading guidance.

	// Anti-patterns section
	if (config.stack?.framework) {
		const antiPatterns = ANTI_PATTERNS[config.stack.framework];
		if (antiPatterns) {
			sections.push('## Anti-patterns\n');
			for (const ap of antiPatterns) {
				sections.push(`- ${ap}`);
			}
			sections.push('');
		}
	}

	return sections.join('\n');
}

function generateAutomationClaudeMd(config: SoulHubConfig, availablePipelines?: PipelineInfo[]): string {
	const sections: string[] = [];

	sections.push(`# ${config.name} — Automation Project\n`);
	sections.push(`${config.description}\n`);
	sections.push('This project is pipeline-driven. Development happens in the Soul Hub Pipeline Builder.\n');

	const pipelineEntries = config.pipelines ?? [];
	if (pipelineEntries.length > 0) {
		sections.push('## Linked Pipelines\n');
		sections.push('| Pipeline | Role | Trigger |');
		sections.push('|----------|------|---------|');
		for (const p of pipelineEntries) {
			sections.push(`| ${p.name} | ${p.role} | ${p.trigger} |`);
		}
		sections.push('');
	}

	sections.push('## How to work\n');
	sections.push('- Create and edit pipelines in Soul Hub → Builder');
	sections.push('- Run pipelines from Soul Hub → Pipelines');
	sections.push('- Outputs appear in each pipeline\'s output/ folder');
	sections.push('');

	return sections.join('\n');
}
