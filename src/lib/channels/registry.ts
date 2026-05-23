import type {
	ChannelAdapter,
	ChannelConfig,
	ChannelMeta,
	ChannelsSettings,
	SendResult,
	TestResult,
} from './types.js';
import { adapter as telegramAdapter, bootstrap as telegramBootstrap } from './telegram/index.js';
import { adapter as whatsappAdapter, bootstrap as whatsappBootstrap } from './whatsapp/index.js';

/** All registered channel adapters */
const adapters = new Map<string, ChannelAdapter>();

// Register built-in adapters
adapters.set('telegram', telegramAdapter);
adapters.set('whatsapp', whatsappAdapter);

// Wire the WhatsApp inbound dispatcher and auto-start when settings has
// `channels.whatsapp.enabled: true` + creds on disk. Safe no-op otherwise.
whatsappBootstrap();

// Cache Telegram bot identity at startup so the inbound mention detector
// is ready for the first message. Webhook setup is user-driven via
// /api/channels/telegram/setup so it runs once when the user wires the
// channel up — not on every restart.
telegramBootstrap();

/** Get all registered adapter metadata (for settings UI) */
export function getAllChannelMeta(): ChannelMeta[] {
	return Array.from(adapters.values()).map((a) => a.meta);
}

/** Get a specific adapter by id */
export function getAdapter(id: string): ChannelAdapter | undefined {
	return adapters.get(id);
}

/** Get the default adapter for a given action based on channel settings */
export function getDefaultAdapter(
	action: 'send' | 'prompt' | 'listen',
	channelsConfig: ChannelsSettings,
): ChannelAdapter | undefined {
	// Find first enabled channel that has this action in defaultFor
	for (const [id, cfg] of Object.entries(channelsConfig)) {
		if (cfg.enabled && cfg.defaultFor.includes(action)) {
			const adapter = adapters.get(id);
			if (adapter?.isConfigured()) return adapter;
		}
	}
	// Fallback: first enabled + configured adapter that supports the action
	for (const [id, cfg] of Object.entries(channelsConfig)) {
		if (cfg.enabled) {
			const adapter = adapters.get(id);
			if (adapter?.isConfigured() && adapter.meta.actions.includes(action)) {
				return adapter;
			}
		}
	}
	return undefined;
}

/** Send a message via a specific channel or the default one */
export async function sendViaChannel(
	channelId: string | undefined,
	channelsConfig: ChannelsSettings,
	message: string,
	attachPath?: string,
): Promise<SendResult> {
	let adapter: ChannelAdapter | undefined;

	if (channelId) {
		adapter = adapters.get(channelId);
		if (!adapter) {
			return { ok: false, error: `Unknown channel: ${channelId}` };
		}
	} else {
		adapter = getDefaultAdapter('send', channelsConfig);
		if (!adapter) {
			return { ok: false, error: 'No default channel configured for send' };
		}
	}

	const cfg = channelsConfig[adapter.meta.id];
	if (cfg && !cfg.enabled) {
		return { ok: false, error: `Channel "${adapter.meta.name}" is disabled` };
	}

	if (!adapter.isConfigured()) {
		return {
			ok: false,
			error: `Channel "${adapter.meta.name}" is not configured — missing env vars`,
		};
	}

	return adapter.send(message, attachPath);
}

/** Default channel config for all adapters */
export function getDefaultChannelsConfig(): ChannelsSettings {
	const defaults: ChannelsSettings = {};
	for (const [id, adapter] of adapters) {
		defaults[id] = {
			enabled: adapter.isConfigured(),
			label: adapter.meta.name,
			defaultFor: adapter.meta.actions.includes('send') ? ['send'] : [],
		};
	}
	return defaults;
}

/** A secret declared by some adapter — used by the settings UI to show
 *  what's needed even when nothing is configured yet. */
export interface DeclaredSecret {
	/** Env var name, e.g. `TELEGRAM_BOT_TOKEN` */
	key: string;
	/** Human label for the field, e.g. `Bot Token` */
	label: string;
	/** Source(s) that declared it — usually a single adapter id */
	declaredBy: string[];
	/** True if any declarer marks it as required */
	required: boolean;
	/** First link any declarer provides for obtaining the secret */
	link?: string;
}

/** Test the credential associated with `envKey` by routing to the first
 *  adapter that declares it and calling `adapter.test()`. Returns a
 *  structured `TestResult`. Keys that no adapter declares — or that the
 *  adapter chose not to support — get `unsupported`. */
export async function testSecret(envKey: string): Promise<TestResult> {
	for (const adapter of adapters.values()) {
		const declares = adapter.meta.fields.some(
			(f) => f.type === 'secret' && f.env === envKey,
		);
		if (!declares) continue;
		if (typeof adapter.test !== 'function') {
			return {
				ok: false,
				status: 'unsupported',
				message: `Adapter '${adapter.meta.id}' does not implement a credential test.`,
			};
		}
		return adapter.test();
	}
	return {
		ok: false,
		status: 'unsupported',
		message: `No adapter declares ${envKey}; cannot test it from here.`,
	};
}

/** Aggregate every secret declared by registered channel adapters.
 *  Keys declared by multiple adapters are merged (union of declaredBy,
 *  required = OR, first non-empty link wins). */
export function getDeclaredSecrets(): DeclaredSecret[] {
	const map = new Map<string, DeclaredSecret>();
	for (const adapter of adapters.values()) {
		for (const field of adapter.meta.fields) {
			if (field.type !== 'secret') continue;
			const existing = map.get(field.env);
			if (existing) {
				if (!existing.declaredBy.includes(adapter.meta.id)) {
					existing.declaredBy.push(adapter.meta.id);
				}
				if (field.required) existing.required = true;
				if (!existing.link && field.link) existing.link = field.link;
			} else {
				map.set(field.env, {
					key: field.env,
					label: field.label,
					declaredBy: [adapter.meta.id],
					required: !!field.required,
					link: field.link,
				});
			}
		}
	}
	return Array.from(map.values());
}
