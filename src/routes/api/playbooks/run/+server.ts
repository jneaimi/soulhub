import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
	runPlaybook, killPlaybook, getPlaybookRun,
	parsePlaybook, validatePlaybookRun,
	approvePlaybookGate, rejectPlaybookGate, submitHumanInput,
	runPlaybookChain, killPlaybookChain, getPlaybookChainRun,
} from '$lib/playbook/index.js';
import { providerRegistry } from '$lib/playbook/providers/index.js';
import type { PlaybookPrerequisite, PlaybookRun } from '$lib/playbook/types.js';
import type { PlaybookChainRun } from '$lib/playbook/chain-types.js';

const execAsync = promisify(exec);

const PLAYBOOKS_DIR = resolve(process.cwd(), 'playbooks');

// ─── In-memory state (polling pattern, matches pipeline run API) ───

const activePlaybooks = new Set<string>();
const playbookRuns = new Map<string, PlaybookRun>();
const chainRuns = new Map<string, PlaybookChainRun>();
const runEvents = new Map<string, { phaseId: string; role?: string; status: string; detail?: string; time: string }[]>();
const outputBuffers = new Map<string, Map<string, string[]>>();

function evictRun(runId: string) {
	setTimeout(() => {
		playbookRuns.delete(runId);
		chainRuns.delete(runId);
		runEvents.delete(runId);
		outputBuffers.delete(runId);
	}, 10 * 60 * 1000); // 10 min
}

// ─── POST: start runs, actions, queries ───

