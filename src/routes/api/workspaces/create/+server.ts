import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { config } from '$lib/config.js';
import { dirExists } from '$lib/fs-utils.js';
import { validateConfig, RESERVED_NAMES, type SoulHubConfig } from '$lib/project/schema.js';
import { generateSettings } from '$lib/project/settings-generator.js';
import { generateGuardHook } from '$lib/project/hook-generator.js';
import { getVaultEngine } from '$lib/vault/index.js';

const DEV_DIR = config.resolved.devDir;
const SOUL_HUB_ROOT = process.cwd();

function buildGovernanceClaudeMd(name: string, description: string): string {
	return `# ${name}

> ${description}

**Status:** New project -- setup pending

## CRITICAL RULES

### 1. EVALUATE FIRST -- Think before building
Do NOT create files on the first prompt. Use the Evaluate -> Analyze -> Apply framework below. Ask discovery questions first, get answers, then build.

### 2. USE AskUserQuestion TOOL -- Interactive Q&A
Use the AskUserQuestion tool for EVERY discovery question. This gives the user clickable options in the UI instead of plain text. Ask ONE question per tool call. Include 2-4 options with descriptions. Always allow "Other" for custom input.

### 3. USE GENERATORS -- Don't write from scratch
After collecting all answers, read the generators to understand the patterns and produce files:
- CLAUDE.md generator: \`${SOUL_HUB_ROOT}/src/lib/project/claude-md-generator.ts\`
- Hook generator: \`${SOUL_HUB_ROOT}/src/lib/project/hook-generator.ts\`
- Pipeline info: \`${SOUL_HUB_ROOT}/src/lib/project/pipeline-info.ts\`
- Schema + mappings: \`${SOUL_HUB_ROOT}/src/lib/project/schema.ts\`

Read these files to understand what rules, anti-patterns, and hook logic to generate for each framework/type. Follow their patterns.

### 4. USE TEMPLATES -- Copy starter scaffolds
Copy from \`${SOUL_HUB_ROOT}/pipelines/_builder/project-templates/\`. Never write boilerplate from scratch.

### 5. GUARD HOOK IS PRE-GENERATED
\`.claude/hooks/guard.sh\` already exists with basic protections for this project type. During the Apply phase, regenerate it with the full governance config (including focus/avoid rules) by reading hook-generator.ts.

### 6. REPLACE THIS CLAUDE.MD
After the full Q&A, replace this entire file with the generated CLAUDE.md (with stack-specific rules, anti-patterns, governance, pipeline awareness).

### 7. SELF-CONTAINED
Everything lives inside this project folder. No symlinks to external files.

---

## Evaluate -> Analyze -> Apply

### Step 1: Evaluate (Discovery -- use AskUserQuestion)

Use the AskUserQuestion tool with 2-4 options per question. Split into rounds of up to 4 questions.

**Round 1 (3 questions):**

\`\`\`
AskUserQuestion (3 questions):

Question 1: "What kind of project is this?"
  Header: "Type"
  Options:
    - "Script" (Recommended based on description) — Standalone Python/Node/Bash script
    - "Web App" — Full-stack web application (SvelteKit, Next.js, Astro)
    - "API / Backend" — REST API or GraphQL service
    - "CLI Tool" — Command-line interface
  → maps to: type

Question 2: "What framework should we use?"
  Header: "Framework"
  Options: (from FRAMEWORK_BY_TYPE[selectedType] in schema.ts)
  → maps to: stack.framework, stack.language

Question 3: "Do you need a database?"
  Header: "Database"
  Options:
    - "None" (Recommended) — No persistence needed
    - "SQLite" — Local file-based database
    - "PostgreSQL" — Full relational database
  → maps to: stack.database
\`\`\`

**Round 2 (3 questions):**

\`\`\`
AskUserQuestion (3 questions):

Question 4: "What should the AI focus on?"
  Header: "Focus"
  multiSelect: true
  Options:
    - "Feature building" — Writing new functionality
    - "Bug fixing" — Debugging and fixing issues
    - "Refactoring" — Improving code structure
    - "Testing" — Writing and running tests
  → maps to: governance.focus

Question 5: "What should the AI avoid touching?"
  Header: "Avoid"
  multiSelect: true
  Options:
    - "Config files" — Don't modify framework configs
    - "CI/CD" — Don't touch deployment pipelines
    - "Dependencies" — Don't add/remove packages
    - "Tests" — Don't modify existing tests
  → maps to: governance.avoid

Question 6: "Which tooling should be active?"
  Header: "Tooling"
  multiSelect: true
  Options: (from TOOLING_BY_TYPE[selectedType] in schema.ts — pre-select defaults)
    - "security-reviewer agent" — OWASP-focused code review
    - "performance-reviewer agent" — Performance analysis
    - "/ship skill" — Git commit/push/PR workflow
    - "/ui-ux-pro-max skill" — Design system guidelines
  → maps to: tooling.agents, tooling.skills, tooling.mcp
\`\`\`

**Round 3 (1 question — only if pipelines exist):**

\`\`\`
AskUserQuestion (1 question):

Question 7: "Link any pipelines to this project?"
  Header: "Pipelines"
  multiSelect: true
  Options: (list from ${SOUL_HUB_ROOT}/pipelines/ — skip _builder, _archive)
  → maps to: pipelines[]
\`\`\`

### Step 2: Analyze

After all answers, propose the full \`.soul-hub.json\` config. Show:
- The complete config object
- Which template will be copied
- What the generated CLAUDE.md will include (rules, anti-patterns, pipelines)

**IMPORTANT:** If the analysis reveals a new decision (e.g., web app needs styling choice, or tooling conflict), loop back to Step 1 with a follow-up AskUserQuestion. Do not guess.

Wait for user approval before proceeding.

### Step 3: Apply

After approval, execute in this order:
1. Update \`.soul-hub.json\` with the complete config
2. Read \`${SOUL_HUB_ROOT}/src/lib/project/claude-md-generator.ts\` and generate the full CLAUDE.md following its patterns. Write it here, replacing this file.
3. Read \`${SOUL_HUB_ROOT}/src/lib/project/hook-generator.ts\` and generate \`.claude/hooks/guard.sh\` following its patterns. Make it executable.
4. Read \`TEMPLATE_FOR_FRAMEWORK\` from \`${SOUL_HUB_ROOT}/src/lib/project/schema.ts\` to find which template matches the chosen framework. Copy ALL files from \`${SOUL_HUB_ROOT}/pipelines/_builder/project-templates/{template-name}/\` to this project directory. Use Bash \`cp -r\` for efficiency.
5. Run \`npm install\` (Node) or \`uv init && uv add <deps>\` (Python) if the template has a package manager file. ALWAYS use uv for Python — never pip or venv.

### Step 4: Understand

After generating all files, explain what was created:
- What rules are in the new CLAUDE.md and why
- What the guard hook blocks and why
- What pipelines are linked and how to run them
- What to do next (start coding, run the dev server, etc.)

---

## Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| Dump all 7 questions at once | Use AskUserQuestion tool, ONE question per call, with clickable options |
| Ask questions as plain text | Use AskUserQuestion tool for interactive UI with options and descriptions |
| Write CLAUDE.md rules from scratch | Read claude-md-generator.ts for the patterns and follow them |
| Write guard.sh from scratch | Read hook-generator.ts for the patterns and follow them |
| Write boilerplate code from scratch | Copy from project-templates/ |
| Skip the Analyze step | Always propose the full config for user approval before Apply |
| Ignore FRAMEWORK_BY_TYPE suggestions | Read schema.ts to suggest appropriate frameworks for the project type |
| Ignore TOOLING_BY_TYPE suggestions | Read schema.ts to suggest appropriate agents/skills/MCP for the type |
| Create project files before all questions are answered | Complete all 7 discovery questions first |
| Leave this CLAUDE.md as-is after setup | Replace it with the generated version during Apply |

---

## Available Templates

| Template | For | Path |
|----------|-----|------|
| sveltekit-ts-tailwind | SvelteKit + TypeScript + Tailwind | project-templates/sveltekit-ts-tailwind/ |
| nextjs-ts-tailwind | Next.js + TypeScript + Tailwind | project-templates/nextjs-ts-tailwind/ |
| astro-tailwind | Astro + Tailwind | project-templates/astro-tailwind/ |
| python-fastapi | FastAPI + Python | project-templates/python-fastapi/ |
| node-express-ts | Express + TypeScript | project-templates/node-express-ts/ |
| hono-ts | Hono + TypeScript | project-templates/hono-ts/ |
| python-click-cli | Python CLI (Click) | project-templates/python-click-cli/ |
| node-commander-cli | Node CLI (Commander) | project-templates/node-commander-cli/ |
| ts-package | TypeScript library | project-templates/ts-package/ |
| py-package | Python package | project-templates/py-package/ |
| python-script | Python script | project-templates/python-script/ |

All templates are at: \`${SOUL_HUB_ROOT}/pipelines/_builder/project-templates/\`

Framework → Template mapping is defined in \`${SOUL_HUB_ROOT}/src/lib/project/schema.ts\` as \`TEMPLATE_FOR_FRAMEWORK\`. Read it to know which template to copy for the chosen framework.

---

## Available Pipelines

Check \`${SOUL_HUB_ROOT}/pipelines/\` for current pipelines (run \`ls\` to discover). Each pipeline has a \`pipeline.yaml\` with inputs, steps, and outputs.

To get pipeline details, read \`${SOUL_HUB_ROOT}/src/lib/project/pipeline-info.ts\` for the fetcher pattern.
`;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const validation = validateConfig(body);
	if (!validation.ok) {
		return json({ error: 'Validation failed', details: validation.errors }, { status: 400 });
	}

	const cfg = body as unknown as SoulHubConfig;
	const name = cfg.name.trim();

	if (RESERVED_NAMES.has(name)) {
		return json({ error: `"${name}" is a reserved name and cannot be used as a project name` }, { status: 400 });
	}

	const projectDir = join(DEV_DIR, name);

	if (await dirExists(projectDir)) {
		return json({ error: `Directory already exists: ${projectDir}` }, { status: 409 });
	}

	try {
		// 1. Create project directory
		await mkdir(projectDir, { recursive: true });

		// 2. Write minimal .soul-hub.json (AI enhances during Q&A)
		const soulHubConfig: SoulHubConfig = {
			name,
			type: cfg.type,
			description: cfg.description,
		};
		await writeFile(
			join(projectDir, '.soul-hub.json'),
			JSON.stringify(soulHubConfig, null, 2) + '\n',
			'utf-8'
		);

		// 3. Write governance CLAUDE.md (mirrors builder pattern)
		const claudeMd = buildGovernanceClaudeMd(name, cfg.description);
		await writeFile(join(projectDir, 'CLAUDE.md'), claudeMd, 'utf-8');

		// 4. Create .claude/hooks/ directory and wire settings.json
		const hookDir = join(projectDir, '.claude', 'hooks');
		await mkdir(hookDir, { recursive: true });

		// 5. Write settings.json (pre-wires guard.sh hook)
		const settings = generateSettings();
		await writeFile(
			join(projectDir, '.claude', 'settings.json'),
			JSON.stringify(settings, null, 2) + '\n',
			'utf-8'
		);

		// 6. Write real guard.sh (basic protections for project type; AI regenerates with full governance during setup)
		const guardPath = join(hookDir, 'guard.sh');
		const guardScript = generateGuardHook(soulHubConfig);
		await writeFile(guardPath, guardScript, 'utf-8');
		await chmod(guardPath, 0o755);

		// 7. Initialize git repo
		execSync('git init', { cwd: projectDir, stdio: 'ignore' });

		// 8. Auto-scaffold vault zone (non-blocking)
		try {
			const vault = getVaultEngine();
			if (vault) {
				await vault.scaffoldProject(name);
			}
		} catch {
			// Non-blocking — project creation succeeds regardless
		}

		return json({ ok: true, path: projectDir, name }, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: `Failed to create project: ${message}` }, { status: 500 });
	}
};
