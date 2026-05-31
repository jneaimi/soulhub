/**
 * POST /api/vault/projects/[slug]/scaffold-repo
 *
 * ADR-025 D3 — New-app scaffold + project repo binding.
 *
 * Two modes (driven by the request body):
 *
 *   1. scaffold (default, no `customPath`): create ~/dev/<slug> with `git init`
 *      if it does not already exist as a non-empty git repo, then bind it to
 *      the project's index.md as `repo: ~/dev/<slug>`.
 *
 *   2. bind (with `customPath`): skip directory creation; only update the
 *      project's index.md `repo:` field to the supplied path. Use this when
 *      the repo already exists elsewhere on disk.
 *
 * Both modes refuse if the project already has a `repo:` binding — the
 * operator must clear it first (prevents silent overwrites).
 *
 * Failure modes (from the ADR):
 *   - Scaffold clobbers an existing dir → pre-create existence check.
 *     Returns 409 if ~/dev/<slug> already exists and is non-empty.
 *   - Project already bound → 409 so the operator sees it explicitly.
 *   - Vault engine or project index missing → 503 / 404.
 *
 * Returns: { success: true, repo: string, scaffolded: boolean }
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';

/** Expand a leading `~` to the real home directory. */
function expandTilde(p: string): string {
	if (p.startsWith('~/') || p === '~') return p.replace('~', homedir());
	return p;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const { slug } = params;
	if (!slug || !/^[\w-]+$/.test(slug)) {
		return json({ success: false, error: 'Invalid project slug' }, { status: 400 });
	}

	const engine = getVaultEngine();
	if (!engine) return json({ success: false, error: 'Vault not initialized' }, { status: 503 });

	// ── Parse optional body ───────────────────────────────────────────────────

	let customPath: string | undefined;
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		if (typeof body.customPath === 'string' && body.customPath.trim()) {
			customPath = body.customPath.trim();
		}
	} catch {
		// body not required — scaffold mode proceeds with default path
	}

	// ── Resolve the project index ─────────────────────────────────────────────

	const indexPath = `projects/${slug}/index.md`;
	const indexNote = engine.getNote(indexPath);
	if (!indexNote) {
		return json(
			{ success: false, error: `Project index not found: ${indexPath}` },
			{ status: 404 },
		);
	}

	// Refuse if already bound (prevents silent overwrites).
	const existingRepo = indexNote.meta['repo'];
	if (typeof existingRepo === 'string' && existingRepo.trim()) {
		return json(
			{
				success: false,
				error: `Project '${slug}' already has a repo binding: '${existingRepo}'. Clear it first if you want to re-bind.`,
			},
			{ status: 409 },
		);
	}

	// ── Mode A: scaffold — create ~/dev/<slug> + git init ────────────────────

	let scaffolded = false;
	const repoPath = customPath ?? `~/dev/${slug}`;
	const absRepoPath = expandTilde(repoPath);

	if (!customPath) {
		// ADR-025 D3 failure mode: refuse if ~/dev/<slug> already exists and is
		// non-empty (would clobber operator's work). An EMPTY dir is fine (git init
		// populates it idempotently).
		if (existsSync(absRepoPath)) {
			let entries: string[] = [];
			try {
				entries = readdirSync(absRepoPath).filter(
					(e) => e !== '.' && e !== '..' && e !== '.git',
				);
			} catch {
				// stat failure — refuse to be safe
				entries = ['?'];
			}
			if (entries.length > 0) {
				return json(
					{
						success: false,
						error: `Directory '${repoPath}' already exists and is non-empty. Use 'customPath' to bind an existing repo, or remove the directory first.`,
					},
					{ status: 409 },
				);
			}
			// Empty dir: fall through and let git init run
		}

		try {
			// Create dir + git init (idempotent if already a git repo).
			execSync(`mkdir -p ${JSON.stringify(absRepoPath)}`, { stdio: 'ignore' });
			execSync(`git -C ${JSON.stringify(absRepoPath)} init`, { stdio: 'ignore' });
			scaffolded = true;
		} catch (err) {
			return json(
				{
					success: false,
					error: `Failed to scaffold repo at '${repoPath}': ${(err as Error).message}`,
				},
				{ status: 500 },
			);
		}
	} else {
		// Mode B: bind an existing path — just validate it exists.
		if (!existsSync(absRepoPath)) {
			return json(
				{
					success: false,
					error: `Custom path '${repoPath}' does not exist on disk. Create the repo first or use the scaffold mode (omit customPath).`,
				},
				{ status: 400 },
			);
		}
	}

	// ── Bind: update the project index.md `repo:` field ─────────────────────

	try {
		const updatedMeta = { ...indexNote.meta, repo: repoPath };
		const updateRes = await fetch(
			`http://localhost:${process.env.PORT ?? 2400}/api/vault/notes/${indexPath}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ meta: updatedMeta }),
			},
		);
		const updateData = (await updateRes.json()) as { success?: boolean; error?: string };
		if (!updateRes.ok || updateData.success === false) {
			return json(
				{
					success: false,
					error: `Scaffolded repo but failed to bind it to the project: ${updateData.error ?? updateRes.status}`,
				},
				{ status: 500 },
			);
		}
	} catch (err) {
		return json(
			{
				success: false,
				error: `Scaffolded repo but failed to bind it: ${(err as Error).message}`,
			},
			{ status: 500 },
		);
	}

	return json({ success: true, repo: repoPath, scaffolded });
};
