import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import type { VaultTemplate } from './types.js';

export class TemplateLoader {
	private templates = new Map<string, VaultTemplate>();
	private dir = '';

	async load(templateDir: string): Promise<void> {
		this.dir = templateDir;
		this.templates.clear();
		let entries;
		try {
			entries = await readdir(templateDir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.endsWith('.md')) continue;
			const name = entry.replace(/\.md$/i, '');
			const raw = await readFile(join(templateDir, entry), 'utf-8');
			const { data, content } = matter(raw);

			const requiredFields = Object.keys(data).filter((k) => {
				const v = data[k];
				return v === '' || v === null || (typeof v === 'string' && v.startsWith('{{'));
			});

			const expectedSections: string[] = [];
			const sectionRe = /^##\s+(.+)$/gm;
			let match: RegExpExecArray | null;
			while ((match = sectionRe.exec(content)) !== null) {
				expectedSections.push(match[1].trim());
			}

			this.templates.set(name, {
				name,
				raw,
				requiredFields,
				expectedSections
			});
		}
	}

	list(): VaultTemplate[] {
		return Array.from(this.templates.values());
	}

	validate(type: string, content: string, required = false): { valid: boolean; missing: string[] } {
		const template = this.templates.get(type);
		if (!template) {
			return required
				? { valid: false, missing: [`Template "${type}" not found`] }
				: { valid: true, missing: [] };
		}

		const missing = template.expectedSections.filter((section) => {
			const re = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'im');
			return !re.test(content);
		});

		return { valid: missing.length === 0, missing };
	}

	async save(name: string, raw: string): Promise<VaultTemplate> {
		if (!this.dir) throw new Error('Templates not loaded');
		await mkdir(this.dir, { recursive: true });

		const filePath = join(this.dir, `${name}.md`);
		await writeFile(filePath, raw, 'utf-8');

		// Re-parse and cache
		const { data, content } = matter(raw);
		const requiredFields = Object.keys(data).filter((k) => {
			const v = data[k];
			return v === '' || v === null || (typeof v === 'string' && v.startsWith('{{'));
		});
		const expectedSections: string[] = [];
		const sectionRe = /^##\s+(.+)$/gm;
		let match: RegExpExecArray | null;
		while ((match = sectionRe.exec(content)) !== null) {
			expectedSections.push(match[1].trim());
		}
		const template: VaultTemplate = { name, raw, requiredFields, expectedSections };
		this.templates.set(name, template);
		return template;
	}

	async remove(name: string): Promise<boolean> {
		if (!this.dir) throw new Error('Templates not loaded');
		const filePath = join(this.dir, `${name}.md`);
		try {
			await unlink(filePath);
			this.templates.delete(name);
			return true;
		} catch {
			return false;
		}
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
