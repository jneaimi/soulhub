/**
 * Skill overlay storage — read/write `~/.soul-hub/data/skills/<name>.yaml`.
 *
 * The overlay is the "chat-invokable" gate per ADR-009 §7. We never write
 * to `~/.claude/skills/<name>/SKILL.md` because many of those entries are
 * symlinks into plugin directories (would clobber on plugin update).
 *
 * Atomic writes use the tmp-file + rename pattern shared with `agents/store.ts`
 * so partial writes can't leave the registry in a half-committed state.
 */

import { resolve } from 'node:path';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { soulHubDataDir } from '$lib/paths.js';
import type { SkillOverlay } from './types.js';

/** `~/.soul-hub/data/skills/` — the writable overlay directory. */
export function overlayDir(): string {
	return soulHubDataDir('skills');
}

function overlayPath(name: string): string {
	return resolve(overlayDir(), `${name}.yaml`);
}

/** Read the overlay for a single skill. Returns undefined when the file
 *  doesn't exist or fails to parse — failure is non-fatal because the
 *  registry's job is to skip broken entries rather than hard-error. */
export function readOverlay(name: string): SkillOverlay | undefined {
	const path = overlayPath(name);
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, 'utf8');
		const parsed = parseYaml(raw) as SkillOverlay;
		if (!parsed || typeof parsed !== 'object') return undefined;
		// Light shape coercion — full Zod validation belongs in a Phase 4c API
		// route. Here we just guard against obvious garbage so the registry
		// can ignore malformed overlays.
		if (typeof parsed.name !== 'string' || parsed.name !== name) return undefined;
		if (typeof parsed.chat_invokable !== 'boolean') return undefined;
		if (!parsed.invocation || typeof parsed.invocation.kind !== 'string') return undefined;
		return parsed;
	} catch (err) {
		console.warn(`[skills/overlay] failed to read ${path}: ${(err as Error).message}`);
		return undefined;
	}
}

/** List the names of all overlay files in the dir. */
export function listOverlayNames(): string[] {
	const dir = overlayDir();
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
			.map((f) => f.replace(/\.yaml$/, ''))
			.sort();
	} catch {
		return [];
	}
}

/** Atomic write — tmp file + rename. Creates the dir on first call. */
export function writeOverlay(overlay: SkillOverlay): void {
	const dir = overlayDir();
	mkdirSync(dir, { recursive: true });
	const final = overlayPath(overlay.name);
	const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
	const yaml = stringifyYaml(overlay, { indent: 2 });
	writeFileSync(tmp, yaml, 'utf8');
	renameSync(tmp, final);
}

/** Remove an overlay (un-publish from chat). Idempotent. */
export function deleteOverlay(name: string): void {
	const path = overlayPath(name);
	if (existsSync(path)) {
		unlinkSync(path);
	}
}
