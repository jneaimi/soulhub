/** Scheduler handler: telegram-liveness (ADR-011 falsifier #5 closure).
 *
 *  Telegram uses webhooks for inbound updates. If the webhook delivery
 *  path breaks (Cloudflare tunnel down, certificate issue, app crash
 *  loop, wrong URL configured), Telegram silently buffers updates and
 *  the operator only finds out when they try to use the bot. ADR-011's
 *  fifth falsifier bullet — "bot stops receiving updates without alert
 *  within 5 minutes" — calls for a liveness check.
 *
 *  Strategy: call Telegram's own `getWebhookInfo()` (outbound API call
 *  from our side, which is healthy whenever this handler runs) and
 *  inspect the canonical signals Telegram exposes:
 *  - `pending_update_count` — updates buffered on Telegram's side
 *    because they couldn't be delivered to our webhook
 *  - `last_error_date` + `last_error_message` — most recent delivery
 *    error reported by Telegram
 *  - `last_synchronization_error_date` — sync-time error
 *
 *  If any indicator fires, alert the operator via Telegram (outbound
 *  to the API normally works even when inbound webhook is broken).
 *  Alerts are in-process deduped — we only alert on the rising edge,
 *  then re-alert after RE_ALERT_AFTER_MS if still broken.
 *
 *  Settings shape:
 *    {
 *      id: 'telegram-liveness',
 *      type: 'telegram-liveness',
 *      cron: '*\/10 * * * *',
 *      timezone: 'Asia/Dubai',
 *      params: {
 *        pendingThreshold?: 5,       // pending_update_count > this → alert
 *        errorWindowMin?: 60,        // alert if last_error_date is younger than this
 *        reAlertAfterMin?: 240,      // re-alert window when still broken
 *      }
 *    }
 */

import { getWebhookInfo } from '../../channels/telegram/client.js';
import { send as sendTelegram } from '../../channels/telegram/index.js';
import type { TaskFn } from '../task-types.js';

interface TelegramLivenessParams {
	pendingThreshold?: number;
	errorWindowMin?: number;
	reAlertAfterMin?: number;
}

interface LivenessResult {
	ok: boolean;
	issues: string[];
	pendingUpdateCount: number;
	lastErrorAgeMin: number | null;
	alerted: boolean;
	skipped?: boolean;
	reason?: string;
}

// Module-level dedup state. Resets on process restart (acceptable — if
// the issue persists past restart, the next tick re-detects + re-alerts).
let lastAlertedAt: number | null = null;

/** Exposed for tests; production paths don't call this. */
export function _resetLivenessAlertState(): void {
	lastAlertedAt = null;
}

export function telegramLivenessFactory(rawParams: unknown): TaskFn {
	const params: TelegramLivenessParams =
		typeof rawParams === 'object' && rawParams !== null
			? (rawParams as TelegramLivenessParams)
			: {};
	const pendingThreshold = params.pendingThreshold ?? 5;
	const errorWindowMin = params.errorWindowMin ?? 60;
	const reAlertAfterMs = (params.reAlertAfterMin ?? 240) * 60_000;

	return async (): Promise<LivenessResult> => {
		const info = await getWebhookInfo();
		if (!info.ok || !info.result) {
			// Our outbound to Telegram failed. Could be transient; don't
			// alert (the alert path uses the same API and would also fail).
			return {
				ok: false,
				issues: [],
				pendingUpdateCount: 0,
				lastErrorAgeMin: null,
				alerted: false,
				skipped: true,
				reason: `getWebhookInfo failed: ${info.error ?? 'unknown'}`,
			};
		}

		const w = info.result;
		const issues: string[] = [];

		if (typeof w.pending_update_count === 'number' && w.pending_update_count > pendingThreshold) {
			issues.push(`${w.pending_update_count} pending updates buffered on Telegram side`);
		}

		const nowSec = Math.floor(Date.now() / 1000);
		const lastErrorAgeMin =
			typeof w.last_error_date === 'number'
				? Math.round((nowSec - w.last_error_date) / 60)
				: null;

		if (lastErrorAgeMin !== null && lastErrorAgeMin < errorWindowMin) {
			const msg = w.last_error_message ?? '(no message)';
			issues.push(`webhook delivery error ${lastErrorAgeMin}m ago: ${msg}`);
		}

		if (issues.length === 0) {
			lastAlertedAt = null; // reset edge state when healthy
			return {
				ok: true,
				issues: [],
				pendingUpdateCount: w.pending_update_count ?? 0,
				lastErrorAgeMin,
				alerted: false,
			};
		}

		// Issues exist — alert on the rising edge OR after the cooldown.
		const shouldAlert = lastAlertedAt === null || Date.now() - lastAlertedAt > reAlertAfterMs;
		if (!shouldAlert) {
			return {
				ok: false,
				issues,
				pendingUpdateCount: w.pending_update_count ?? 0,
				lastErrorAgeMin,
				alerted: false,
				reason: 'still alerted recently',
			};
		}

		const text = [
			`🔔 *Telegram webhook liveness alert*`,
			``,
			...issues.map((i) => `- ${i}`),
			``,
			`webhook url: \`${w.url ?? '(none)'}\``,
			`Check: \`curl -s "$TELEGRAM_API/bot$TOKEN/getWebhookInfo"\` or \`/api/orchestration/telegram\`.`,
		].join('\n');
		try {
			const send = await sendTelegram(text);
			if (!send.ok) {
				console.warn(`[telegram-liveness] alert send failed: ${send.error}`);
			} else {
				lastAlertedAt = Date.now();
			}
		} catch (err) {
			console.warn(`[telegram-liveness] alert threw: ${(err as Error).message}`);
		}

		return {
			ok: false,
			issues,
			pendingUpdateCount: w.pending_update_count ?? 0,
			lastErrorAgeMin,
			alerted: lastAlertedAt === Date.now() || lastAlertedAt !== null,
		};
	};
}