/** POST /api/playbooks/run */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Handle kill
	if (body.action === 'kill') {
		const { runId } = body;
		if (!runId) return json({ error: 'Missing runId' }, { status: 400 });
		const killed = killPlaybook(runId) || killPlaybookChain(runId);
		if (killed) {
			const run = playbookRuns.get(runId);
			if (run) { run.status = 'failed'; run.completedAt = new Date().toISOString(); }
			const cr = chainRuns.get(runId);
			if (cr) { cr.status = 'failed'; cr.completedAt = new Date().toISOString(); }
			const events = runEvents.get(runId);
			events?.push({ phaseId: '_playbook', status: 'killed', detail: 'Killed by user', time: new Date().toISOString() });
			activePlaybooks.delete(run?.playbookName || cr?.chainName || '');
		}
		return json({ ok: killed });
	}

	// Handle gate approval
	if (body.action === 'approve') {
		const { runId, phaseId } = body;
		if (!runId || !phaseId) return json({ error: 'Missing runId or phaseId' }, { status: 400 });
		const ok = approvePlaybookGate(runId, phaseId);
		if (ok) {
			runEvents.get(runId)?.push({ phaseId, status: 'approved', time: new Date().toISOString() });
		}
		return json({ ok });
	}

	// Handle gate rejection
	if (body.action === 'reject') {
		const { runId, phaseId, reason } = body;
		if (!runId || !phaseId) return json({ error: 'Missing runId or phaseId' }, { status: 400 });
		const ok = rejectPlaybookGate(runId, phaseId, reason);
		if (ok) {
			runEvents.get(runId)?.push({ phaseId, status: 'rejected', detail: reason, time: new Date().toISOString() });
		}
		return json({ ok });
	}

	// Handle human input
	if (body.action === 'human_input') {
		const { runId, phaseId, value } = body;
		if (!runId || !phaseId) return json({ error: 'Missing runId or phaseId' }, { status: 400 });
		if (!value) return json({ error: 'Missing value' }, { status: 400 });
		const ok = submitHumanInput(runId, phaseId, value);
		if (ok) {
			runEvents.get(runId)?.push({ phaseId, status: 'human_input', detail: value?.slice(0, 100), time: new Date().toISOString() });
		}
		return json({ ok });
	}

	// Handle providers list
	if (body.action === 'providers') {
		const available = await providerRegistry.detectAvailable();
		return json({ providers: available });
	}

	// Handle prerequisites check
	if (body.action === 'check_prereqs') {
		const { playbook: pbName } = body;
		if (!pbName) return json({ error: 'Missing playbook' }, { status: 400 });
		const playbookDir = resolve(PLAYBOOKS_DIR, pbName);
		try {
			const spec = await parsePlaybook(resolve(playbookDir, 'playbook.yaml'));
			if (!spec.prerequisites || spec.prerequisites.length === 0) {
				return json({ prerequisites: [], allMet: true });
			}
			const results = await checkPrerequisites(spec.prerequisites);
			const allMet = results.every(r => !r.required || r.available);
			return json({ prerequisites: results, allMet });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
		}
	}

	// ─── Start a new run (fire-and-forget, poll for status) ───

	const { playbook, inputs = {} } = body;
	if (!playbook) return json({ error: 'Missing playbook name' }, { status: 400 });

	const playbookDir = resolve(PLAYBOOKS_DIR, playbook);

	// Concurrency lock
	if (activePlaybooks.has(playbook)) {
		return json({ error: `"${playbook}" is already running. Wait for it to finish or kill it.` }, { status: 409 });
	}

	// Detect chain vs playbook
	const { access } = await import('node:fs/promises');
	const chainYaml = resolve(playbookDir, 'playbook-chain.yaml');
	let isChain = false;
	try { await access(chainYaml); isChain = true; } catch { /* not a chain */ }

	const runId = crypto.randomUUID().slice(0, 8);
	const events: { phaseId: string; role?: string; status: string; detail?: string; time: string }[] = [];
	runEvents.set(runId, events);
	const buffers = new Map<string, string[]>();
	outputBuffers.set(runId, buffers);

	if (isChain) {
		// ─── Chain run ───
		activePlaybooks.add(playbook);

		const promise = runPlaybookChain(
			playbookDir,
			inputs,
			(event) => {
				events.push({ phaseId: event.phaseId || '_chain', role: event.role, status: event.type, detail: event.data || event.error, time: event.timestamp });
			},
			(taskId, data) => {
				if (!buffers.has(taskId)) buffers.set(taskId, []);
				const buf = buffers.get(taskId)!;
				buf.push(data);
				if (buf.length > 200) buf.shift();
			},
		);

		promise.then((result) => {
			chainRuns.set(runId, result);
			activePlaybooks.delete(playbook);
			evictRun(runId);
		}).catch((err) => {
			chainRuns.set(runId, {
				runId,
				chainName: playbook,
				type: 'playbook-chain',
				status: 'failed',
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				nodes: [],
				resolvedInputs: inputs,
			});
			events.push({ phaseId: '_chain', status: 'failed', detail: (err as Error).message, time: new Date().toISOString() });
			activePlaybooks.delete(playbook);
			evictRun(runId);
		});

		return json({ runId, status: 'started', type: 'chain' });
	}

	// ─── Playbook run ───
	let spec;
	try {
		spec = await parsePlaybook(resolve(playbookDir, 'playbook.yaml'));
		const validation = validatePlaybookRun(spec, inputs);
		if (!validation.ok) {
			return json({ error: validation.errors.join('; ') }, { status: 400 });
		}
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Failed to parse playbook' }, { status: 400 });
	}

	activePlaybooks.add(playbook);

	// Create live run state for polling
	const liveRun: PlaybookRun = {
		runId,
		playbookName: playbook,
		playbookDir,
		status: 'running',
		startedAt: new Date().toISOString(),
		phases: spec.phases.map(p => ({
			id: p.id,
			type: p.type,
			status: 'pending' as const,
			assignments: p.assignments.map(a => ({
				role: a.role,
				provider: 'claude',
				status: 'pending' as const,
			})),
		})),
		resolvedInputs: inputs,
		contextDir: '',
		outputDir: '',
	};
	playbookRuns.set(runId, liveRun);

	const promise = runPlaybook(
		playbookDir,
		inputs,
		// Event callback — update live state + event log
		(event) => {
			events.push({ phaseId: event.phaseId || '_playbook', role: event.role, status: event.type, detail: event.data || event.error, time: event.timestamp });

			// Update live run state from engine's internal state
			const engineRun = getPlaybookRun(runId);
			if (engineRun) {
				liveRun.status = engineRun.status;
				liveRun.phases = engineRun.phases;
				liveRun.contextDir = engineRun.contextDir;
				liveRun.outputDir = engineRun.outputDir;
				liveRun.completedAt = engineRun.completedAt;
			}
		},
		// Output callback — buffer terminal output (ring buffer, 200 lines per task)
		(taskId, data) => {
			if (!buffers.has(taskId)) buffers.set(taskId, []);
			const buf = buffers.get(taskId)!;
			buf.push(data);
			if (buf.length > 200) buf.shift();
		},
		// Pass our runId so engine uses the same ID for polling
		runId,
	);

	promise.then((result) => {
		// Final state sync
		liveRun.status = result.status;
		liveRun.phases = result.phases;
		liveRun.completedAt = result.completedAt;
		liveRun.contextDir = result.contextDir;
		liveRun.outputDir = result.outputDir;
		activePlaybooks.delete(playbook);
		evictRun(runId);
	}).catch((err) => {
		liveRun.status = 'failed';
		liveRun.completedAt = new Date().toISOString();
		events.push({ phaseId: '_playbook', status: 'failed', detail: (err as Error).message, time: new Date().toISOString() });
		activePlaybooks.delete(playbook);
		evictRun(runId);
	});

	return json({ runId, status: 'started', type: 'playbook' });
};

