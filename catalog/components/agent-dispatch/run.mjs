#!/usr/bin/env node
/**
 * agent-dispatch component v1.0.0 — Tier-1 agentic capability per ADR-023.
 *
 * Wraps the soul-hub dispatchAgent() loop in the Naseej stdin-json protocol.
 * Ports runAgentStep() from src/lib/naseej/runner.ts:435-556 almost verbatim.
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { agent, task, context?, goal_condition?, mode?, timeout_sec?, max_turns?, max_usd? }
 *   stdout: { output_excerpt, artifact_path?, agent_status, num_turns, cost_usd, exit_code, error? }
 *   exit:   0 success/goal_achieved | 1 failed/timeout/cancelled/error | 2 bad input
 *
 * Tight-coupled to soul-hub's $lib/agents — intentional per ADR-023 vision.
 * ESM, Node 18+.
 */

// NOTE: This file runs as a subprocess of the Naseej runner, which executes
// from the soul-hub repo root. The $lib alias resolves via the tsconfig path
// mapping when transpiled, but at runtime (direct node invocation) we use the
// compiled output path instead. The soul-hub build output places compiled
// files under .svelte-kit/output/server/ — however, the runner spawns this
// component as a child process from the same Node.js process that loaded the
// SvelteKit build. To avoid circular imports, we import from the compiled
// module path that the SvelteKit build emits.
//
// Resolution strategy: prefer the compiled .svelte-kit output for production,
// fall back to a direct relative path for local dev (when build is fresh).
// The component locates the soul-hub root by walking up from import.meta.url.

import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Soul-hub repo root: catalog/components/agent-dispatch/ → ../../..
const SOUL_HUB_ROOT = resolvePath(__dirname, '..', '..', '..');

// ADR-005 D6 — agent context cap. Bigger blobs stall the PTY paste buffer.
const MAX_CONTEXT_CHARS = 4000;

// ADR-005 D5 — last-N event buffer. Bounds memory; full output is in output_excerpt.
const MAX_EVENT_BUFFER = 50;

// ADR-005 D7 — artifact marker convention.
const ARTIFACT_MARKER_RE = /===ARTIFACT===\s*\n([^\n]+)\s*\n===END===/;

const EXIT = {
	OK: 0,
	ERROR: 1,
	BAD_INPUT: 2,
};

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, message, extra = {}) {
	emit({ error: message, exit_code: code, ...extra });
	process.exit(code);
}

async function readStdin() {
	return new Promise((resolve, reject) => {
		let buf = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => { buf += chunk; });
		process.stdin.on('end', () => resolve(buf));
		process.stdin.on('error', reject);
	});
}

/** Resolve the soul-hub agent modules.
 *
 *  Test seam: set AGENT_DISPATCH_STUB_PATH to an absolute path of an ESM
 *  module that exports `{ dispatchAgent, getAgent }`. The test suite sets this
 *  to tests/fixtures/stub-agents.mjs so no live soul-hub build is needed.
 *
 *  Production: imports from the soul-hub source tree
 *  (src/lib/agents/dispatch/index.js + src/lib/agents/store.js). These files
 *  are TypeScript sources transpiled to .js by SvelteKit's Vite pipeline; the
 *  imports work when run inside the soul-hub Node process (which has the
 *  module graph already loaded) or via tsx for ad-hoc invocations. */
async function loadAgentModules() {
	// Test injection seam
	const stubPath = process.env.AGENT_DISPATCH_STUB_PATH;
	if (stubPath) {
		const stub = await import(stubPath);
		return {
			dispatchAgent: stub.dispatchAgent,
			getAgent: stub.getAgent,
		};
	}

	try {
		const dispatchModule = await import(
			join(SOUL_HUB_ROOT, 'src', 'lib', 'agents', 'dispatch', 'index.js')
		);
		const storeModule = await import(
			join(SOUL_HUB_ROOT, 'src', 'lib', 'agents', 'store.js')
		);
		return {
			dispatchAgent: dispatchModule.dispatchAgent,
			getAgent: storeModule.getAgent,
		};
	} catch (firstErr) {
		// Fallback: look for the module in the .svelte-kit build output chunks.
		// SvelteKit splits the agent modules into two separate chunks:
		//   dispatch.js — exports dispatchAgent
		//   store.js    — exports getAgent
		// Note: these chunks use mangled export names in production builds.
		// We reach for the named exports via the chunk's live module object.
		try {
			const dispatchChunk = await import(
				join(SOUL_HUB_ROOT, '.svelte-kit', 'output', 'server', 'chunks', 'dispatch.js')
			);
			const storeChunk = await import(
				join(SOUL_HUB_ROOT, '.svelte-kit', 'output', 'server', 'chunks', 'store.js')
			);
			// Named exports may be mangled; scan the module object for the functions.
			const dispatchAgent = dispatchChunk.dispatchAgent
				?? Object.values(dispatchChunk).find(
					(v) => typeof v === 'function' && v.name === 'dispatchAgent',
				);
			const getAgent = storeChunk.getAgent
				?? Object.values(storeChunk).find(
					(v) => typeof v === 'function' && v.name === 'getAgent',
				);
			if (typeof dispatchAgent !== 'function' || typeof getAgent !== 'function') {
				throw new Error('could not locate dispatchAgent or getAgent in build chunks');
			}
			return { dispatchAgent, getAgent };
		} catch {
			throw new Error(
				`agent-dispatch: could not load $lib/agents module (${firstErr.message}). ` +
				'Run "npm run build" in the soul-hub root or set AGENT_DISPATCH_STUB_PATH ' +
				'to a stub module for testing.',
			);
		}
	}
}

