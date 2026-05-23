/** Reads `operations/whatsapp/HEARTBEAT.md` and exposes:
 *
 *   - `body`     — markdown content with the `tasks:` block stripped;
 *                  appended to every heartbeat user prompt as context.
 *   - `tasks[]`  — array of `{ name, intervalMs, prompt }` parsed from the
 *                  YAML-ish `tasks:` block.
 *   - `isEmpty`  — body has no non-blank, non-heading content AND no tasks.
 *                  Empty checklist → heartbeat skips the run with no LLM call.
 *
 *  Cache is per-checklist-path; vault `reindexed` events invalidate it. */

import { getVaultEngine } from '../vault/index.js';
import { getVaultEvents, type VaultReindexEvent } from '../vault/events.js';

export interface HeartbeatTask {
	name: string;
	intervalMs: number;
	prompt: string;
}

export interface HeartbeatChecklist {
	body: string;
	tasks: HeartbeatTask[];
	isEmpty: boolean;
}

let cachedPath: string | null = null;
let cached: HeartbeatChecklist | null = null;
let listenerInstalled = false;

function installWatcherOnce(pathProvider: () => string): void {
	if (listenerInstalled) return;
	listenerInstalled = true;

	getVaultEvents().on('reindexed', (event: VaultReindexEvent) => {
		if (!event.path) {
			cached = null;
			return;
		}
		if (event.path === pathProvider()) {
			cached = null;
		}
	});
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;

/** Parse `30m`, `1h`, `2h`, `1500ms`, `2.5h` → milliseconds. Returns null
 *  for malformed input so the caller can skip the task with a warning. */
export function parseDurationMs(value: string): number | null {
	const match = value.trim().match(DURATION_RE);
	if (!match) return null;
	const n = Number(match[1]);
	if (!Number.isFinite(n) || n < 0) return null;
	const unit = (match[2] ?? 'm').toLowerCase();
	const factor =
		unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
	return Math.floor(n * factor);
}

/** Check whether a markdown body has any non-blank, non-heading lines. */
function bodyHasContent(body: string): boolean {
	for (const rawLine of body.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('#')) continue;
		if (line.startsWith('//')) continue;
		// Frontmatter delimiters — skip just in case.
		if (line === '---') continue;
		return true;
	}
	return false;
}

/** Parse the `tasks:` YAML-ish block from the body. Tolerant by design —
 *  the user edits this in Obsidian and we don't want a stray space to kill
 *  the heartbeat. Returns `{ remainingBody, tasks }` so the consumer can
 *  show the freeform body separately from the task list. */
export function parseChecklist(raw: string): { body: string; tasks: HeartbeatTask[] } {
	const lines = raw.split('\n');
	const tasks: HeartbeatTask[] = [];
	const bodyLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		// Match the start of a `tasks:` block. Must be the only token on the line
		// (case-sensitive — keeps `tasks: see other note` from triggering).
		if (line.trim() === 'tasks:') {
			i++;
			let current: Partial<HeartbeatTask> & { _interval?: string } = {};
			let blockEnded = false;
			while (i < lines.length) {
				const inner = lines[i];
				const stripped = inner.replace(/\t/g, '  ');
				// Two-space indent or hyphen at start = part of the block.
				if (stripped.match(/^\s*-\s+name\s*:/)) {
					// New entry — flush the previous one.
					if (current.name && current._interval && current.prompt) {
						const ms = parseDurationMs(current._interval);
						if (ms !== null && ms > 0) {
							tasks.push({ name: current.name, intervalMs: ms, prompt: current.prompt });
						}
					}
					current = {};
					const m = stripped.match(/name\s*:\s*(.+?)\s*$/);
					if (m) current.name = m[1].replace(/^["']|["']$/g, '').trim();
					i++;
					continue;
				}
				if (stripped.match(/^\s+interval\s*:/)) {
					const m = stripped.match(/interval\s*:\s*(.+?)\s*$/);
					if (m) current._interval = m[1].replace(/^["']|["']$/g, '').trim();
					i++;
					continue;
				}
				if (stripped.match(/^\s+prompt\s*:/)) {
					// Two shapes: inline (`prompt: "…"`) and block (`prompt: |` then indented lines).
					const inlineMatch = stripped.match(/prompt\s*:\s*\|\s*$/);
					if (inlineMatch) {
						i++;
						const promptLines: string[] = [];
						while (i < lines.length) {
							const promptLine = lines[i];
							// Block continues while indented or blank.
							if (promptLine.trim() === '' || promptLine.startsWith('  ') || promptLine.startsWith('\t')) {
								promptLines.push(promptLine.replace(/^(\s{2}|\t)/, ''));
								i++;
								continue;
							}
							break;
						}
						current.prompt = promptLines.join('\n').trim();
						continue;
					}
					const m = stripped.match(/prompt\s*:\s*(.+?)\s*$/);
					if (m) {
						current.prompt = m[1].replace(/^["']|["']$/g, '').trim();
						i++;
						continue;
					}
					i++;
					continue;
				}
				// Unrelated content — block has ended.
				blockEnded = true;
				break;
			}
			// Flush the trailing entry if the block ran to EOF or was followed
			// by non-block content. Both paths exit via the inner loop.
			if (current.name && current._interval && current.prompt) {
				const ms = parseDurationMs(current._interval);
				if (ms !== null && ms > 0) {
					tasks.push({ name: current.name, intervalMs: ms, prompt: current.prompt });
				}
			}
			if (!blockEnded) break;
			// Resume body collection from the line that ended the block.
			continue;
		}
		bodyLines.push(line);
		i++;
	}

	return { body: bodyLines.join('\n').trim(), tasks };
}

function readChecklistFromVault(checklistPath: string): HeartbeatChecklist {
	const engine = getVaultEngine();
	if (!engine) {
		return { body: '', tasks: [], isEmpty: true };
	}
	const note = engine.getNote(checklistPath);
	if (!note) {
		return { body: '', tasks: [], isEmpty: true };
	}
	const parsed = parseChecklist(note.content);
	const isEmpty = parsed.tasks.length === 0 && !bodyHasContent(parsed.body);
	return { body: parsed.body, tasks: parsed.tasks, isEmpty };
}

export function getHeartbeatChecklist(checklistPath: string): HeartbeatChecklist {
	installWatcherOnce(() => cachedPath ?? checklistPath);

	if (cachedPath !== checklistPath) {
		cachedPath = checklistPath;
		cached = null;
	}
	if (cached !== null) return cached;

	cached = readChecklistFromVault(checklistPath);
	return cached;
}

export function _resetChecklistCache(): void {
	cachedPath = null;
	cached = null;
}