// ─── GET: poll for status ───

/** GET /api/playbooks/run?id=... — poll run status */
export const GET: RequestHandler = async ({ url }) => {
	const runId = url.searchParams.get('id');

	if (!runId) {
		return json({ error: 'Missing id parameter' }, { status: 400 });
	}

	const run = playbookRuns.get(runId);
	const chain = chainRuns.get(runId);
	const events = runEvents.get(runId) || [];
	const buffers = outputBuffers.get(runId);

	// Build output map (last 50 chunks per task)
	const taskOutput: Record<string, string> = {};
	if (buffers) {
		for (const [taskId, lines] of buffers) {
			taskOutput[taskId] = lines.slice(-50).join('');
		}
	}

	// When completed, read output files so UI can display reports
	let outputFiles: Record<string, string> | undefined;
	const completedRun = run || chain;
	if (completedRun && (completedRun.status === 'completed' || completedRun.status === 'failed')) {
		outputFiles = await readOutputFiles(completedRun);
	}

	// Serve mid-run phase outputs (for human review / gate review)
	const phaseId = url.searchParams.get('phase');
	let phaseFiles: Record<string, string> | undefined;
	if (phaseId && run?.outputDir) {
		const phaseDir = join(run.outputDir, phaseId);
		phaseFiles = await readPhaseFiles(phaseDir);
	}

	if (chain) {
		return json({ ...chain, events, taskOutput, outputFiles, phaseFiles });
	}

	if (run) {
		return json({ ...run, events, taskOutput, outputFiles, phaseFiles });
	}

	if (events.length > 0) {
		return json({ runId, status: 'running', events, taskOutput });
	}

	return json({ error: 'Run not found' }, { status: 404 });
};

// ─── Helpers ───

/** Read all .md output files from a completed run's output dir */
async function readOutputFiles(run: PlaybookRun | PlaybookChainRun): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const outputDir = 'outputDir' in run ? run.outputDir : '';
	if (!outputDir) return files;

	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');

	// Recursively find all .md files in the output dir
	async function scanDir(dir: string, prefix: string) {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					await scanDir(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
				} else if (entry.name.endsWith('.md')) {
					const key = prefix ? `${prefix}/${entry.name}` : entry.name;
					try {
						files[key] = await readFile(join(dir, entry.name), 'utf-8');
					} catch { /* skip unreadable */ }
				}
			}
		} catch { /* dir doesn't exist */ }
	}

	await scanDir(outputDir, '');
	return files;
}

async function readPhaseFiles(phaseDir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const { readdir, readFile } = await import('node:fs/promises');
	try {
		const entries = await readdir(phaseDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.md')) {
				try {
					files[entry.name] = await readFile(join(phaseDir, entry.name), 'utf-8');
				} catch { /* skip */ }
			}
		}
	} catch { /* dir doesn't exist yet */ }
	return files;
}

async function checkPrerequisites(
	prereqs: PlaybookPrerequisite[],
): Promise<Array<{ name: string; available: boolean; required: boolean }>> {
	return Promise.all(
		prereqs.map(async (p) => {
			let available = false;
			try {
				await execAsync(p.check, { timeout: 5000 });
				available = true;
			} catch {
				available = false;
			}
			return { name: p.name, available, required: p.required !== false };
		}),
	);
}
