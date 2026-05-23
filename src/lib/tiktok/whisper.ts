/**
 * Tier B continued — local STT via whisper.cpp `whisper-cli` (ADR-024).
 *
 * Validation 2026-05-10 on M-series: ggml-base on a 53.8s English clip
 * transcribed in 6.17s (~8.7x real-time), $0, with output matching visible
 * subtitles exactly.
 *
 * Model picker:
 *   - English (default) → `ggml-base.bin`   (142MB, 8x rt)
 *   - Arabic / mixed    → `ggml-small.bin`  (466MB, 5x rt)
 *
 * Capability probe runs once at module load; results cached. Re-probe
 * available via `probeCapabilities(force=true)` for the doctor route.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { TikTokCapabilities } from './types.js';

const TIMEOUT_MS = 120_000;

const WHISPER_MODEL_BASE_DIR = process.env.WHISPER_MODEL_BASE_DIR
	? process.env.WHISPER_MODEL_BASE_DIR.replace(/^~/, homedir())
	: join(homedir(), '.cache', 'whisper-cpp');

let capabilitiesCache: TikTokCapabilities | null = null;

/** Probe yt-dlp / ffmpeg / whisper-cli / curl_cffi / whisper models on the
 *  host. Cached at module load. The orchestrator's startup boot reads
 *  `tierAReady` to decide whether to register the `tiktokFetch` tool at all. */
export function probeCapabilities(force = false): TikTokCapabilities {
	if (!force && capabilitiesCache) return capabilitiesCache;

	const ytDlp = which('yt-dlp');
	const ffmpeg = which('ffmpeg');
	const whisperCli = which('whisper-cli');
	// Probe yt-dlp directly — checking system python3 misses the case where
	// yt-dlp is brewed with its own venv (the common macOS install). Asks
	// yt-dlp for its impersonate targets and looks for any non-"(unavailable)"
	// line. Slower than the system import (~250ms one-time) but accurate.
	const curlCffi = ytDlp ? checkYtDlpImpersonate() : false;

	const baseModel = join(WHISPER_MODEL_BASE_DIR, 'ggml-base.bin');
	const smallModel = join(WHISPER_MODEL_BASE_DIR, 'ggml-small.bin');
	const whisperModelEn = existsSync(baseModel) ? baseModel : null;
	const whisperModelAr = existsSync(smallModel) ? smallModel : whisperModelEn;

	const tierAReady = ytDlp && ffmpeg;
	const tierBReady = tierAReady && whisperCli && (whisperModelEn !== null);

	capabilitiesCache = {
		ytDlp,
		ffmpeg,
		whisperCli,
		whisperModelEn,
		whisperModelAr,
		curlCffi,
		tierAReady,
		tierBReady,
	};
	return capabilitiesCache;
}

export interface TranscribeOpts {
	/** ISO-639 language code. 'auto' lets whisper detect. */
	lang?: string;
	signal?: AbortSignal;
}

export interface TranscribeResult {
	text: string;
	lang: string;
	durationMs: number;
}

export async function transcribeWav(wavPath: string, opts: TranscribeOpts = {}): Promise<TranscribeResult> {
	const caps = probeCapabilities();
	if (!caps.whisperCli) {
		throw new Error('whisper-cli is not installed (run: npm run setup -- --with-tiktok)');
	}

	const lang = (opts.lang ?? 'en').toLowerCase();
	// Pick the model matching the requested language. Arabic falls back to
	// `ggml-base` if `ggml-small` is missing — accuracy will be poor but it
	// won't fail outright.
	const isAr = lang === 'ar' || lang === 'arabic';
	const modelPath = isAr ? caps.whisperModelAr : caps.whisperModelEn;
	if (!modelPath) {
		throw new Error(`whisper model not found at ${WHISPER_MODEL_BASE_DIR}/ggml-base.bin`);
	}

	const args = [
		'-m', modelPath,
		'-f', wavPath,
		'-l', lang === 'auto' ? 'auto' : lang,
		'-np',  // no progress
		'-nt',  // no timestamps
		'-t', String(Math.min(8, Math.max(2, (process.env.WHISPER_THREADS ? Number(process.env.WHISPER_THREADS) : 4)))),
	];

	const startedAt = Date.now();
	const text = await new Promise<string>((resolve, reject) => {
		const proc = spawn('whisper-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			proc.kill('SIGKILL');
			reject(new Error(`whisper-cli timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
		const onAbort = () => {
			proc.kill('SIGKILL');
			reject(new Error('whisper-cli aborted'));
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		proc.stdout.on('data', (b: Buffer) => out.push(b));
		proc.stderr.on('data', (b: Buffer) => err.push(b));
		proc.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`whisper-cli spawn failed: ${e.message}`));
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			if (code === 0) {
				resolve(Buffer.concat(out).toString('utf8'));
			} else {
				const stderr = Buffer.concat(err).toString('utf8').trim().slice(0, 240);
				reject(new Error(`whisper-cli exited ${code}: ${stderr || '(no stderr)'}`));
			}
		});
	});

	return {
		text: text.trim(),
		lang: lang === 'auto' ? 'auto' : lang,
		durationMs: Date.now() - startedAt,
	};
}

function which(cmd: string): boolean {
	const r = spawnSync('which', [cmd], { stdio: 'ignore' });
	return r.status === 0;
}

function checkPython3Module(mod: string): boolean {
	const r = spawnSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore' });
	return r.status === 0;
}

/** True iff yt-dlp can actually use --impersonate. Checks
 *  --list-impersonate-targets for any non-"(unavailable)" entry — robust to
 *  the case where curl_cffi is installed but at an unsupported version (e.g.
 *  curl_cffi 0.15 against yt-dlp 2026.03 — yt-dlp logs it as
 *  "curl_cffi-0.15.0 (unsupported)" and refuses to use it). */
function checkYtDlpImpersonate(): boolean {
	const r = spawnSync('yt-dlp', ['--list-impersonate-targets'], {
		encoding: 'utf8',
		timeout: 5000,
	});
	if (r.status !== 0 || !r.stdout) return false;
	for (const line of r.stdout.split('\n')) {
		// Real targets look like "Chrome-136    Macos-15    curl_cffi"
		// Headers / "(unavailable)" rows / dividers are rejected.
		if (!line.trim()) continue;
		if (line.includes('(unavailable)')) continue;
		if (/^\s*(Client|---|\[)/.test(line)) continue;
		if (/^[A-Za-z][\w-]*\s+\S+\s+curl_cffi/.test(line)) return true;
	}
	return false;
}
