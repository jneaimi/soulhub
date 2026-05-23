export interface SoulHubConfig {
	name: string;
	type: 'web-app' | 'api' | 'cli' | 'library' | 'mobile' | 'script' | 'automation';
	description: string;
	stack?: {
		framework?: 'sveltekit' | 'nextjs' | 'astro' | 'fastapi' | 'express' | 'hono' | 'python-click' | 'node-commander' | 'ts-package' | 'py-package' | 'react-native' | 'flutter' | 'python' | 'bash' | 'node';
		language?: 'typescript' | 'javascript' | 'python';
		styling?: 'tailwind' | 'css-modules' | 'none';
		database?: 'sqlite' | 'postgresql' | 'none';
	};
	pipelines?: {
		name: string;
		role: string;
		trigger: 'manual' | 'on-commit' | 'scheduled';
	}[];
	governance?: {
		focus?: string[];
		avoid?: string[];
		style?: string;
	};
	tooling?: {
		agents?: string[];
		skills?: string[];
		mcp?: string[];
	};
}

const VALID_TYPES = ['web-app', 'api', 'cli', 'library', 'mobile', 'script', 'automation'] as const;
const VALID_FRAMEWORKS = ['sveltekit', 'nextjs', 'astro', 'fastapi', 'express', 'hono', 'python-click', 'node-commander', 'ts-package', 'py-package', 'react-native', 'flutter', 'python', 'bash', 'node'] as const;
const VALID_LANGUAGES = ['typescript', 'javascript', 'python'] as const;
const VALID_STYLINGS = ['tailwind', 'css-modules', 'none'] as const;
const VALID_DATABASES = ['sqlite', 'postgresql', 'none'] as const;
const VALID_TRIGGERS = ['manual', 'on-commit', 'scheduled'] as const;

/** Maps framework ID → project template directory name */
export const TEMPLATE_FOR_FRAMEWORK: Record<string, string> = {
	'sveltekit': 'sveltekit-ts-tailwind',
	'nextjs': 'nextjs-ts-tailwind',
	'astro': 'astro-tailwind',
	'fastapi': 'python-fastapi',
	'express': 'node-express-ts',
	'hono': 'hono-ts',
	'python-click': 'python-click-cli',
	'node-commander': 'node-commander-cli',
	'ts-package': 'ts-package',
	'py-package': 'py-package',
	'python': 'python-script',
	'bash': 'python-script',  // closest match
	'node': 'node-express-ts', // closest match
};

/** Project names that conflict with system directories */
export const RESERVED_NAMES = new Set([
	'soul-hub', 'pipelines', 'node_modules', 'build', '.git',
	'.svelte-kit', 'dist', 'output', 'logs', '.data',
]);

export function validateConfig(config: unknown): { ok: boolean; errors: string[] } {
	const errors: string[] = [];

	if (config === null || config === undefined || typeof config !== 'object') {
		return { ok: false, errors: ['Config must be a non-null object'] };
	}

	const c = config as Record<string, unknown>;

	if (typeof c.name !== 'string' || c.name.trim() === '') {
		errors.push('name is required and must be a non-empty string');
	}

	if (typeof c.type !== 'string' || !(VALID_TYPES as readonly string[]).includes(c.type)) {
		errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
	}

	if (typeof c.description !== 'string' || c.description.trim() === '') {
		errors.push('description is required and must be a non-empty string');
	}

	if (c.stack !== undefined) {
		if (typeof c.stack !== 'object' || c.stack === null) {
			errors.push('stack must be an object');
		} else {
			const stack = c.stack as Record<string, unknown>;
			if (stack.framework !== undefined && !(VALID_FRAMEWORKS as readonly string[]).includes(stack.framework as string)) {
				errors.push(`stack.framework must be one of: ${VALID_FRAMEWORKS.join(', ')}`);
			}
			if (stack.language !== undefined && !(VALID_LANGUAGES as readonly string[]).includes(stack.language as string)) {
				errors.push(`stack.language must be one of: ${VALID_LANGUAGES.join(', ')}`);
			}
			if (stack.styling !== undefined && !(VALID_STYLINGS as readonly string[]).includes(stack.styling as string)) {
				errors.push(`stack.styling must be one of: ${VALID_STYLINGS.join(', ')}`);
			}
			if (stack.database !== undefined && !(VALID_DATABASES as readonly string[]).includes(stack.database as string)) {
				errors.push(`stack.database must be one of: ${VALID_DATABASES.join(', ')}`);
			}
		}
	}

	if (c.pipelines !== undefined) {
		if (!Array.isArray(c.pipelines)) {
			errors.push('pipelines must be an array');
		} else {
			for (let i = 0; i < c.pipelines.length; i++) {
				const p = c.pipelines[i] as Record<string, unknown>;
				if (typeof p.name !== 'string' || p.name.trim() === '') {
					errors.push(`pipelines[${i}].name is required`);
				}
				if (typeof p.role !== 'string' || p.role.trim() === '') {
					errors.push(`pipelines[${i}].role is required`);
				}
				if (!(VALID_TRIGGERS as readonly string[]).includes(p.trigger as string)) {
					errors.push(`pipelines[${i}].trigger must be one of: ${VALID_TRIGGERS.join(', ')}`);
				}
			}
		}
	}

	if (c.governance !== undefined) {
		if (typeof c.governance !== 'object' || c.governance === null) {
			errors.push('governance must be an object');
		} else {
			const gov = c.governance as Record<string, unknown>;
			if (gov.focus !== undefined && !Array.isArray(gov.focus)) {
				errors.push('governance.focus must be an array');
			}
			if (gov.avoid !== undefined && !Array.isArray(gov.avoid)) {
				errors.push('governance.avoid must be an array');
			}
			if (gov.style !== undefined && typeof gov.style !== 'string') {
				errors.push('governance.style must be a string');
			}
		}
	}

	if (c.tooling !== undefined) {
		if (typeof c.tooling !== 'object' || c.tooling === null) {
			errors.push('tooling must be an object');
		} else {
			const tooling = c.tooling as Record<string, unknown>;
			if (tooling.agents !== undefined && !Array.isArray(tooling.agents)) {
				errors.push('tooling.agents must be an array');
			}
			if (tooling.skills !== undefined && !Array.isArray(tooling.skills)) {
				errors.push('tooling.skills must be an array');
			}
			if (tooling.mcp !== undefined && !Array.isArray(tooling.mcp)) {
				errors.push('tooling.mcp must be an array');
			}
		}
	}

	return { ok: errors.length === 0, errors };
}
