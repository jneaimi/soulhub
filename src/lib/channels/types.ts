/** Channel adapter system types */

/** Configuration field metadata — adapters declare what config they need */
export interface ChannelField {
	key: string;
	label: string;
	type: 'secret' | 'text';
	env: string; // env var name to resolve from
	/** When true (default), the channel cannot operate without this env var. */
	required?: boolean;
	/** Optional URL where the user can obtain this credential. */
	link?: string;
}

/** Adapter metadata — used by settings UI to render channel cards */
export interface ChannelMeta {
	id: string;
	name: string;
	icon: string; // Lucide icon name
	fields: ChannelField[];
	actions: ('send' | 'prompt' | 'listen')[];
}

/** Per-channel config stored in settings.json */
export interface ChannelConfig {
	enabled: boolean;
	label: string;
	defaultFor: ('send' | 'prompt' | 'listen')[];
}

/** Result of a send operation */
export interface SendResult {
	ok: boolean;
	messageId?: string;
	error?: string;
}

/** Outcome of a credential test — small enough for the UI to colour-code. */
export type TestStatus =
	| 'ok'
	| 'unauthorized'
	| 'invalid'
	| 'ratelimit'
	| 'network'
	| 'unconfigured'
	| 'unsupported';

export interface TestResult {
	ok: boolean;
	status: TestStatus;
	/** Optional human-readable detail; safe to render in the UI. */
	message?: string;
}

/** Channel adapter interface — each adapter implements this */
export interface ChannelAdapter {
	meta: ChannelMeta;
	/** Send a message (and optionally a file) */
	send(message: string, attachPath?: string): Promise<SendResult>;
	/** Check if required env vars are set */
	isConfigured(): boolean;
	/** Optional credential test — pings the upstream API with a tiny request
	 *  and returns a structured status. UIs render this beside each declared
	 *  secret. Adapters that can't safely test (e.g. write-only APIs) may
	 *  return `{ ok: false, status: 'unsupported' }` or omit the method. */
	test?(): Promise<TestResult>;
}

/** Channels section in settings.json */
export interface ChannelsSettings {
	[channelId: string]: ChannelConfig;
}

/** Pipeline channel step fields */
export interface ChannelStepConfig {
	channel?: string;  // adapter id, or omit for default
	action: 'send';    // only send for now, prompt/listen future
	message: string;
	attach?: string;   // file path to attach
}
