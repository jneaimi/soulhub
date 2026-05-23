/**
 * Tier B — TikTok audio download via yt-dlp + ffmpeg resample (ADR-024).
 *
 * Output: a 16kHz mono WAV in a per-call tmpdir. Caller is responsible for
 * cleanup via the returned `cleanup()`.
 *
 * Validation 2026-05-10: TikTok's anti-bot is intermittent — a second
 * consecutive call from the same IP failed with "Unexpected response from
 * webpage request". `--retries 3 --fragment-retries 3` absorbs the transient.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { probeCapabilities } from './whisper.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface DownloadResult {
	/** Absolute path to the 16kHz mono WAV file. */
	wavPath: string;
	/** Absolute path to the source mp4 (kept for Gemini Tier C reuse). */
	mp4Path: string;
	/** Tmpdir cleanup — call once whatever post-processing is done. Idempotent. */
	cleanup: () => Promise<void>;
}

export interface DownloadOpts {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function downloadTikTokAudio(
	watchUrl: string,
	opts: DownloadOpts = {},
): Promise<DownloadResult> {
	const dir = await mkdtemp(join(tmpdir(), 'tt-fetch-'));
	const mp4Path = join(dir, 'video.mp4');
	const wavPath = join(dir, 'audio.wav');

	const cleanup = async () => {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			// Best-effort — orphan tmpdirs are swept by the OS.
		}
	};

	try {
		await runYtDlpDownload(watchUrl, mp4Path, opts);
		await runFfmpegResample(mp4Path, wavPath, opts);
		if (!existsSync(wavPath)) {
			throw new Error(`ffmpeg produced no output at ${wavPath}`);
		}
		return { wavPath, mp4Path, cleanup };
	} catch (err) {
		await cleanup();
		throw err;
	}
}

function runYtDlpDownload(url: string, mp4Path: string, opts: DownloadOpts): Promise<void> {
	const caps = probeCapabilities();
	// Real browser TLS fingerprint when curl_cffi is available (see metadata.ts).
	const impersonateArgs = caps.curlCffi ? ['--impersonate', 'chrome'] : [];
	return runProcess(
		'yt-dlp',
		[
			'--no-warnings',
			'-q',
			'--retries',
			'3',
			'--fragment-retries',
			'3',
			// `--retries` only retries DOWNLOAD streams. TikTok's anti-bot fails
			// at the EXTRACTION stage with "Unexpected response from webpage
			// request" — yt-dlp's extractor-retries flag is the one that covers
			// that. Adds jittered backoff between extraction attempts.
			'--extractor-retries',
			'3',
			...impersonateArgs,
			'--no-playlist',
			// Prefer a smaller mp4 — we only need audio anyway, but keeping the
			// container as mp4 allows Tier C (Gemini) to reuse the same file.
			'-f',
			'mp4/best',
			'-o',
			mp4Path,
			url,
		],
		opts,
	);
}

function runFfmpegResample(mp4Path: string, wavPath: string, opts: DownloadOpts): Promise<void> {
	return runProcess(
		'ffmpeg',
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-y',
			'-i',
			mp4Path,
			'-vn',
			'-ar',
			'16000',
			'-ac',
			'1',
			'-c:a',
			'pcm_s16le',
			wavPath,
		],
		opts,
	);
}

function runProcess(cmd: string, args: string[], opts: DownloadOpts): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		const errChunks: Buffer[] = [];
		const timer = setTimeout(() => {
			proc.kill('SIGKILL');
			reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onAbort = () => {
			proc.kill('SIGKILL');
			reject(new Error(`${cmd} aborted`));
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		proc.stderr.on('data', (b: Buffer) => errChunks.push(b));
		proc.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`${cmd} spawn failed: ${e.message}`));
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			if (code === 0) return resolve();
			const stderr = Buffer.concat(errChunks).toString('utf8').trim().slice(0, 240);
			reject(new Error(`${cmd} exited ${code}: ${stderr || '(no stderr)'}`));
		});
	});
}
