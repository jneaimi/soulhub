/**
 * Tier A — TikTok metadata via `yt-dlp --print` (ADR-024).
 *
 * `yt-dlp -j` (full JSON dump) triggers an impersonation-backend warning
 * without `curl_cffi` installed; `--print` with explicit field templates is
 * the rock-solid path. Validation 2026-05-10: ~1.5s for the test clip,
 * succeeds even when the heavier `-x` download path intermittently fails.
 *
 * Fields extracted: id, duration, uploader, title (truncated), full
 * description (= on-platform caption + hashtags), view/like/comment/repost
 * counts, upload_date.
 */

import { spawn } from 'node:child_process';

import type { TikTokMetadata } from './types.js';
import { probeCapabilities } from './whisper.js';

const TIMEOUT_MS = 15_000;

/** Pipe-delimited template — order matters and is mirrored by the parser.
 *  The empty-default form `%(field|0)s` substitutes `0` when a field is
 *  missing, so the parser never sees a `NA` literal that would break int
 *  parsing. */
const PRINT_TEMPLATE =
	'%(id)s|%(duration|0)s|%(uploader)s|%(title)s|%(view_count|0)s|%(like_count|0)s|%(comment_count|0)s|%(repost_count|0)s|%(upload_date|)s|%(description|)s';

export async function fetchTikTokMetadata(watchUrl: string): Promise<TikTokMetadata> {
	// When curl_cffi is available, --impersonate=chrome makes yt-dlp use a real
	// browser TLS fingerprint. This is the deterministic anti-bot bypass —
	// without it TikTok intermittently serves the JS-challenge page (validated
	// 2026-05-10). Falls back to plain HTTP when curl_cffi is missing, in
	// which case the tool still works but is rate-limit-fragile.
	const caps = probeCapabilities();
	const impersonateArgs = caps.curlCffi ? ['--impersonate', 'chrome'] : [];

	const stdout = await runYtDlp([
		'--print',
		PRINT_TEMPLATE,
		'--no-warnings',
		'--no-playlist',
		'--retries',
		'3',
		// Anti-bot fails at extraction, before any download stream — `--retries`
		// alone doesn't cover it. yt-dlp adds jittered backoff between
		// extraction attempts when this is set. Mirrors download.ts.
		'--extractor-retries',
		'3',
		...impersonateArgs,
		watchUrl,
	]);

	const line = stdout.trim().split(/\r?\n/).pop() ?? '';
	if (!line) {
		throw new Error('yt-dlp returned empty metadata');
	}

	// Description may contain pipes — split limited to the leading 9 fields,
	// the rest joined back.
	const parts = line.split('|');
	if (parts.length < 9) {
		throw new Error(`yt-dlp metadata has too few fields (${parts.length}): ${line.slice(0, 200)}`);
	}
	const [
		id,
		durationStr,
		uploader,
		title,
		viewStr,
		likeStr,
		commentStr,
		repostStr,
		uploadDate,
	] = parts;
	const description = parts.slice(9).join('|').trim();

	if (!id) {
		throw new Error(`yt-dlp returned no id: ${line.slice(0, 200)}`);
	}

	const handle = (uploader || '').replace(/^@/, '');

	return {
		author: handle || 'unknown',
		authorHandle: handle,
		title: title?.trim() || undefined,
		caption: description || (title?.trim() ?? ''),
		durationSec: parsePositiveInt(durationStr) ?? 0,
		postedAt: formatUploadDate(uploadDate),
		views: parsePositiveInt(viewStr),
		likes: parsePositiveInt(likeStr),
		comments: parsePositiveInt(commentStr),
		reposts: parsePositiveInt(repostStr),
	};
}

function parsePositiveInt(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = Number(s);
	if (!Number.isFinite(n) || n < 0) return undefined;
	if (n === 0) return undefined;
	return Math.trunc(n);
}

/** yt-dlp emits `YYYYMMDD`. Reformat to ISO-8601 date so downstream callers
 *  don't have to know the source format. Returns `undefined` for empty. */
function formatUploadDate(s: string | undefined): string | undefined {
	if (!s || s.length !== 8) return undefined;
	return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function runYtDlp(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			proc.kill('SIGKILL');
			reject(new Error(`yt-dlp metadata timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
		proc.stdout.on('data', (b: Buffer) => out.push(b));
		proc.stderr.on('data', (b: Buffer) => err.push(b));
		proc.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`yt-dlp spawn failed: ${e.message}`));
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(Buffer.concat(out).toString('utf8'));
			} else {
				const stderr = Buffer.concat(err).toString('utf8').trim().slice(0, 240);
				reject(new Error(`yt-dlp exited ${code}: ${stderr || '(no stderr)'}`));
			}
		});
	});
}
