/**
 * Path helpers for Claude Code's JSONL storage layout.
 *
 * Canonical layout:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl                          ← parent session events
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl ← sub-agent events
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/tool-results/hook-<uuid>-stdout.txt ← attachment overflow
 *
 * Encoding: forward slashes become dashes, leading slash becomes leading dash.
 * Encoding is forward-only — `--` in a directory name is ambiguous between
 * a literal `-` in the path and adjacent path levels. To get the canonical
 * cwd of a session, read the `cwd` field on any event inside the JSONL.
 */

import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const HOME = homedir();
const CLAUDE_PROJECTS_ROOT = join(HOME, '.claude', 'projects');

/** Encode an absolute cwd into the directory-name form Claude Code uses. */
export function encodeCwd(cwd: string): string {
	return cwd.replace(/\//g, '-');
}

/** Root directory holding all per-cwd Claude project session folders. */
export function claudeProjectsRoot(): string {
	return CLAUDE_PROJECTS_ROOT;
}

/** Resolve sub-agent JSONL path given the parent session's JSONL path + agentId. */
export function resolveSubagentPath(parentJsonlPath: string, agentId: string): string {
	const dir = dirname(parentJsonlPath);
	const sessionId = basename(parentJsonlPath, '.jsonl');
	if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
		throw new Error(`Invalid agentId: ${agentId}`);
	}
	return join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Resolve attachment-overflow file path given parent JSONL + hook uuid. */
export function resolveOverflowPath(parentJsonlPath: string, hookUuid: string): string {
	const dir = dirname(parentJsonlPath);
	const sessionId = basename(parentJsonlPath, '.jsonl');
	if (!/^[a-zA-Z0-9_-]+$/.test(hookUuid)) {
		throw new Error(`Invalid hookUuid: ${hookUuid}`);
	}
	return join(dir, sessionId, 'tool-results', `hook-${hookUuid}-stdout.txt`);
}