async function main() {
	// Read + parse stdin
	let raw;
	try {
		raw = await readStdin();
	} catch (err) {
		fail(EXIT.BAD_INPUT, `failed to read stdin: ${err.message}`);
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		fail(EXIT.BAD_INPUT, 'stdin must be valid JSON');
	}

	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}

	const {
		agent: agentSlug,
		task,
		context: contextRaw,
		goal_condition: goalConditionRaw,
		mode = 'production',
		timeout_sec,
		max_turns,
		max_usd,
	} = payload;

	// Required field validation
	if (typeof agentSlug !== 'string' || !agentSlug.trim()) {
		fail(EXIT.BAD_INPUT, '`agent` is required and must be a non-empty string');
	}
	if (typeof task !== 'string' || !task.trim()) {
		fail(EXIT.BAD_INPUT, '`task` is required and must be a non-empty string');
	}
	if (!['production', 'test', 'oneshot'].includes(mode)) {
		fail(EXIT.BAD_INPUT, '`mode` must be one of: production, test, oneshot');
	}

	// Load the agents module (resolves soul-hub's $lib/agents)
	let dispatchAgent, getAgent;
	try {
		({ dispatchAgent, getAgent } = await loadAgentModules());
	} catch (err) {
		fail(EXIT.ERROR, err.message);
	}

	// Agent existence check (mirrors runner.ts:444-453)
	if (!getAgent(agentSlug)) {
		fail(EXIT.ERROR, `agent not found: ${agentSlug}`, {
			agent_status: 'error',
			num_turns: 0,
			cost_usd: 0,
			exit_code: EXIT.ERROR,
		});
	}

	// Context cap (mirrors runner.ts:467-473 — ADR-005 D6)
	let context;
	if (contextRaw != null) {
		const interpolated = String(contextRaw);
		context = interpolated.length > MAX_CONTEXT_CHARS
			? interpolated.slice(0, MAX_CONTEXT_CHARS)
			: interpolated;
	}

	const goalCondition = typeof goalConditionRaw === 'string' && goalConditionRaw.trim()
		? goalConditionRaw
		: undefined;

	// Build budget override from optional inputs
	const budgetOverride = {};
	if (typeof timeout_sec === 'number' && timeout_sec > 0) budgetOverride.timeout_sec = timeout_sec;
	if (typeof max_turns === 'number' && max_turns > 0) budgetOverride.max_turns = max_turns;
	if (typeof max_usd === 'number' && max_usd > 0) budgetOverride.max_usd = max_usd;

	// Dispatch loop (mirrors runner.ts:479-513)
	const events = [];
	let final;
	try {
		const gen = dispatchAgent(agentSlug, task, {
			mode,
			context,
			goal_condition: goalCondition,
			budget_override: Object.keys(budgetOverride).length > 0 ? budgetOverride : undefined,
		});
		// Use iterator protocol explicitly to capture TReturn (DispatchResult).
		// for-await-of drops the generator's return value — see
		// feedback_asyncgenerator_return_value_loop.md.
		while (true) {
			const next = await gen.next();
			if (next.done) {
				final = next.value;
				break;
			}
			events.push(next.value);
			if (events.length > MAX_EVENT_BUFFER) events.shift();
		}
	} catch (err) {
		emit({
			error: `dispatcher threw: ${err.message}`,
			agent_status: 'error',
			num_turns: 0,
			cost_usd: 0,
			output_excerpt: '',
			exit_code: EXIT.ERROR,
		});
		process.exit(EXIT.ERROR);
	}

	// Defensive: generator contract says TReturn is non-optional, but guard anyway
	// (mirrors runner.ts:516-530)
	if (!final) {
		emit({
			error: 'dispatcher returned no final result',
			agent_status: 'error',
			num_turns: 0,
			cost_usd: 0,
			output_excerpt: '',
			exit_code: EXIT.ERROR,
		});
		process.exit(EXIT.ERROR);
	}

	// Map status to exit code (mirrors runner.ts:532)
	const passed = final.status === 'success' || final.status === 'goal_achieved';

	// Artifact marker extraction (mirrors runner.ts:533-534 — ADR-005 D7)
	const artifactMatch = final.output.match(ARTIFACT_MARKER_RE);
	const artifactPath = artifactMatch?.[1]?.trim() || undefined;

	// Output excerpt: last 2000 chars (mirrors runner.ts:535)
	const outputExcerpt = final.output.slice(-2000);

	const out = {
		output_excerpt: outputExcerpt,
		agent_status: final.status,
		num_turns: final.num_turns,
		cost_usd: final.cost_usd,
		exit_code: passed ? EXIT.OK : EXIT.ERROR,
	};
	if (artifactPath) out.artifact_path = artifactPath;
	if (!passed) out.error = final.error || `agent dispatch status: ${final.status}`;

	emit(out);
	process.exit(out.exit_code);
}

main().catch((err) => {
	emit({ error: `unexpected error: ${err.message}`, exit_code: EXIT.ERROR });
	process.exit(EXIT.ERROR);
});
