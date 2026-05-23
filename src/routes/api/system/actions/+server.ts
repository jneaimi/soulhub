import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSystemHealth } from '$lib/system/index.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { spawnSession } from '$lib/pty/manager.js';
import { runClaudeHeadless } from '$lib/pty/headless-claude.js';
import {
	healOrphans, healMissingRootIndex, healMissingFrontmatter, healBrokenLinks,
} from '$lib/system/healers/vault-healer.js';
import { config } from '$lib/config.js';

/**
 * POST /api/system/actions — execute a system action
 *
 * Actions:
 *   { action: "heal-orphans", zone?: string }
 *   { action: "heal-frontmatter" }
 *   { action: "heal-index" }
 *   { action: "run-claude", prompt: string, cwd?: string, notificationId?: string }
 *   { action: "force-check" }
 */
export const POST: RequestHandler = async ({ request }) => {
	const health = getSystemHealth();
	if (!health) {
		return json({ error: 'System health not initialized' }, { status: 503 });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const action = body.action as string;
	if (!action) {
		return json({ error: 'action is required' }, { status: 400 });
	}

	const vault = getVaultEngine();
	if (!vault && action !== 'force-check') {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	switch (action) {
		case 'heal-orphans': {
			const allNotes = vault!.getRecent(99999);
			let orphans = vault!.getOrphans();
			const zone = body.zone as string | undefined;
			if (zone) {
				orphans = orphans.filter((n) => n.path.startsWith(`${zone}/`));
			}
			const result = await healOrphans(config.resolved.vaultDir, orphans, allNotes);
			if (result.fixed.length > 0) {
				await vault!.reindex();
			}
			return json({ ok: true, result });
		}

		case 'heal-broken-links': {
			const allNotes = vault!.getRecent(99999);
			const unresolved = vault!.getUnresolved();
			const result = await healBrokenLinks(config.resolved.vaultDir, unresolved, allNotes);
			if (result.fixed.length > 0) {
				await vault!.reindex();
			}
			return json({ ok: true, result });
		}

		case 'heal-frontmatter': {
			const allNotes = vault!.getRecent(99999);
			const result = await healMissingFrontmatter(config.resolved.vaultDir, allNotes);
			if (result.fixed.length > 0) {
				await vault!.reindex();
			}
			return json({ ok: true, result });
		}

		case 'heal-index': {
			const allNotes = vault!.getRecent(99999);
			const result = await healMissingRootIndex(config.resolved.vaultDir, allNotes);
			if (result.fixed.length > 0) {
				await vault!.reindex();
			}
			return json({ ok: true, result });
		}

		case 'run-claude': {
			const prompt = body.prompt as string;
			if (!prompt) {
				return json({ error: 'prompt is required for run-claude' }, { status: 400 });
			}

			const cwd = (body.cwd as string)?.replace('~', process.env.HOME || '') || config.resolved.vaultDir;

			try {
				const session = spawnSession({
					prompt,
					cwd,
				});

				return json({
					ok: true,
					sessionId: session.id,
					message: `Claude session ${session.id} launched with prompt`,
				});
			} catch (err) {
				return json(
					{ error: `Failed to launch Claude session: ${err instanceof Error ? err.message : String(err)}` },
					{ status: 500 }
				);
			}
		}

		case 'run-claude-headless': {
			const prompt = body.prompt as string;
			if (!prompt) {
				return json({ error: 'prompt is required for run-claude-headless' }, { status: 400 });
			}
			const cwd = (body.cwd as string)?.replace('~', process.env.HOME || '') || config.resolved.vaultDir;
			const model = typeof body.model === 'string' ? body.model : undefined;
			const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
			const allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools as string[] : undefined;

			try {
				const result = await runClaudeHeadless({ prompt, cwd, model, timeoutMs, allowedTools });
				if (result.ok && vault) {
					await vault.reindex();
				}
				return json({ ok: result.ok, result });
			} catch (err) {
				return json(
					{ error: `Failed to run headless Claude: ${err instanceof Error ? err.message : String(err)}` },
					{ status: 500 }
				);
			}
		}

		case 'force-check': {
			const report = await health.forceCheck();
			return json({ ok: true, report });
		}

		default:
			return json({ error: `Unknown action: ${action}` }, { status: 400 });
	}
};
