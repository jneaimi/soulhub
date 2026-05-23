import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigSchema, findMissingChannelBlocks, type SoulHubConfig } from './config.schema.js';
import { soulHubSettingsPath } from './paths.js';

const HOME = homedir();

export type { SoulHubConfig } from './config.schema.js';

/** Expand ~ to $HOME in path strings */
function expandPath(p: string): string {
	if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
	if (p === '~') return HOME;
	return resolve(p);
}

/** ADR-001 P3 read-shim — backfill the top-level `heartbeat` key from the legacy
 *  `channels.whatsapp.heartbeat` location when the new key is absent. Operates on
 *  raw JSON before validation so the move is unambiguous (an absent top-level key
 *  is distinguishable from a defaulted one). Maps the per-channel `target` into
 *  `delivery.{channel,target}` and drops the dead `isolatedSession` knob. Once
 *  settings.json is migrated (S2), the new key is present and this is a no-op;
 *  remove the shim a version later. */
function liftLegacyHeartbeat(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object') return raw;
	const obj = raw as Record<string, unknown>;
	if (obj.heartbeat !== undefined) return raw;
	const legacy = (obj.channels as Record<string, unknown> | undefined)?.whatsapp;
	const hb = (legacy as Record<string, unknown> | undefined)?.heartbeat;
	if (!hb || typeof hb !== 'object') return raw;
	const { target, isolatedSession: _drop, ...neutral } = hb as Record<string, unknown>;
	obj.heartbeat = {
		...neutral,
		delivery: { channel: 'whatsapp', ...(typeof target === 'string' ? { target } : {}) },
	};
	return obj;
}

function loadSettings(): SoulHubConfig {
	// Look for settings.json in: 1) explicit env override, 2) ~/.soul-hub/settings.json,
	// 3) legacy repo-root location (kept as a fallback during migration).
	const candidates = [
		process.env.SOUL_HUB_SETTINGS || '',
		soulHubSettingsPath(),
		resolve(process.cwd(), 'settings.json'),
	].filter(Boolean);

	let parsed: unknown = {};
	let source: string | null = null;
	for (const settingsPath of candidates) {
		try {
			parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
			source = settingsPath;
			break;
		} catch {
			continue;
		}
	}

	parsed = liftLegacyHeartbeat(parsed);
	const result = ConfigSchema.safeParse(parsed);
	if (!result.success) {
		console.error(`[config] settings.json validation failed (source: ${source ?? 'defaults'}):`);
		for (const issue of result.error.issues) {
			console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
		}
		console.error('[config] Falling back to defaults.');
		// `.parse` infers the raw record-typed `channels`; the exported
		// `SoulHubConfig` narrows `telegram`/`whatsapp` to their precise schemas.
		// The cast is sound because `.prefault` always materialises both entries.
		return ConfigSchema.parse({}) as SoulHubConfig;
	}
	const cfg = applyAdditiveSchemaDefaults(result.data as SoulHubConfig);
	// channel-config-precise-shape contract (runtime defense): warn — don't fail —
	// when the loose runtime config omits blocks the precise SoulHubConfig typing
	// assumes. Non-fatal because consumers guard; the falsifier turns this into a
	// hard signal. See findMissingChannelBlocks.
	const missing = findMissingChannelBlocks(cfg.channels as Record<string, unknown>);
	if (missing.telegram.length > 0) {
		console.warn(
			`[config] channel-config-precise-shape: settings.json (source: ${source ?? 'defaults'}) omits telegram blocks the typing assumes [${missing.telegram.join(', ')}] — operator Telegram alerts will silently no-op.`,
		);
	}
	return cfg;
}

/** Walks the parsed config and adds any schema-default keys to `Record`-
 *  style maps (`channels.whatsapp.intentMap`, `routes`) that the user's
 *  saved settings.json doesn't have yet. Lets future slices add new
 *  commands (like Slice 6's `/img` or a future `/video`) without forcing
 *  the user to hand-edit settings.json — Zod's object `.default(…)` only
 *  fires when the field is fully missing, not when the user has *some*
 *  keys saved.
 *
 *  Existing keys are never overwritten — if the user pointed `/save` at a
 *  custom route, that stays. We only **add** missing keys.
 *
 *  Pure: returns the same object back after mutation. The merged map is
 *  rebuilt from scratch so the runtime object isn't shared with the
 *  schema-default reference. */
