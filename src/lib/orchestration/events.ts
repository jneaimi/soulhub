import { EventEmitter } from 'node:events';
import { readWorkerOutputTail } from './board.js';

// Per-run event emitters for SSE streaming
const runEmitters = new Map<string, EventEmitter>();

export function getRunEmitter(runId: string): EventEmitter {
	let emitter = runEmitters.get(runId);
	if (!emitter) {
		emitter = new EventEmitter();
		emitter.setMaxListeners(20);
		runEmitters.set(runId, emitter);
	}
	return emitter;
}

export function emitRunEvent(runId: string, event: string, data: unknown): void {
	const emitter = runEmitters.get(runId);
	if (emitter) {
		emitter.emit(event, data);
	}
}

export function cleanupRunEmitter(runId: string): void {
	const emitter = runEmitters.get(runId);
	if (emitter) {
		emitter.removeAllListeners();
		runEmitters.delete(runId);
	}
}

// In-memory output ring buffers per worker (last 200 lines)
const outputBuffers = new Map<string, Map<string, string[]>>();
const MAX_LINES = 200;

export function appendOutput(runId: string, taskId: string, data: string): void {
	let runBuf = outputBuffers.get(runId);
	if (!runBuf) {
		runBuf = new Map();
		outputBuffers.set(runId, runBuf);
	}
	let lines = runBuf.get(taskId);
	if (!lines) {
		lines = [];
		runBuf.set(taskId, lines);
	}

	const newLines = data.split('\n');
	for (const line of newLines) {
		lines.push(line);
		if (lines.length > MAX_LINES) lines.shift();
	}
}

export function getOutputTail(runId: string, taskId: string, count = 50): string[] {
	const runBuf = outputBuffers.get(runId);
	if (!runBuf) return [];
	const lines = runBuf.get(taskId);
	if (!lines) return [];
	return lines.slice(-count);
}

export function cleanupOutputBuffers(runId: string): void {
	outputBuffers.delete(runId);
}

/**
 * Initialize in-memory output buffers from disk logs for a run.
 * Called during recovery so the frontend sees recent output.
 */
export async function initBuffersFromDisk(runId: string, taskIds: string[]): Promise<void> {
	for (const taskId of taskIds) {
		const tail = await readWorkerOutputTail(runId, taskId, 8192);
		if (!tail) continue;

		let runBuf = outputBuffers.get(runId);
		if (!runBuf) {
			runBuf = new Map();
			outputBuffers.set(runId, runBuf);
		}

		const lines = tail.split('\n').slice(-MAX_LINES);
		runBuf.set(taskId, lines);
	}
}
