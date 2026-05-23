/**
 * Skills registry — read side.
 *
 * Scans `~/.claude/skills/`, parses each `<name>/SKILL.md`, and returns
 * normalised summaries. Symlinks are surfaced (some users — Jasem included —
 * symlink shared skill folders into `~/.claude/skills/`). Uninstall must
 * never delete the symlink target; that's enforced in `uninstaller.ts`.
 *
 * Lazy-read: we only crack open the body when the UI asks for detail
 * (`getSkill`), keeping list endpoints fast even with 100+ skills.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
	readdirSync,
	readFileSync,
	statSync,
	lstatSync,
	readlinkSync,
	existsSync,
} from 'node:fs';
import matter from 'gray-matter';

import type { SkillSummary, SkillDetail } from './types.js';

const BODY_PREVIEW_BYTES = 8 * 1024;

/** Resolved skills directory. Override via env for tests. */
export function skillsDir(): string {
	const override = process.env.SOUL_HUB_SKILLS_DIR;
	if (override) return resolve(override);
	return resolve(homedir(), '.claude', 'skills');
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
}

function summariseEntry(parentDir: string, entryName: string): SkillSummary | null {
	const skillDir = resolve(parentDir, entryName);
	const skillFile = resolve(skillDir, 'SKILL.md');

	let isSymlink = false;
	let symlinkTarget: string | undefined;
	try {
		const lstat = lstatSync(skillDir);
		isSymlink = lstat.isSymbolicLink();
		if (isSymlink) {
			try {
				symlinkTarget = readlinkSync(skillDir);
			} catch {
				// Best-effort — leave undefined.
			}
		}
		if (!lstat.isDirectory() && !isSymlink) return null;
	} catch {
		return null;
	}

	if (!existsSync(skillFile)) {
		// Directory but no SKILL.md — skip silently. Common for `agents/` shared
		// folders or stray notes; not all subdirectories of ~/.claude/skills/
		// are actual skills.
		return null;
	}

	let raw: string;
	let modifiedAt = 0;
	try {
		const stat = statSync(skillFile);
		modifiedAt = stat.mtimeMs;
		raw = readFileSync(skillFile, 'utf8');
	} catch {
		return null;
	}

	let parsed: ReturnType<typeof matter>;
	let parseError: string | undefined;
	try {
		parsed = matter(raw);
	} catch (err) {
		parseError = (err as Error).message;
		parsed = { data: {}, content: raw, orig: raw, language: '', matter: '', stringify: () => raw };
	}

	const fm = parsed.data as SkillFrontmatter;
	const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : entryName;
	const description =
		typeof fm.description === 'string' ? fm.description.trim().replace(/\s+/g, ' ') : '';
	const bodyLines = parsed.content
		? parsed.content.split('\n').filter((l) => l.length > 0).length
		: 0;

	return {
		id: entryName,
		name,
		description,
		body_lines: bodyLines,
		has_scripts: existsSync(resolve(skillDir, 'scripts')),
		has_references: existsSync(resolve(skillDir, 'references')),
		is_symlink: isSymlink,
		symlink_target: symlinkTarget,
		source_path: skillFile,
		modified_at: modifiedAt,
		parse_error: parseError,
	};
}

/** List every parseable skill under `~/.claude/skills/`. Sorted by id ASC. */
export function listSkills(): SkillSummary[] {
	const dir = skillsDir();
	if (!existsSync(dir)) return [];

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const out: SkillSummary[] = [];
	for (const entry of entries) {
		if (entry.startsWith('.')) continue; // skip .DS_Store, dotfolders
		const summary = summariseEntry(dir, entry);
		if (summary) out.push(summary);
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

/** Read full detail (body + frontmatter) for one skill. Returns null when missing. */
export function getSkill(id: string): SkillDetail | null {
	const dir = skillsDir();
	const skillFile = resolve(dir, id, 'SKILL.md');
	if (!existsSync(skillFile)) return null;

	const summary = summariseEntry(dir, id);
	if (!summary) return null;

	let raw: string;
	try {
		raw = readFileSync(skillFile, 'utf8');
	} catch {
		return null;
	}

	const parsed = matter(raw);
	const body = parsed.content ?? '';
	const truncated = Buffer.byteLength(body, 'utf8') > BODY_PREVIEW_BYTES;
	const bodyPreview = truncated
		? body.slice(0, BODY_PREVIEW_BYTES) + '\n\n…[truncated]'
		: body;

	return {
		...summary,
		body_preview: bodyPreview,
		body_truncated: truncated,
		frontmatter: parsed.data ?? {},
	};
}

/** Returns true if a skill folder/symlink already exists under skillsDir(). */
export function skillExists(id: string): boolean {
	const dir = skillsDir();
	try {
		lstatSync(resolve(dir, id));
		return true;
	} catch {
		return false;
	}
}