function applyAdditiveSchemaDefaults(cfg: SoulHubConfig): SoulHubConfig {
	const defaults = ConfigSchema.parse({});

	const userIntentMap = cfg.channels.whatsapp.intentMap as Record<string, unknown>;
	const defaultIntentMap = defaults.channels.whatsapp.intentMap as Record<string, unknown>;
	const mergedIntentMap: Record<string, unknown> = { ...userIntentMap };
	for (const [token, mapping] of Object.entries(defaultIntentMap)) {
		if (!(token in mergedIntentMap)) {
			mergedIntentMap[token] = mapping;
		}
	}
	cfg.channels.whatsapp.intentMap = mergedIntentMap as typeof cfg.channels.whatsapp.intentMap;

	const userRoutes = cfg.routes as Record<string, unknown>;
	const defaultRoutes = defaults.routes as Record<string, unknown>;
	const mergedRoutes: Record<string, unknown> = { ...userRoutes };
	for (const [name, spec] of Object.entries(defaultRoutes)) {
		if (!(name in mergedRoutes)) {
			mergedRoutes[name] = spec;
		}
	}
	cfg.routes = mergedRoutes as typeof cfg.routes;

	// Core system scheduler tasks (health monitoring + vault hygiene) are
	// code-defined so every install has them even when settings.json predates
	// them or lists its own tasks. Merge by id: a settings task with the same
	// id wins (operator can retune/disable), code fills any gaps.
	const userTaskIds = new Set(cfg.scheduler.tasks.map((t) => t.id));
	for (const coreTask of defaults.scheduler.tasks) {
		if (!userTaskIds.has(coreTask.id)) {
			cfg.scheduler.tasks.push(coreTask);
		}
	}

	return cfg;
}

function buildResolved(parsed: SoulHubConfig) {
	return {
		devDir: expandPath(parsed.paths.devDir),
		vaultDir: expandPath(parsed.paths.vaultDir),
		// Empty catalogDir → derive from the running repo (<cwd>/catalog), so it
		// follows the repo wherever it lives instead of a hardcoded author path.
		catalogDir: parsed.paths.catalogDir
			? expandPath(parsed.paths.catalogDir)
			: resolve(process.cwd(), 'catalog'),
		claudeBinary: expandPath(parsed.paths.claudeBinary),
	};
}

// Loaded at startup; mutated in place by `reloadConfig()` when settings.json
// changes. Callers that read `config.<field>` per access (e.g. the WhatsApp
// adapter's `readChannelConfig`) automatically see the fresh value. Modules
// that cached a sub-reference at init (e.g. `config.resolved.vaultDir` baked
// into the vault watcher path) still need a process restart for those slots.
const _config = loadSettings();

/** Resolved config with ~ expanded to absolute paths */
export const config: SoulHubConfig & { resolved: { devDir: string; vaultDir: string; catalogDir: string; claudeBinary: string } } = {
	..._config,
	resolved: buildResolved(_config),
};

/** Re-read settings.json and replace every top-level field of the exported
 *  `config` object in place. Keeps the import reference stable so live
 *  consumers like `import { config } from '$lib/config.js'` see fresh values
 *  on next property read.
 *
 *  Safe to call from request handlers — re-uses Zod validation; if the file
 *  is corrupt we keep the old config and log instead of crashing. */
export function reloadConfig(): { ok: boolean; error?: string } {
	let fresh: SoulHubConfig;
	try {
		fresh = loadSettings();
	} catch (err) {
		const msg = (err as Error).message;
		console.warn('[config] reloadConfig failed, keeping previous values:', msg);
		return { ok: false, error: msg };
	}

	for (const key of Object.keys(config) as Array<keyof typeof config>) {
		if (key === 'resolved') continue;
		delete (config as Record<string, unknown>)[key];
	}
	Object.assign(config, fresh);
	config.resolved = buildResolved(fresh);

	console.log('[config] Reloaded from settings.json');
	return { ok: true };
}

/** Default config (parsed from empty input) — exposed for callers that need a baseline. */
export const DEFAULTS: SoulHubConfig = ConfigSchema.parse({}) as SoulHubConfig;
