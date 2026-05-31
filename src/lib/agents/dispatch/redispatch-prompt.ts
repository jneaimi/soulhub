/**
 * ADR-020 P2 — Native re-dispatch with auto-generated continuation prompt.
 *
 * Tonight's run #514/#515 history: an ADR took three dispatches to land. Each
 * subsequent dispatch had to be told via prose what the prior dispatch
 * committed ("75% done at commit b9077ec, only do the missing 25%"). The
 * system has the data — `agent_runs.claude_session_id` + `repo` + the
 * shared per-ADR worktree (ADR-022) — but no helper formatted it.
 *
 * `buildRedispatchPrompt` consumes:
 *   - the prior run's `AgentRunRow` (status, cost, turns, finishedAt, branch)
 *   - the worktree path + repo
 *   - a `runGit` runner (injectable for tests; production wraps `git -C`)
 * and returns a structured Markdown body the dispatcher feeds to the agent.
 *
 * Composes with ADR-022: the shared worktree means re-dispatch DOESN'T need
 * `resumeBranch` — calling dispatchAgent with the same `subjectPath` reuses
 * the per-ADR worktree automatically. P2's contribution is the PROMPT
 * (context primer) — the worktree work was done by P1 + ADR-022.
 */

import type { AgentRunRow } from '../runs.js';

/** Injectable git runner. Production: `execFile('git', ['-C', cwd, ...args])`.
 *  Tests: a deterministic stub that returns canned output. Throws on git
 *  failure; the endpoint catches and falls back to a degraded prompt. */
export interface GitRunner {
	(args: string[]): Promise<string>;
}

export interface RedispatchPromptInput {
	prior: AgentRunRow;
	/** Absolute worktree path the new dispatch will operate in (per ADR-022's
	 *  `<repo>/.worktrees/<adr-key>`). */
	worktreePath: string;
	/** Branch name the worktree is on (per ADR-022's `claude-soul/<adr-key>`). */
	branch: string;
	/** What the operator wrote in the "what's left to do" box. Optional —
	 *  empty when the operator wants the agent to read the diff and decide. */
	operatorContext?: string;
}

/** Format USD with cents; null/undefined → '—'. */
function fmtUsd(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	return `$${n.toFixed(2)}`;
}

/** Format an epoch-ms timestamp as YYYY-MM-DD HH:MM (UTC); null → '—'. */
function fmtTs(ms: number | null | undefined): string {
	if (!ms) return '—';
	const d = new Date(ms);
	return (
		d.getUTCFullYear() +
		'-' +
		String(d.getUTCMonth() + 1).padStart(2, '0') +
		'-' +
		String(d.getUTCDate()).padStart(2, '0') +
		' ' +
		String(d.getUTCHours()).padStart(2, '0') +
		':' +
		String(d.getUTCMinutes()).padStart(2, '0') +
		'Z'
	);
}

/**
 * Build the continuation prompt body. Async because we shell out to git
 * for HEAD info + diff stat against `main`. Falls back to a degraded
 * (still-useful) prompt when git fails (e.g. worktree gone, no commits yet).
 */
export async function buildRedispatchPrompt(
	input: RedispatchPromptInput,
	runGit: GitRunner,
): Promise<string> {
	const { prior, worktreePath, branch, operatorContext } = input;

	// Best-effort git introspection. Failures degrade gracefully — we still
	// return a useful prompt with the run metadata.
	let lastCommit = '—';
	let lastSubject = '—';
	let diffStat = '(diff unavailable — git introspection failed)';

	try {
		// %H = full SHA; %s = subject. Single line, abort on missing HEAD.
		const headLine = (await runGit(['log', '-1', '--format=%H %s'])).trim();
		if (headLine) {
			const sp = headLine.indexOf(' ');
			lastCommit = sp > 0 ? headLine.slice(0, sp) : headLine;
			lastSubject = sp > 0 ? headLine.slice(sp + 1) : '—';
		}
	} catch {
		/* leave defaults */
	}

	try {
		// Diff against `main` (the worktree was branched off main per ADR-022).
		// `--stat=200,80` widens the file-name column so paths aren't truncated.
		const stat = (await runGit(['diff', 'main..HEAD', '--stat=200,80'])).trim();
		if (stat) diffStat = stat;
	} catch {
		/* leave default */
	}

	const lines: string[] = [];
	lines.push(`## Continuation context (auto-generated from prior run \`${prior.runId}\`)`);
	lines.push('');
	lines.push(`- **Previous run**: status \`${prior.status}\`, cost ${fmtUsd(prior.costUsd)}, turns ${prior.numTurns}, finished ${fmtTs(prior.finishedAt)}`);
	lines.push(`- **Phase**: \`${prior.phase ?? 'initial'}\``);
	lines.push(`- **Branch**: \`${branch}\``);
	lines.push(`- **Worktree**: \`${worktreePath}\``);
	lines.push(`- **Last commit**: \`${lastCommit.slice(0, 12)}\` — ${lastSubject}`);
	lines.push('');
	lines.push('### Files modified so far (diff against `main`)');
	lines.push('');
	lines.push('```');
	lines.push(diffStat);
	lines.push('```');
	lines.push('');
	lines.push('**READ the diff above first**; understand what\'s already been done. The worktree is at HEAD of the prior dispatch\'s feature branch (per ADR-022 — one worktree per ADR, shared across dispatches). Do NOT redo work that\'s already committed.');
	lines.push('');
	lines.push('### What\'s left to do');
	lines.push('');
	if (operatorContext && operatorContext.trim()) {
		lines.push(operatorContext.trim());
	} else {
		lines.push('_(operator left this blank — read the parent ADR\'s acceptance criteria and complete whatever the diff shows is missing)_');
	}
	lines.push('');

	return lines.join('\n');
}
