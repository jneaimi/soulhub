/**
 * Skills installer — write side.
 *
 * v1 install methods:
 *   - GitHub URL (or `owner/repo`) + optional subpath + optional ref
 *   - Anthropic registry (`anthropics/skills`) — same path, just pre-filled
 *   - Curated list quick-installs — pre-fill `repo` + `subpath`, same path
 *
 * Pipeline:
 *   1. Parse repo into `https://github.com/<owner>/<repo>.git` URL
 *   2. `git clone --depth 1 [--branch <ref>] <url> <tmp>` — bounded by `git`
 *      already on PATH; we don't re-implement the protocol.
 *   3. Resolve source dir = `<tmp>/<subpath ?? ''>`
 *   4. Validate `SKILL.md` exists + frontmatter passes name/description rules
 *   5. Atomic move into `<skillsDir>/<id>/` via `rename(2)` when on the same
 *      device, falling back to recursive copy + cleanup otherwise. Refuse to
 *      overwrite existing folders / symlinks.
 *
 * Uninstall:
 *   - Symlinks: only `unlink(2)` the symlink itself — never the target. This
 *     matches Jasem's setup where some skills under `~/.claude/skills/` are
 *     symlinks into shared `~/.agents/skills/` or project repos.
 *   - Regular dirs: `rm -rf` the directory.
 */

import { resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	renameSync,
	cpSync,
	lstatSync,
	unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';

import { skillsDir, skillExists } from './store.js';
import type { InstallRequest, InstallResult } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GIT_TIMEOUT_MS = 60_000;

interface ParsedRepo {
	owner: string;
	repo: string;
	cloneUrl: string;
}

/** Accept either `owner/repo` or a full https/ssh URL. Normalises to https. */
export function parseRepo(input: string): ParsedRepo {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('repo is required');

	// owner/repo shorthand
	const short = /^([^/\s]+)\/([^/\s]+?)(\.git)?$/.exec(trimmed);
	if (short && !trimmed.includes('://')) {
		return {
			owner: short[1],
			repo: short[2],
			cloneUrl: `https://github.com/${short[1]}/${short[2]}.git`,
		};
	}

	// https://github.com/<owner>/<repo>(.git)?
	const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?(\/.*)?$/i.exec(trimmed);
	if (httpsMatch) {
		return {
			owner: httpsMatch[1],
			repo: httpsMatch[2],
			cloneUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git`,
		};
	}

	// git@github.com:<owner>/<repo>(.git)?
	const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/.exec(trimmed);
	if (sshMatch) {
		return {
			owner: sshMatch[1],
			repo: sshMatch[2],
			cloneUrl: `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git`,
		};
	}

	throw new Error(`Unrecognised repo format: ${trimmed} (expected "owner/repo" or GitHub URL)`);
}

function deriveId(req: InstallRequest, parsed: ParsedRepo): string {
	const candidate = req.name?.trim() || (req.subpath ? basename(req.subpath) : parsed.repo);
	if (!candidate) throw new Error('Could not derive skill id — pass `name` explicitly');
	const normalised = candidate.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!NAME_RE.test(normalised)) {
		throw new Error(
			`Derived id "${normalised}" is invalid (must be lowercase + hyphens, ≤64 chars)`,
		);
	}
	return normalised;
}

interface FrontmatterShape {
	name?: string;
	description?: string;
}

function validateSkillSource(sourceDir: string): { fm: FrontmatterShape; raw: string } {
	const skillFile = resolve(sourceDir, 'SKILL.md');
	if (!existsSync(skillFile)) {
		throw new Error('SKILL.md not found at source path');
	}
	const raw = readFileSync(skillFile, 'utf8');
	const parsed = matter(raw);
	const fm = parsed.data as FrontmatterShape;

	if (typeof fm.name !== 'string' || !fm.name.trim()) {
		throw new Error('SKILL.md frontmatter is missing required `name` field');
	}
	if (typeof fm.description !== 'string' || !fm.description.trim()) {
		throw new Error('SKILL.md frontmatter is missing required `description` field');
	}
	if (fm.name.length > 64) {
		throw new Error('SKILL.md `name` exceeds 64-character limit');
	}
	if (fm.description.length > 1024) {
		throw new Error('SKILL.md `description` exceeds 1024-character limit');
	}
	return { fm, raw };
}

function cloneRepo(parsed: ParsedRepo, ref: string | undefined, target: string): void {
	const args = ['clone', '--depth', '1', '--single-branch'];
	if (ref) args.push('--branch', ref);
	args.push(parsed.cloneUrl, target);

	const result = spawnSync('git', args, {
		timeout: GIT_TIMEOUT_MS,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	if (result.error) {
		throw new Error(`git clone failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = (result.stderr ?? '').trim().slice(0, 500);
		throw new Error(`git clone exited ${result.status}: ${stderr || 'unknown error'}`);
	}
}

function moveIntoPlace(sourceDir: string, destDir: string): void {
	try {
		renameSync(sourceDir, destDir);
		return;
	} catch (err) {
		// EXDEV → cross-device; fall through to copy+remove. Other errors propagate.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'EXDEV') throw err;
	}
	cpSync(sourceDir, destDir, { recursive: true, errorOnExist: true });
	rmSync(sourceDir, { recursive: true, force: true });
}

export function installSkill(req: InstallRequest): InstallResult {
	const parsed = parseRepo(req.repo);
	const id = deriveId(req, parsed);

	if (skillExists(id)) {
		throw new Error(`Skill "${id}" already exists. Uninstall it first.`);
	}

	const tmpRoot = mkdtempSync(resolve(tmpdir(), 'soul-hub-skill-'));
	const cloneDest = resolve(tmpRoot, 'clone');
	let installResult: InstallResult;
	try {
		cloneRepo(parsed, req.ref, cloneDest);

		const subpath = (req.subpath ?? '').replace(/^\/+|\/+$/g, '');
		const sourceDir = subpath ? resolve(cloneDest, subpath) : cloneDest;

		// Subpath traversal guard — sourceDir must stay inside cloneDest.
		if (!sourceDir.startsWith(cloneDest + '/') && sourceDir !== cloneDest) {
			throw new Error(`subpath "${subpath}" escapes the clone root`);
		}

		const { fm } = validateSkillSource(sourceDir);

		const destDir = resolve(skillsDir(), id);
		// Re-check after validation in case of TOCTOU.
		if (existsSync(destDir)) {
			throw new Error(`Skill "${id}" already exists. Uninstall it first.`);
		}

		moveIntoPlace(sourceDir, destDir);

		installResult = {
			id,
			source_path: resolve(destDir, 'SKILL.md'),
			frontmatter: fm as Record<string, unknown>,
		};
	} finally {
		// Clean up tmp scratch — moveIntoPlace already removed sourceDir on success.
		rmSync(tmpRoot, { recursive: true, force: true });
	}
	return installResult;
}

export function uninstallSkill(id: string): void {
	if (!NAME_RE.test(id)) {
		throw new Error(`Invalid skill id: ${id}`);
	}
	const target = resolve(skillsDir(), id);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(target);
	} catch {
		throw new Error(`Skill "${id}" is not installed.`);
	}

	if (stat.isSymbolicLink()) {
		// Symlink-safe uninstall — remove the link, never the target. The
		// link's resolved target may be a shared folder under ~/.agents/skills/
		// or a project checkout, and the user expects those to survive.
		unlinkSync(target);
		return;
	}
	if (!stat.isDirectory()) {
		throw new Error(`"${id}" is not a directory or symlink — refusing to remove.`);
	}
	rmSync(target, { recursive: true, force: true });
}
