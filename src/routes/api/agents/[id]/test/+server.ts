/**
 * POST /api/agents/[id]/test — chat-to-test runner.
 *
 * Streams NDJSON of `DispatchEvent`s. Each line is one JSON object terminated
 * by `\n`. The final event is `{ type: 'done', result: DispatchResult }`.
 *
 * Default `mode: 'test'` — applies hard caps per ADR-001 §6 (max $0.10, 5
 * turns, 60s) so a curious user can't burn through real spend by hammering
 * the chat panel.
 *
 * Pass `?mode=production` to dispatch against the agent's real budget —
 * routes through the same path as a chat-triggered dispatch and respects
 * `goal_condition` on PTY-backed agents (ADR-031). This replaced the
 * temporary `/api/debug/dispatch` endpoint — the operator UI now provides
 * the mode toggle visibly instead of forcing curl-with-a-token.
 */

import { error, type RequestHandler } from '@sveltejs/kit';
import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import type { DispatchMode } from '$lib/agents/dispatch/types.js';
import { abortsOnClientDisconnect } from '$lib/agents/dispatch/detach.js';
import { getAgent } from '$lib/agents/store.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { deriveWorkType } from '$lib/agents/dispatch/derive-work-type.js';
import { resolveProjectRepo } from '$lib/agents/dispatch/resolve-project-repo.js';
import { lintAdr } from '$lib/vault/adr-lint.js';

export const POST: RequestHandler = async ({ params, request, url }) => {
	const id = params.id;
	if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw error(400, 'invalid agent id');
	}

	const agent = getAgent(id);
	if (!agent) throw error(404, `agent '${id}' not found`);

	const body = (await request.json().catch(() => ({}))) as {
		task?: unknown;
		subject?: unknown;
		/** ADR-024 D2 — Claude session UUID to resume (same branch, summed cost). */
		resume?: unknown;
		/** ADR-024 D2 — existing branch to resume in; required when `resume` is set. */
		branch?: unknown;
		/** ADR-014 D2 / ADR-015 — artifact work_type, used as fallback only.
		 *  The server derives work_type from the subject note's frontmatter
		 *  (authoritative); this body field is the fallback when the note is
		 *  absent or carries no work_type. */
		work_type?: unknown;
	};
	const task = typeof body.task === 'string' ? body.task.trim() : '';
	if (!task) throw error(400, 'task is required (non-empty string)');
	if (task.length > 4000) throw error(400, 'task too long (max 4000 chars)');
	// projects-graph ADR-018 S2b — optional vault artifact this run works on.
	const subjectPath =
		typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : undefined;
	// ADR-024 D2 — resume params. When `resume` is present, `branch` must be too.
	const resumeSessionId =
		typeof body.resume === 'string' && body.resume.trim() ? body.resume.trim() : undefined;
	const resumeBranch =
		typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : undefined;
	if (resumeSessionId && !resumeBranch) {
		throw error(400, 'branch is required when resume is provided');
	}
	// ADR-015 — derive work_type server-side from the subject note (vault is
	// authoritative); fall back to body.work_type so callers that already send
	// it (UI, `soul` CLI) are fully supported and callers that omit it no longer
	// bypass the D2 guard.
	const bodyWorkType = typeof body.work_type === 'string' ? body.work_type.trim().toLowerCase() : '';
	const workTypeParam = deriveWorkType(
		subjectPath,
		bodyWorkType,
		(path) => getVaultEngine()?.getNote(path),
	);

	const modeParam = url.searchParams.get('mode');
	const mode: DispatchMode =
		modeParam === 'production' ? 'production' : 'test';

	// ADR-014 D2 + ADR-015 + ADR-030 — fail-closed server guard, aligned with the
	// dispatcher's effective-repo resolution.
	// Production coding dispatches MUST land in a worktree — either the agent's
	// static `repo:` (ADR-010) or the project's `repo:` frontmatter on its index
	// note (ADR-030). A run with neither has no worktree and no deliverable gate;
	// every safety layer would be bypassed at once. Refuse loudly.
	// Mirrors `effectiveRepo = projectRepo ?? agent.repo` in dispatch/index.ts:151
	// — the guard must match the dispatcher's resolution or it cuts off the
	// project-bound `implementer` carve-out (ADR-011 D2). Pre-2026-05-30 the
	// guard only inspected `agent.repo`, blocking every dispatch to the generic
	// `implementer` even when the project's index supplied a perfectly good repo.
	const projectRepo = resolveProjectRepo(subjectPath, (p) => getVaultEngine()?.getNote(p));
	const effectiveRepo = projectRepo ?? agent.repo;

	if (mode === 'production' && workTypeParam === 'coding' && !effectiveRepo) {
		throw error(
			422,
			`Refusing to dispatch coding work to '${id}': it has no repo binding (neither the ` +
				`agent's static \`repo:\` nor the project's index \`repo:\`), so the run would have ` +
				`no worktree isolation (ADR-010 + ADR-030). Set \`assignee\` to a repo-bound ` +
				`implementer, or add \`repo: ~/dev/<slug>\` to the project's index.md.`,
		);
	}

	// ADR-044 P2 — lint pre-flight on the subject ADR. The chokepoint at the
	// latest possible interception point — catches dispatches that came in via
	// the UI's "Continue with Pn" button or direct API calls that skipped the
	// CLI propose/accept gates. Production mode only; test runs are cheap
	// probes that shouldn't be blocked by lint.
	if (mode === 'production' && subjectPath) {
		const noteData = getVaultEngine()?.getNote(subjectPath);
		if (noteData) {
			const adrFindings = lintAdr({
				path: noteData.path,
				meta: (noteData.meta ?? {}) as Record<string, unknown>,
				content: noteData.content ?? '',
			});
			const high = adrFindings.filter((f) => f.severity === 'high');
			if (high.length > 0) {
				const hint = high.map((f) => `  ✗ [${f.rule}] ${f.message}`).join('\n');
				throw error(
					409,
					`Dispatch refused — ADR has ${high.length} high-severity lint finding${high.length === 1 ? '' : 's'}:\n` +
						hint +
						`\n\nRun \`soul adr lint ${subjectPath}\` and fix the findings, ` +
						`or have the operator pass a manual override via the CLI.`,
				);
			}
		}
	}

	const ac = new AbortController();
	// ADR-026 follow-up: production runs are detached — a client disconnect
	// (refresh/tab close) must NOT cancel the run. Only test-mode probes
	// abort on disconnect (cheap CI smokes are fine to cancel on drop).
	if (abortsOnClientDisconnect(mode)) request.signal.addEventListener('abort', () => ac.abort());

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (line: string) => {
				try {
					controller.enqueue(encoder.encode(line + '\n'));
				} catch {
					/* downstream closed */
				}
			};

			try {
				const gen = dispatchAgent(id, task, {
						mode,
						signal: ac.signal,
						subjectPath,
						// ADR-024 D2 — resume loop (optional; absent → fresh dispatch).
						resumeSessionId,
						resumeBranch,
					});
				while (true) {
					const next = await gen.next();
					if (next.done) {
						send(JSON.stringify({ type: 'done', result: next.value, ts: Date.now() }));
						break;
					}
					send(JSON.stringify(next.value));
				}
			} catch (err) {
				send(
					JSON.stringify({
						type: 'error',
						message: (err as Error).message ?? 'dispatch failed',
						ts: Date.now(),
					}),
				);
			} finally {
				controller.close();
			}
		},
		cancel() {
			if (abortsOnClientDisconnect(mode)) ac.abort();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Accel-Buffering': 'no',
		},
	});
};
