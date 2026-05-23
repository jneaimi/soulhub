import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type {
	PlaybookSpec, PlaybookRun, PlaybookPhase, PlaybookAssignment,
	PhaseResult, AssignmentResult, RunStatus, PhaseStatus, AssignmentStatus,
} from './types.js';
import { parsePlaybook, getPhaseOrder, resolvePlaybookRef, validatePlaybookRun } from './parser.js';
import { providerRegistry } from './providers/index.js';
import type { TaskAssignment, TaskOutputCallback } from './providers/types.js';
import { PlaybookContext } from './context.js';
import { runHooks, checkPrerequisites, extractTimeout, extractScanSummary } from './hooks.js';
import type { HookResult } from './hooks.js';
import { savePlaybookRunSummary } from '../vault/playbook-bridge.js';
import { RunEventEmitter } from '$lib/sessions/emitter.js';

// ─── Helpers ───

/**
 * Evaluate a skip_if condition against resolved inputs.
 * Supports: "$inputs.X == false", "$inputs.X == true", "$inputs.X == 'value'"
 */
function evaluateSkipIf(condition: string, inputs: Record<string, string | number>): boolean {
	// Pattern: $inputs.X == value
	const match = condition.match(/\$inputs\.(\w+)\s*(==|!=)\s*(.+)/);
	if (!match) return false;

	const [, inputId, operator, rawValue] = match;
	const actual = String(inputs[inputId] ?? '').toLowerCase().trim();
	const expected = rawValue.replace(/^['"]|['"]$/g, '').toLowerCase().trim();

	if (operator === '==') return actual === expected;
	if (operator === '!=') return actual !== expected;
	return false;
}

/** Parse a timeout string like '30m', '2h', '72h' into milliseconds */
function parseTimeout(timeout: string): number {
	const match = timeout.match(/^(\d+)(s|m|h|d)$/);
	if (!match) return 30 * 60 * 1000; // default 30 minutes

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case 's': return value * 1000;
		case 'm': return value * 60 * 1000;
		case 'h': return value * 60 * 60 * 1000;
		case 'd': return value * 24 * 60 * 60 * 1000;
		default: return 30 * 60 * 1000;
	}
}

// ─── Event Types ───

export type PlaybookEventType =
	| 'run_start' | 'run_complete' | 'run_failed'
	| 'phase_start' | 'phase_complete' | 'phase_failed'
	| 'assignment_start' | 'assignment_complete' | 'assignment_failed'
	| 'assignment_output' | 'output_landed'
	| 'human_required' | 'gate_required'
	| 'hook_start' | 'hook_complete';

export interface PlaybookEvent {
	type: PlaybookEventType;
	runId: string;
	phaseId?: string;
	role?: string;
	data?: string;
	error?: string;
	timestamp: string;
}

export type PlaybookEventCallback = (event: PlaybookEvent) => void;
export type PlaybookOutputCallback = (taskId: string, data: string) => void;

/**
 * Translate the playbook-internal event vocabulary into SoulHubEvent JSONL.
 * Phase boundaries map to step_start/step_end with stepId = phaseId.
 * Assignment events nest as parentEventId-less step events keyed by `${phaseId}:${role}`.
 * The terminal run_complete/run_failed events are handled by the engine
 * directly (which emits a `run_end` event after this translator returns).
 */
function translatePlaybookEventToSoulHub(event: PlaybookEvent, emitter: RunEventEmitter): void {
	switch (event.type) {
		case 'phase_start':
			if (event.phaseId) {
				void emitter.emit({
					type: 'step_start',
					stepId: event.phaseId,
					stepType: 'phase',
					timestamp: event.timestamp,
				});
			}
			return;
		case 'phase_complete':
			if (event.phaseId) {
				void emitter.emit({
					type: 'step_end',
					stepId: event.phaseId,
					status: 'ok',
					durationMs: 0,
					timestamp: event.timestamp,
				});
			}
			return;
		case 'phase_failed':
			if (event.phaseId) {
				void emitter.emit({
					type: 'step_end',
					stepId: event.phaseId,
					status: 'error',
					durationMs: 0,
					error: event.error,
					timestamp: event.timestamp,
				});
			}
			return;
		case 'assignment_start':
			if (event.phaseId && event.role) {
				void emitter.emit({
					type: 'agent_spawn',
					stepId: event.phaseId,
					provider: event.role,
					timestamp: event.timestamp,
				});
			}
			return;
		case 'output_landed':
			if (event.data) {
				try {
					const parsed = JSON.parse(event.data) as { target?: string; type?: string; bytes?: number };
					if (parsed.target) {
						void emitter.emit({
							type: 'output_landed',
							stepId: event.phaseId ?? 'output',
							surface: 'vault',
							path: parsed.target,
							bytes: parsed.bytes ?? 0,
							timestamp: event.timestamp,
						});
					}
				} catch {
					/* malformed event.data — skip */
				}
			}
			return;
		default:
			// run_start, run_complete, run_failed, gate/human, hook events:
			// engine handles run start/end directly; the rest aren't part of the
			// minimum vocabulary today. Tolerate silently.
			return;
	}
}

// ─── Active Runs ───

const activeRuns = new Map<string, PlaybookRun>();
const runAbortFlags = new Map<string, boolean>();

// ─── Pending Gates ───

/** Pending gate: suspends the engine until user acts */
interface PendingPlaybookGate {
	resolve: (value: { action: 'approve' | 'reject' | 'human_input'; value?: string }) => void;
	reject: (reason: Error) => void;
	runId: string;
	phaseId: string;
	type: 'gate' | 'human';
	timeout: ReturnType<typeof setTimeout>;
}

/** Active gates keyed by runId:phaseId */
const pendingGates = new Map<string, PendingPlaybookGate>();

/** Approve a gate phase */
export function approvePlaybookGate(runId: string, phaseId: string): boolean {
	const key = `${runId}:${phaseId}`;
	const gate = pendingGates.get(key);
	if (!gate) return false;
	clearTimeout(gate.timeout);
	gate.resolve({ action: 'approve' });
	pendingGates.delete(key);
	return true;
}

/** Reject a gate phase */
export function rejectPlaybookGate(runId: string, phaseId: string, reason?: string): boolean {
	const key = `${runId}:${phaseId}`;
	const gate = pendingGates.get(key);
	if (!gate) return false;
	clearTimeout(gate.timeout);
	gate.reject(new Error(reason || 'Rejected by user'));
	pendingGates.delete(key);
	return true;
}

/** Submit human input */
export function submitHumanInput(runId: string, phaseId: string, value: string): boolean {
	const key = `${runId}:${phaseId}`;
	const gate = pendingGates.get(key);
	if (!gate || gate.type !== 'human') return false;
	clearTimeout(gate.timeout);
	gate.resolve({ action: 'human_input', value });
	pendingGates.delete(key);
	return true;
}

/** Get a run by ID */
export function getPlaybookRun(runId: string): PlaybookRun | undefined {
	return activeRuns.get(runId);
}

/** Kill a running playbook */
export function killPlaybook(runId: string): boolean {
	if (!activeRuns.has(runId)) return false;
	runAbortFlags.set(runId, true);
	// Clean up any pending gates for this run
	for (const [key, gate] of pendingGates) {
		if (key.startsWith(`${runId}:`)) {
			clearTimeout(gate.timeout);
			gate.reject(new Error('Playbook killed'));
			pendingGates.delete(key);
		}
	}
	return true;
}

// ─── Main Runner ───

/**
 * Run a playbook from a YAML file.
 * Supports all phase types: sequential, parallel, handoff, human, gate.
 */
export async function runPlaybook(
	playbookDir: string,
	inputOverrides: Record<string, string | number> = {},
	onEvent?: PlaybookEventCallback,
	onOutput?: PlaybookOutputCallback,
	externalRunId?: string,
): Promise<PlaybookRun> {
	const yamlPath = join(playbookDir, 'playbook.yaml');
	const spec = await parsePlaybook(yamlPath);

	// Validate inputs
	const validation = validatePlaybookRun(spec, inputOverrides);
	if (!validation.ok) {
		throw new Error(`Playbook validation failed: ${validation.errors.join('; ')}`);
	}

	const runId = externalRunId || crypto.randomUUID().slice(0, 8);
	// Use playbook's own output/ dir (shorter paths, persists results)
	// Temp dir paths are too long for agents to write reliably
	const runDir = join(playbookDir, 'output', runId);
	const outputDir = join(runDir, 'outputs');
	await mkdir(outputDir, { recursive: true });

	// Initialize shared context
	const context = new PlaybookContext(runDir);
	await context.init();

	// Resolve inputs
	const resolvedInputs: Record<string, string | number> = {};
	for (const input of spec.inputs || []) {
		resolvedInputs[input.id] = inputOverrides[input.id] ?? input.default ?? '';
	}

	// Build role map
	const roleMap = new Map(spec.roles.map(r => [r.id, r]));

	// ─── Run pre_run hooks ───
	let hookResults: HookResult[] = [];
	let dynamicTimeout = 600; // default 10 min
	let scanSummary: string | null = null;

	if (spec.hooks?.pre_run && spec.hooks.pre_run.length > 0) {
		// Note: emit not available yet (defined after run init), use console
		console.log(`[playbook] Running ${spec.hooks.pre_run.length} pre_run hook(s)`);
		hookResults = await runHooks(spec.hooks.pre_run, playbookDir, resolvedInputs);
		console.log(`[playbook] pre_run hooks done: ${hookResults.map(h => `${h.id}=${h.status}`).join(', ')}`);

		// Extract dynamic timeout
		if (spec.timeout_strategy === 'auto') {
			const extracted = extractTimeout(hookResults);
			if (extracted) {
				dynamicTimeout = extracted;
				console.log(`[playbook] Dynamic timeout: ${dynamicTimeout}s (from hook)`);
			}
		}

		// Extract scan summary for context injection
		scanSummary = extractScanSummary(hookResults);
	}

	// Check prerequisites
	if (spec.prerequisites && spec.prerequisites.length > 0) {
		const prereqResults = await checkPrerequisites(spec.prerequisites);
		const missing = prereqResults.filter(p => p.required && !p.available);
		if (missing.length > 0) {
			const missingList = missing.map(p => `${p.name}${p.install ? ` (install: ${p.install})` : ''}`).join(', ');
			throw new Error(`Missing prerequisites: ${missingList}`);
		}
	}

	// Initialize run state
	const run: PlaybookRun = {
		runId,
		playbookName: spec.name,
		playbookDir,
		status: 'running',
		phases: spec.phases.map(p => ({
			id: p.id,
			type: p.type,
			status: 'pending' as PhaseStatus,
			assignments: p.assignments.map(a => ({
				role: a.role,
				provider: roleMap.get(a.role)?.provider || 'claude',
				status: 'pending' as AssignmentStatus,
			})),
		})),
		startedAt: new Date().toISOString(),
		resolvedInputs,
		contextDir: context.dir,
		outputDir,
	};

	activeRuns.set(runId, run);
	runAbortFlags.set(runId, false);

	// SoulHubEvent JSONL emitter — wrap the user-supplied onEvent so playbook
	// events translate to the shared event vocabulary. The engine's internal
	// event API is untouched; this is a single boundary at the run-start point.
	const sessionEmitter = new RunEventEmitter(runId);
	void sessionEmitter.emit({
		type: 'run_start',
		surface: 'playbook',
		name: spec.name,
		cwd: playbookDir,
		inputs: { ...resolvedInputs },
		timestamp: run.startedAt,
	});
	const userOnEvent = onEvent;
	const onEventWrapped: PlaybookEventCallback = (event) => {
		userOnEvent?.(event);
		translatePlaybookEventToSoulHub(event, sessionEmitter);
	};

	const emit = (type: PlaybookEventType, extra: Partial<PlaybookEvent> = {}) => {
		onEventWrapped({
			type,
			runId,
			timestamp: new Date().toISOString(),
			...extra,
		});
	};

	emit('run_start');

	// Track phase outputs for variable resolution
	// phaseId -> { outputBasename: fullPath }
	const phaseOutputs: Record<string, Record<string, string>> = {};

	try {
		// Get execution order
		const phaseOrder = getPhaseOrder(spec);
		const phaseMap = new Map(spec.phases.map(p => [p.id, p]));

		for (const phaseId of phaseOrder) {
			// Check abort
			if (runAbortFlags.get(runId)) {
				run.status = 'failed';
				break;
			}

			const phase = phaseMap.get(phaseId)!;
			const phaseResult = run.phases.find(p => p.id === phaseId)!;

			// Evaluate skip_if condition
			if (phase.skip_if && evaluateSkipIf(phase.skip_if, resolvedInputs)) {
				phaseResult.status = 'skipped';
				emit('phase_complete', { phaseId, data: `Skipped: ${phase.skip_if}` });
				continue;
			}

			// Consensus is Phase 4+ — skip with warning
			if (phase.type === 'consensus') {
				phaseResult.status = 'skipped';
				phaseResult.error = `Phase type "consensus" not yet supported`;
				emit('phase_failed', { phaseId, error: phaseResult.error });
				continue;
			}

			phaseResult.status = 'running';
			phaseResult.startedAt = new Date().toISOString();
			emit('phase_start', { phaseId });

			phaseOutputs[phaseId] = {};

			try {
				if (phase.type === 'parallel') {
					// ─── Parallel execution ───
					context.lock();
					const contextPrompt = await context.buildContextPrompt();
					const maxConcurrency = 3;
					const assignments = phase.assignments;

					for (let batchStart = 0; batchStart < assignments.length; batchStart += maxConcurrency) {
						if (runAbortFlags.get(runId)) throw new Error('Aborted by user');

						const batch = assignments.slice(batchStart, batchStart + maxConcurrency);
						const batchIndices = batch.map((_, j) => batchStart + j);

						const promises = batch.map(async (assignment, j) => {
							const i = batchIndices[j];
							const assignResult = phaseResult.assignments[i];
							const role = roleMap.get(assignment.role);

							if (!role) throw new Error(`Unknown role "${assignment.role}" in phase "${phaseId}"`);

							assignResult.status = 'running';
							assignResult.startedAt = new Date().toISOString();
							emit('assignment_start', { phaseId, role: assignment.role });

							let inputFiles: string[] = [];
							if (assignment.input) {
								const inputs = Array.isArray(assignment.input) ? assignment.input : [assignment.input];
								inputFiles = inputs.map(ref => {
									try { return resolvePlaybookRef(ref, resolvedInputs, phaseOutputs); }
									catch { return ref; }
								});
							}

							const outputPath = join(outputDir, phaseId, assignment.output);
							await mkdir(dirname(outputPath), { recursive: true });

							let resolvedTask: string;
							try { resolvedTask = resolvePlaybookRef(assignment.task, resolvedInputs, phaseOutputs); }
							catch { resolvedTask = assignment.task; }

							const { provider, fallback } = await providerRegistry.get(role.provider);
							assignResult.provider = fallback ? `${provider.id} (fallback from ${role.provider})` : provider.id;

							let enrichedContext = contextPrompt || '';
							if (scanSummary) {
								enrichedContext = `## Target Overview\n\n${scanSummary}\n\n${enrichedContext}`;
							}

							const taskAssignment: TaskAssignment = {
								taskId: `${runId}-${phaseId}-${assignment.role}-${i}`,
								role: assignment.role,
								task: resolvedTask,
								inputFiles: inputFiles.filter(f => existsSync(f)),
								outputPath,
								contextPrompt: enrichedContext || undefined,
								cwd: playbookDir,
								model: role.model,
								timeout: dynamicTimeout,
								skills: role.skills,
								mcp: role.mcp,
							};

							const result = await provider.execute(taskAssignment, (taskId, data) => {
								onOutput?.(taskId, data);
								emit('assignment_output', { phaseId, role: assignment.role, data });
							});

							assignResult.completedAt = new Date().toISOString();

							if (result.status === 'completed' && result.outputPath) {
								assignResult.status = 'completed';
								assignResult.output = result.outputPath;

								const outputBasename = basename(assignment.output).replace(/\.[^.]+$/, '');
								phaseOutputs[phaseId][outputBasename] = result.outputPath;

								try {
									const content = await readFile(result.outputPath, 'utf-8');
									context.queueWrite(`${phaseId}/${assignment.output}`, content);
								} catch { /* non-critical */ }

								emit('assignment_complete', { phaseId, role: assignment.role });
							} else {
								assignResult.status = 'failed';
								assignResult.error = result.error || 'Unknown error';
								emit('assignment_failed', { phaseId, role: assignment.role, error: assignResult.error });
							}

							return assignResult;
						});

						await Promise.allSettled(promises);
					}

					await context.unlock();

					const failed = phaseResult.assignments.filter(a => a.status === 'failed');
					if (failed.length > 0) {
						throw new Error(`${failed.length} parallel assignment(s) failed: ${failed.map(f => f.role).join(', ')}`);
					}
				} else if (phase.type === 'handoff') {
					// ─── Handoff phase ───
					const maxIter = phase.max_iterations || 3;
					const [roleAId, roleBId] = phase.between || [];
					const roleA = roleMap.get(roleAId);
					const roleB = roleMap.get(roleBId);

					if (!roleA || !roleB) {
						throw new Error(`Handoff phase "${phaseId}": requires 2 valid roles in "between"`);
					}

					let lastOutput = '';
					let approved = false;

					for (let iteration = 1; iteration <= maxIter; iteration++) {
						if (runAbortFlags.get(runId)) throw new Error('Aborted by user');

						phaseResult.iterations = iteration;

						// ─── Role A produces ───
						const assignResultA: AssignmentResult = {
							role: roleAId,
							provider: roleA.provider,
							status: 'running',
							startedAt: new Date().toISOString(),
							iteration,
						};
						phaseResult.assignments.push(assignResultA);
						emit('assignment_start', { phaseId, role: roleAId, data: `iteration ${iteration}` });

						const outputPathA = join(outputDir, phaseId, `${roleAId}-iter-${iteration}.md`);
						await mkdir(dirname(outputPathA), { recursive: true });

						// Build task for role A: include feedback from role B (if not first iteration)
						let taskA = phase.assignments.find(a => a.role === roleAId)?.task || '';
						try { taskA = resolvePlaybookRef(taskA, resolvedInputs, phaseOutputs); }
						catch { /* keep as-is */ }

						if (iteration > 1 && lastOutput) {
							taskA += `\n\n## Feedback from previous iteration\n\nRead the feedback file and address all points: ${lastOutput}`;
						}

						const contextPromptA = await context.buildContextPrompt();
						let enrichedContextA = contextPromptA || '';
						if (scanSummary) {
							enrichedContextA = `## Target Overview\n\n${scanSummary}\n\n${enrichedContextA}`;
						}
						const { provider: provA, fallback: fbA } = await providerRegistry.get(roleA.provider);
						assignResultA.provider = fbA ? `${provA.id} (fallback)` : provA.id;

						const resultA = await provA.execute({
							taskId: `${runId}-${phaseId}-${roleAId}-iter${iteration}`,
							role: roleAId,
							task: taskA,
							inputFiles: lastOutput ? [lastOutput] : [],
							outputPath: outputPathA,
							contextPrompt: enrichedContextA || undefined,
							cwd: playbookDir,
							model: roleA.model,
							timeout: dynamicTimeout,
							skills: roleA.skills,
							mcp: roleA.mcp,
						}, (taskId, data) => {
							onOutput?.(taskId, data);
							emit('assignment_output', { phaseId, role: roleAId, data });
						});

						assignResultA.completedAt = new Date().toISOString();

						if (resultA.status !== 'completed' || !resultA.outputPath) {
							assignResultA.status = 'failed';
							assignResultA.error = resultA.error || 'Unknown error';
							emit('assignment_failed', { phaseId, role: roleAId, error: assignResultA.error });
							throw new Error(`Handoff failed: ${roleAId} error=${assignResultA.error}`);
						}

						assignResultA.status = 'completed';
						assignResultA.output = resultA.outputPath;
						emit('assignment_complete', { phaseId, role: roleAId });

						// Save to context
						try {
							const content = await readFile(resultA.outputPath, 'utf-8');
							await context.write(`${phaseId}/${roleAId}-iter-${iteration}.md`, content);
						} catch { /* non-critical */ }

						// ─── Role B reviews ───
						const assignResultB: AssignmentResult = {
							role: roleBId,
							provider: roleB.provider,
							status: 'running',
							startedAt: new Date().toISOString(),
							iteration,
						};
						phaseResult.assignments.push(assignResultB);
						emit('assignment_start', { phaseId, role: roleBId, data: `iteration ${iteration}` });

						const outputPathB = join(outputDir, phaseId, `${roleBId}-iter-${iteration}.md`);

						let taskB = phase.assignments.find(a => a.role === roleBId)?.task || '';
						try { taskB = resolvePlaybookRef(taskB, resolvedInputs, phaseOutputs); }
						catch { /* keep as-is */ }

						const contextPromptB = await context.buildContextPrompt();
						let enrichedContextB = contextPromptB || '';
						if (scanSummary) {
							enrichedContextB = `## Target Overview\n\n${scanSummary}\n\n${enrichedContextB}`;
						}
						const { provider: provB, fallback: fbB } = await providerRegistry.get(roleB.provider);
						assignResultB.provider = fbB ? `${provB.id} (fallback)` : provB.id;

						const resultB = await provB.execute({
							taskId: `${runId}-${phaseId}-${roleBId}-iter${iteration}`,
							role: roleBId,
							task: taskB,
							inputFiles: [resultA.outputPath],
							outputPath: outputPathB,
							contextPrompt: enrichedContextB || undefined,
							cwd: playbookDir,
							model: roleB.model,
							timeout: dynamicTimeout,
							skills: roleB.skills,
							mcp: roleB.mcp,
						}, (taskId, data) => {
							onOutput?.(taskId, data);
							emit('assignment_output', { phaseId, role: roleBId, data });
						});

						assignResultB.completedAt = new Date().toISOString();

						if (resultB.status !== 'completed' || !resultB.outputPath) {
							assignResultB.status = 'failed';
							assignResultB.error = resultB.error || 'Unknown error';
							emit('assignment_failed', { phaseId, role: roleBId, error: assignResultB.error });
							throw new Error(`Handoff failed: ${roleBId} error=${assignResultB.error}`);
						}

						assignResultB.status = 'completed';
						assignResultB.output = resultB.outputPath;
						lastOutput = resultB.outputPath;
						emit('assignment_complete', { phaseId, role: roleBId });

						// Save to context
						try {
							const content = await readFile(resultB.outputPath, 'utf-8');
							await context.write(`${phaseId}/${roleBId}-iter-${iteration}.md`, content);
						} catch { /* non-critical */ }

						// Check loop_until condition
						if (phase.loop_until) {
							try {
								const reviewContent = await readFile(resultB.outputPath, 'utf-8');
								// Simple string containment check (same as pipeline condition evaluator)
								const condition = phase.loop_until;
								// Support: "review contains 'APPROVED'"
								const containsMatch = condition.match(/(\w+)\s+contains\s+['"](.+?)['"]/);
								if (containsMatch) {
									const searchTerm = containsMatch[2];
									if (reviewContent.toLowerCase().includes(searchTerm.toLowerCase())) {
										approved = true;
									}
								}
							} catch { /* can't read output — continue looping */ }

							if (approved) {
								// Register final outputs
								phaseOutputs[phaseId] = phaseOutputs[phaseId] || {};
								const lastABasename = basename(outputPathA).replace(/\.[^.]+$/, '').replace(/-iter-\d+$/, '');
								const lastBBasename = basename(outputPathB).replace(/\.[^.]+$/, '').replace(/-iter-\d+$/, '');
								phaseOutputs[phaseId][lastABasename] = resultA.outputPath;
								phaseOutputs[phaseId][lastBBasename] = resultB.outputPath;
								break;
							}
						}
					}

					if (!approved && phase.loop_until) {
						// Max iterations reached without approval
						phaseResult.error = `Handoff "${phaseId}" reached max iterations (${maxIter}) without meeting condition: ${phase.loop_until}`;
						// Still register the last outputs (partial success)
						if (lastOutput) {
							phaseOutputs[phaseId] = phaseOutputs[phaseId] || {};
							phaseOutputs[phaseId]['last-review'] = lastOutput;
						}
						// Don't throw — let it proceed with a warning
						emit('phase_failed', { phaseId, error: phaseResult.error });
					}

				} else if (phase.type === 'human') {
					// ─── Human phase ───
					// Run any assignments first (they produce context for the human)
					for (let i = 0; i < phase.assignments.length; i++) {
						if (runAbortFlags.get(runId)) throw new Error('Aborted by user');

						const assignment = phase.assignments[i];
						const assignResult = phaseResult.assignments[i];
						const role = roleMap.get(assignment.role);

						if (!role) throw new Error(`Unknown role "${assignment.role}" in phase "${phaseId}"`);

						assignResult.status = 'running';
						assignResult.startedAt = new Date().toISOString();
						emit('assignment_start', { phaseId, role: assignment.role });

						let inputFiles: string[] = [];
						if (assignment.input) {
							const inputs = Array.isArray(assignment.input) ? assignment.input : [assignment.input];
							inputFiles = inputs.map(ref => {
								try { return resolvePlaybookRef(ref, resolvedInputs, phaseOutputs); }
								catch { return ref; }
							});
						}

						const outputPath = join(outputDir, phaseId, assignment.output);
						await mkdir(dirname(outputPath), { recursive: true });

						let resolvedTask: string;
						try { resolvedTask = resolvePlaybookRef(assignment.task, resolvedInputs, phaseOutputs); }
						catch { resolvedTask = assignment.task; }

						const { provider, fallback } = await providerRegistry.get(role.provider);
						assignResult.provider = fallback ? `${provider.id} (fallback from ${role.provider})` : provider.id;

						const contextPrompt = await context.buildContextPrompt();
						let enrichedContextH = contextPrompt || '';
						if (scanSummary) {
							enrichedContextH = `## Target Overview\n\n${scanSummary}\n\n${enrichedContextH}`;
						}
						const taskAssignment: TaskAssignment = {
							taskId: `${runId}-${phaseId}-${assignment.role}-${i}`,
							role: assignment.role,
							task: resolvedTask,
							inputFiles: inputFiles.filter(f => existsSync(f)),
							outputPath,
							contextPrompt: enrichedContextH || undefined,
							cwd: playbookDir,
							model: role.model,
							timeout: dynamicTimeout,
							skills: role.skills,
							mcp: role.mcp,
						};

						const result = await provider.execute(taskAssignment, (taskId, data) => {
							onOutput?.(taskId, data);
							emit('assignment_output', { phaseId, role: assignment.role, data });
						});

						assignResult.completedAt = new Date().toISOString();

						if (result.status === 'completed' && result.outputPath) {
							assignResult.status = 'completed';
							assignResult.output = result.outputPath;
							const outputBasename = basename(assignment.output).replace(/\.[^.]+$/, '');
							phaseOutputs[phaseId][outputBasename] = result.outputPath;
							try {
								const content = await readFile(result.outputPath, 'utf-8');
								await context.write(`${phaseId}/${assignment.output}`, content);
							} catch { /* non-critical */ }
							emit('assignment_complete', { phaseId, role: assignment.role });
						} else {
							assignResult.status = 'failed';
							assignResult.error = result.error || 'Unknown error';
							emit('assignment_failed', { phaseId, role: assignment.role, error: assignResult.error });
							throw new Error(`Assignment failed: role=${assignment.role}, error=${assignResult.error}`);
						}
					}

					// Collect assignment outputs for the human reviewer
					const reviewFiles: Record<string, string> = {};
					for (const [key, filePath] of Object.entries(phaseOutputs[phaseId] || {})) {
						try {
							reviewFiles[key] = await readFile(filePath, 'utf-8');
						} catch { /* skip unreadable */ }
					}

					// Now wait for human input
					const humanPrompt = phase.prompt || 'Human input required';
					emit('human_required', { phaseId, data: JSON.stringify({ prompt: humanPrompt, reviewFiles }) });
					run.status = 'paused';

					// Parse timeout (default 30m)
					const timeoutMs = parseTimeout(phase.timeout || '30m');

					const humanResult = await new Promise<{ action: string; value?: string }>((resolve, reject) => {
						const timeout = setTimeout(() => {
							pendingGates.delete(`${runId}:${phaseId}`);
							const onTimeout = phase.on_timeout || 'cancel';
							if (onTimeout === 'skip') {
								resolve({ action: 'skip' });
							} else {
								reject(new Error(`Human phase "${phaseId}" timed out`));
							}
						}, timeoutMs);

						pendingGates.set(`${runId}:${phaseId}`, {
							resolve,
							reject,
							runId,
							phaseId,
							type: 'human',
							timeout,
						});
					});

					run.status = 'running';

					if (humanResult.action === 'skip') {
						phaseResult.status = 'skipped';
						phaseResult.error = 'Human phase timed out — skipped';
						emit('phase_failed', { phaseId, error: phaseResult.error });
						continue; // skip to next phase
					}

					// Write human's response as the phase output
					if (humanResult.value) {
						const humanOutputPath = join(outputDir, phaseId, 'human-response.md');
						await mkdir(dirname(humanOutputPath), { recursive: true });
						await writeFile(humanOutputPath, humanResult.value, 'utf-8');
						phaseOutputs[phaseId] = phaseOutputs[phaseId] || {};
						phaseOutputs[phaseId]['human-response'] = humanOutputPath;
						try {
							await context.write(`${phaseId}/human-response.md`, humanResult.value);
						} catch { /* non-critical */ }
					}

				} else {
					// ─── Sequential execution (default for 'sequential' and 'gate') ───
					for (let i = 0; i < phase.assignments.length; i++) {
						if (runAbortFlags.get(runId)) throw new Error('Aborted by user');

						const assignment = phase.assignments[i];
						const assignResult = phaseResult.assignments[i];
						const role = roleMap.get(assignment.role);

						if (!role) {
							throw new Error(`Unknown role "${assignment.role}" in phase "${phaseId}"`);
						}

						assignResult.status = 'running';
						assignResult.startedAt = new Date().toISOString();
						emit('assignment_start', { phaseId, role: assignment.role });

						// Resolve input references
						let inputFiles: string[] = [];
						if (assignment.input) {
							const inputs = Array.isArray(assignment.input) ? assignment.input : [assignment.input];
							inputFiles = inputs.map(ref => {
								try {
									return resolvePlaybookRef(ref, resolvedInputs, phaseOutputs);
								} catch {
									return ref; // literal path
								}
							});
						}

						// Resolve output path
						const outputPath = join(outputDir, phaseId, assignment.output);
						await mkdir(dirname(outputPath), { recursive: true });

						// Resolve task with variable substitution
						let resolvedTask: string;
						try {
							resolvedTask = resolvePlaybookRef(assignment.task, resolvedInputs, phaseOutputs);
						} catch {
							resolvedTask = assignment.task; // use as-is if no refs
						}

						// Get provider
						const { provider, fallback } = await providerRegistry.get(role.provider);
						if (fallback) {
							assignResult.provider = `${provider.id} (fallback from ${role.provider})`;
						} else {
							assignResult.provider = provider.id;
						}

						// Build context prompt
						const contextPrompt = await context.buildContextPrompt();
						let enrichedContextS = contextPrompt || '';
						if (scanSummary) {
							enrichedContextS = `## Target Overview\n\n${scanSummary}\n\n${enrichedContextS}`;
						}

						// Build task assignment
						const taskAssignment: TaskAssignment = {
							taskId: `${runId}-${phaseId}-${assignment.role}-${i}`,
							role: assignment.role,
							task: resolvedTask,
							inputFiles: inputFiles.filter(f => existsSync(f)),
							outputPath,
							contextPrompt: enrichedContextS || undefined,
							cwd: playbookDir,
							model: role.model,
							timeout: dynamicTimeout,
							skills: role.skills,
							mcp: role.mcp,
						};

						// Execute
						const result = await provider.execute(taskAssignment, (taskId, data) => {
							onOutput?.(taskId, data);
							emit('assignment_output', { phaseId, role: assignment.role, data });
						});

						assignResult.completedAt = new Date().toISOString();

						if (result.status === 'completed' && result.outputPath) {
							assignResult.status = 'completed';
							assignResult.output = result.outputPath;

							// Register output for variable resolution
							const outputBasename = basename(assignment.output).replace(/\.[^.]+$/, '');
							phaseOutputs[phaseId][outputBasename] = result.outputPath;

							// Copy output to shared context for subsequent phases
							try {
								const content = await readFile(result.outputPath, 'utf-8');
								await context.write(`${phaseId}/${assignment.output}`, content);
							} catch { /* non-critical */ }

							emit('assignment_complete', { phaseId, role: assignment.role });
						} else {
							assignResult.status = 'failed';
							assignResult.error = result.error || 'Unknown error';
							emit('assignment_failed', { phaseId, role: assignment.role, error: assignResult.error });
							throw new Error(`Assignment failed: role=${assignment.role}, error=${assignResult.error}`);
						}
					}

					// Gate phase: suspend until user approves/rejects
					if (phase.type === 'gate') {
						const gateFiles: Record<string, string> = {};
						for (const [key, filePath] of Object.entries(phaseOutputs[phaseId] || {})) {
							try {
								gateFiles[key] = await readFile(filePath, 'utf-8');
							} catch { /* skip */ }
						}

						emit('gate_required', { phaseId, data: JSON.stringify({ prompt: phase.prompt || 'Approve to continue?', reviewFiles: gateFiles }) });
						run.status = 'paused';

						const gateResult = await new Promise<{ action: string; value?: string }>((resolve, reject) => {
							const timeoutMs = 30 * 60 * 1000; // 30 minute default timeout for gates
							const timeout = setTimeout(() => {
								pendingGates.delete(`${runId}:${phaseId}`);
								reject(new Error(`Gate "${phaseId}" timed out after 30 minutes`));
							}, timeoutMs);

							pendingGates.set(`${runId}:${phaseId}`, {
								resolve,
								reject,
								runId,
								phaseId,
								type: 'gate',
								timeout,
							});
						});

						run.status = 'running';

						if (gateResult.action === 'reject') {
							throw new Error(`Gate "${phaseId}" rejected by user`);
						}
						// action === 'approve' — continue execution
					}
				}

				phaseResult.status = 'completed';
				phaseResult.completedAt = new Date().toISOString();
				emit('phase_complete', { phaseId });

			} catch (error) {
				phaseResult.status = 'failed';
				phaseResult.completedAt = new Date().toISOString();
				phaseResult.error = error instanceof Error ? error.message : String(error);
				emit('phase_failed', { phaseId, error: phaseResult.error });

				// Check failure strategy
				if (spec.on_failure?.strategy === 'skip') {
					continue; // skip to next phase
				}
				// Default: halt
				run.status = 'failed';
				break;
			}
		}

		// Final status
		if (run.status !== 'failed') {
			const allDone = run.phases.every(p => p.status === 'completed' || p.status === 'skipped');
			run.status = allDone ? 'completed' : 'failed';
		}

	} catch (error) {
		run.status = 'failed';
		emit('run_failed', { error: error instanceof Error ? error.message : String(error) });
	}

	// Run post_run hooks
	if (spec.hooks?.post_run && spec.hooks.post_run.length > 0) {
		try {
			await runHooks(spec.hooks.post_run, playbookDir, resolvedInputs);
		} catch (err) {
			console.error('[playbook] post_run hook error:', err instanceof Error ? err.message : err);
		}
	}

	// Land outputs
	let landingResults: Array<{ type: string; target: string; status: string; error?: string }> = [];
	if (run.status === 'completed' || spec.on_failure?.land_partial) {
		try {
			const { landOutputs } = await import('./output.js');
			landingResults = await landOutputs(spec.output, run);
			for (const result of landingResults) {
				if (result.status === 'landed') {
					emit('output_landed', { data: JSON.stringify(result) });
				} else if (result.status === 'failed') {
					console.error(`[playbook] Output landing failed: ${result.type} — ${result.error}`);
				}
			}
		} catch (err) {
			console.error('[playbook] Output landing error:', err instanceof Error ? err.message : err);
		}
	}

	run.completedAt = new Date().toISOString();
	emit(run.status === 'completed' ? 'run_complete' : 'run_failed');

	// Save run summary to vault (non-blocking)
	savePlaybookRunSummary({
		playbookName: spec.name,
		runId,
		status: run.status === 'completed' ? 'completed' : 'failed',
		startedAt: run.startedAt,
		completedAt: run.completedAt || new Date().toISOString(),
		phases: run.phases,
		resolvedInputs: run.resolvedInputs,
		outputDir: run.outputDir,
		landingResults,
	}).catch(err => console.error('[playbook] Vault save error:', err));

	// Close the SoulHubEvent JSONL after the final run_complete/run_failed has flushed
	const runDurationMs = run.completedAt
		? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
		: 0;
	void sessionEmitter.emit({
		type: 'run_end',
		status: run.status === 'completed' ? 'ok' : 'error',
		durationMs: runDurationMs,
		timestamp: run.completedAt,
	});
	void sessionEmitter.close();

	// Clean up abort flag
	runAbortFlags.delete(runId);

	// Keep run in memory for status polling (evict after 10 min)
	setTimeout(() => activeRuns.delete(runId), 10 * 60 * 1000);

	return run;
}
