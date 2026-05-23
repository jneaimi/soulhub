/**
 * SKILL.md → system-prompt injection helper.
 *
 * Lane B (`ai-sdk`) agents reference skills by id; the dispatcher reads each
 * SKILL.md body and concatenates it after the system prompt so the model
 * receives the same triggers + workflow guidance Claude Code's auto-loader
 * would surface in Lane A.
 *
 * Hard-cap each skill body at 8 KB to keep prompt size bounded — large
 * SKILL.md files spill detail into `references/*` per Anthropic's spec.
 * If a referenced skill is missing we emit a one-line marker rather than
 * failing dispatch (the agent may have been authored with a broader skill
 * roster than is currently installed).
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import matter from 'gray-matter';

import { skillsDir } from './store.js';

const PER_SKILL_BYTE_BUDGET = 8 * 1024;

export interface SkillBody {
	id: string;
	name: string;
	description: string;
	body: string;
	missing?: boolean;
	truncated?: boolean;
}

export function readSkillBody(id: string): SkillBody {
	const file = resolve(skillsDir(), id, 'SKILL.md');
	if (!existsSync(file)) {
		return {
			id,
			name: id,
			description: '',
			body: '',
			missing: true,
		};
	}
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch {
		return { id, name: id, description: '', body: '', missing: true };
	}
	const parsed = matter(raw);
	const fm = parsed.data as { name?: string; description?: string };
	const body = parsed.content ?? '';
	const truncated = Buffer.byteLength(body, 'utf8') > PER_SKILL_BYTE_BUDGET;
	return {
		id,
		name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : id,
		description: typeof fm.description === 'string' ? fm.description.trim() : '',
		body: truncated ? body.slice(0, PER_SKILL_BYTE_BUDGET) + '\n\n…[truncated]' : body,
		truncated,
	};
}
