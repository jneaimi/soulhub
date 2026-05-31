/** Shared voice preferences (ADR-020 P3).
 *
 *  A tiny reactive, localStorage-backed store so the dictation language choice
 *  is set once and applies to both the Orchestrator mic and the PTY overlay.
 *
 *  `auto` lets `scribe_v2_realtime` detect the language; `en` / `ar` pass an
 *  explicit hint (ISO-639-1), which noticeably improves accuracy — especially
 *  for Arabic, where auto-detect on short clips is weaker.
 *
 *  Default is `auto` at module init (SSR-safe — no localStorage read), then
 *  `initVoicePrefs()` hydrates the stored choice on mount to avoid an SSR/client
 *  mismatch on the toggle label. */

export type VoiceLang = 'auto' | 'en' | 'ar';

const KEY = 'soul-voice-lang';
const ORDER: VoiceLang[] = ['auto', 'en', 'ar'];

export const voicePrefs = $state<{ lang: VoiceLang }>({ lang: 'auto' });

let _loaded = false;

/** Hydrate the stored preference. Call once from a component's onMount. */
export function initVoicePrefs(): void {
	if (_loaded || typeof localStorage === 'undefined') return;
	const v = localStorage.getItem(KEY);
	if (v === 'en' || v === 'ar' || v === 'auto') voicePrefs.lang = v;
	_loaded = true;
}

/** Cycle auto → en → ar → auto, persisting the choice. */
export function cycleVoiceLang(): void {
	const i = ORDER.indexOf(voicePrefs.lang);
	voicePrefs.lang = ORDER[(i + 1) % ORDER.length];
	try { localStorage.setItem(KEY, voicePrefs.lang); } catch { /* private mode */ }
}

/** Short uppercase label for the toggle button. */
export function voiceLangLabel(): string {
	return voicePrefs.lang === 'auto' ? 'AUTO' : voicePrefs.lang.toUpperCase();
}

/** The `languageCode` to pass to the capture module (undefined = auto-detect). */
export function voiceLangCode(): string | undefined {
	return voicePrefs.lang === 'auto' ? undefined : voicePrefs.lang;
}
