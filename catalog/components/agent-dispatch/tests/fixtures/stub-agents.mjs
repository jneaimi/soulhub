/**
 * Stub module that mimics soul-hub's $lib/agents/dispatch/index.js +
 * $lib/agents/store.js for agent-dispatch component tests.
 *
 * Agents registry:
 *   stub-success     — returns status: success, output includes no artifact
 *   stub-goal        — returns status: goal_achieved
 *   stub-failed      — returns status: failed with an error message
 *   stub-artifact    — returns status: success with ===ARTIFACT=== marker
 *   stub-throw       — generator throws (simulates dispatcher crash)
 *   stub-cancelled   — returns status: cancelled
 */

export const KNOWN_AGENTS = new Set([
	'stub-success',
	'stub-goal',
	'stub-failed',
	'stub-artifact',
	'stub-throw',
	'stub-cancelled',
]);

export function getAgent(id) {
	if (!KNOWN_AGENTS.has(id)) return null;
	return { id, name: id, backend: 'claude-pty' };
}

export async function* dispatchAgent(id, task, opts = {}) {
	yield { type: 'started', backend: 'claude-pty', runId: 'stub-run-1', ts: Date.now() };
	yield { type: 'output', data: `Running task: ${task.slice(0, 80)}`, ts: Date.now() };

	if (id === 'stub-throw') {
		throw new Error('simulated dispatcher crash');
	}

	if (id === 'stub-success') {
		yield { type: 'done', ts: Date.now() };
		return {
			runId: 'stub-run-1',
			agentId: id,
			backend: 'claude-pty',
			status: 'success',
			output: 'Task completed successfully. Here is the result.',
			cost_usd: 0.012,
			num_turns: 3,
			duration_ms: 1200,
		};
	}

	if (id === 'stub-goal') {
		yield { type: 'done', ts: Date.now() };
		return {
			runId: 'stub-run-2',
			agentId: id,
			backend: 'claude-pty',
			status: 'goal_achieved',
			output: 'Goal condition met. Research complete.',
			cost_usd: 0.024,
			num_turns: 5,
			duration_ms: 2400,
		};
	}

	if (id === 'stub-failed') {
		yield { type: 'error', message: 'agent exceeded budget', ts: Date.now() };
		yield { type: 'done', ts: Date.now() };
		return {
			runId: 'stub-run-3',
			agentId: id,
			backend: 'claude-pty',
			status: 'failed',
			output: 'Partial output before failure.',
			cost_usd: 0.50,
			num_turns: 25,
			duration_ms: 5000,
			error: 'budget exhausted',
		};
	}

	if (id === 'stub-artifact') {
		const output = [
			'Here is the research brief.',
			'',
			'===ARTIFACT===',
			'~/vault/knowledge/research/2026-05-20-stub-result.md',
			'===END===',
		].join('\n');
		yield { type: 'done', ts: Date.now() };
		return {
			runId: 'stub-run-4',
			agentId: id,
			backend: 'claude-pty',
			status: 'success',
			output,
			cost_usd: 0.018,
			num_turns: 4,
			duration_ms: 1800,
		};
	}

	if (id === 'stub-cancelled') {
		yield { type: 'done', ts: Date.now() };
		return {
			runId: 'stub-run-5',
			agentId: id,
			backend: 'claude-pty',
			status: 'cancelled',
			output: '',
			cost_usd: 0.001,
			num_turns: 1,
			duration_ms: 200,
			error: 'AbortSignal fired',
		};
	}

	// Default fallback
	yield { type: 'done', ts: Date.now() };
	return {
		runId: 'stub-run-0',
		agentId: id,
		backend: 'claude-pty',
		status: 'success',
		output: 'fallback output',
		cost_usd: 0,
		num_turns: 1,
		duration_ms: 100,
	};
}
