/** Thin Bot API HTTPS client.
 *
 *  Telegram exposes ~10 endpoints we need; we hand-roll instead of
 *  pulling a vendor SDK so dependency churn doesn't surprise us. All
 *  methods are typed only at the surface we actually consume.
 *
 *  Every call returns `{ ok: false, error }` on protocol failure rather
 *  than throwing, so dispatchers can degrade gracefully. */

import type {
	BotInfo,
	InlineKeyboardMarkup,
	TgMessage,
	TgUser,
} from './types.js';

const API_BASE = 'https://api.telegram.org/bot';
const FILE_BASE = 'https://api.telegram.org/file/bot';

export class TelegramApiError extends Error {
	constructor(
		message: string,
		public httpStatus?: number,
		public description?: string,
	) {
		super(message);
	}
}

export interface ApiResult<T> {
	ok: boolean;
	result?: T;
	error?: string;
	description?: string;
	httpStatus?: number;
}

function getToken(): string | undefined {
	return process.env.TELEGRAM_BOT_TOKEN;
}

async function call<T>(method: string, body?: unknown): Promise<ApiResult<T>> {
	const token = getToken();
	if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' };

	try {
		const res = await fetch(`${API_BASE}${token}/${method}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});
		const data = (await res.json().catch(() => undefined)) as
			| { ok: boolean; result?: T; description?: string }
			| undefined;
		if (data?.ok) return { ok: true, result: data.result, httpStatus: res.status };
		return {
			ok: false,
			error: data?.description ?? `HTTP ${res.status}`,
			description: data?.description,
			httpStatus: res.status,
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

async function callMultipart<T>(
	method: string,
	form: FormData,
): Promise<ApiResult<T>> {
	const token = getToken();
	if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' };

	try {
		const res = await fetch(`${API_BASE}${token}/${method}`, {
			method: 'POST',
			body: form,
		});
		const data = (await res.json().catch(() => undefined)) as
			| { ok: boolean; result?: T; description?: string }
			| undefined;
		if (data?.ok) return { ok: true, result: data.result, httpStatus: res.status };
		return {
			ok: false,
			error: data?.description ?? `HTTP ${res.status}`,
			description: data?.description,
			httpStatus: res.status,
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export interface SendMessageParams {
	chat_id: string | number;
	text: string;
	parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
	disable_web_page_preview?: boolean;
	reply_markup?: InlineKeyboardMarkup;
	reply_to_message_id?: number;
}

export function sendMessage(params: SendMessageParams) {
	return call<TgMessage>('sendMessage', params);
}

export interface EditMessageTextParams {
	chat_id: string | number;
	message_id: number;
	text: string;
	parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
	reply_markup?: InlineKeyboardMarkup;
}

export function editMessageText(params: EditMessageTextParams) {
	return call<TgMessage>('editMessageText', params);
}

export function answerCallbackQuery(params: {
	callback_query_id: string;
	text?: string;
	show_alert?: boolean;
}) {
	return call<true>('answerCallbackQuery', params);
}

export function getMe() {
	return call<BotInfo>('getMe');
}

export function setWebhook(params: {
	url: string;
	secret_token?: string;
	allowed_updates?: string[];
	drop_pending_updates?: boolean;
}) {
	return call<true>('setWebhook', params);
}

export function deleteWebhook(params?: { drop_pending_updates?: boolean }) {
	return call<true>('deleteWebhook', params ?? {});
}

export interface WebhookInfo {
	url: string;
	has_custom_certificate: boolean;
	pending_update_count: number;
	last_error_date?: number;
	last_error_message?: string;
	last_synchronization_error_date?: number;
	max_connections?: number;
	allowed_updates?: string[];
}

export function getWebhookInfo() {
	return call<WebhookInfo>('getWebhookInfo');
}

export interface BotCommand {
	command: string;
	description: string;
}

export function setMyCommands(params: { commands: BotCommand[] }) {
	return call<true>('setMyCommands', params);
}

export function getMyCommands() {
	return call<BotCommand[]>('getMyCommands');
}

export interface TgFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export function getFile(file_id: string) {
	return call<TgFile>('getFile', { file_id });
}

/** Download a file's bytes by file_id. Two-step:
 *   1. `getFile(file_id)` → gives us `file_path`
 *   2. GET `https://api.telegram.org/file/bot<TOKEN>/<file_path>`
 *  Returns the raw bytes plus the resolved file_path (for archival). */
export async function downloadFile(file_id: string): Promise<{
	ok: boolean;
	buffer?: Buffer;
	filePath?: string;
	error?: string;
}> {
	const meta = await getFile(file_id);
	if (!meta.ok || !meta.result?.file_path) {
		return { ok: false, error: meta.error ?? 'no file_path returned' };
	}
	const token = getToken();
	if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' };
	try {
		const res = await fetch(`${FILE_BASE}${token}/${meta.result.file_path}`);
		if (!res.ok) {
			return { ok: false, error: `download HTTP ${res.status}` };
		}
		const arrayBuffer = await res.arrayBuffer();
		return {
			ok: true,
			buffer: Buffer.from(arrayBuffer),
			filePath: meta.result.file_path,
		};
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** Multipart sendPhoto/Video/Audio/Voice/Document. We always send via
 *  multipart upload since file paths are local. Caption is optional. */
export interface SendMediaParams {
	chat_id: string | number;
	kind: 'photo' | 'video' | 'audio' | 'voice' | 'document';
	bytes: Buffer;
	fileName?: string;
	mimetype?: string;
	caption?: string;
	parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
}

export function sendMedia(params: SendMediaParams) {
	const form = new FormData();
	form.append('chat_id', String(params.chat_id));
	if (params.caption) form.append('caption', params.caption);
	if (params.parse_mode) form.append('parse_mode', params.parse_mode);

	const blob = new Blob([new Uint8Array(params.bytes)], {
		type: params.mimetype ?? 'application/octet-stream',
	});
	const fname = params.fileName ?? defaultFileName(params.kind);
	form.append(params.kind, blob, fname);

	const method =
		params.kind === 'photo'
			? 'sendPhoto'
			: params.kind === 'video'
				? 'sendVideo'
				: params.kind === 'audio'
					? 'sendAudio'
					: params.kind === 'voice'
						? 'sendVoice'
						: 'sendDocument';
	return callMultipart<TgMessage>(method, form);
}

function defaultFileName(kind: SendMediaParams['kind']): string {
	switch (kind) {
		case 'photo':
			return 'image.jpg';
		case 'video':
			return 'video.mp4';
		case 'audio':
			return 'audio.mp3';
		case 'voice':
			return 'voice.ogg';
		case 'document':
		default:
			return 'file.bin';
	}
}

export function setMessageReaction(params: {
	chat_id: string | number;
	message_id: number;
	reaction: { type: 'emoji'; emoji: string }[];
}) {
	return call<true>('setMessageReaction', params);
}

/** Telegram bot status indicator — `typing`, `upload_photo`, etc. Per
 *  ADR-022 Layer A. Auto-clears in ~5s on the recipient side; callers
 *  re-fire on a ~4s cadence via `keepTypingUntil`. */
export type ChatAction =
	| 'typing'
	| 'upload_photo'
	| 'record_video'
	| 'upload_video'
	| 'record_voice'
	| 'upload_voice'
	| 'upload_document'
	| 'choose_sticker'
	| 'find_location'
	| 'record_video_note'
	| 'upload_video_note';

export function sendChatAction(params: {
	chat_id: string | number;
	action: ChatAction;
}) {
	return call<true>('sendChatAction', params);
}

/** Telegram Web App descriptor used by `MenuButtonWebApp`. URL must be
 *  HTTPS — Telegram rejects http/local URLs at registration time. */
export interface WebAppInfo {
	url: string;
}

/** Subset of Telegram's `MenuButton` union. We only use `web_app` (open
 *  a page inside Telegram) and `default` (revert to the built-in
 *  commands menu). `commands` is also valid but redundant — it's the
 *  default behaviour when no custom button is set. */
export type MenuButton =
	| { type: 'web_app'; text: string; web_app: WebAppInfo }
	| { type: 'commands' }
	| { type: 'default' };

export function setChatMenuButton(params: {
	chat_id?: number;
	menu_button: MenuButton;
}) {
	return call<true>('setChatMenuButton', params);
}

export function getChatMenuButton(params?: { chat_id?: number }) {
	return call<MenuButton>('getChatMenuButton', params ?? {});
}

export interface BotIdentity {
	user: TgUser;
}
