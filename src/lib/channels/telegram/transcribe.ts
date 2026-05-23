/** Re-export the Gemini multimodal transcribe helper from the WhatsApp
 *  module — the implementation is provider-agnostic at the channel
 *  layer (it takes raw audio bytes and a mimetype) so duplicating it
 *  here would add maintenance for zero gain. */

export { transcribeVoiceNote } from '../whatsapp/transcribe.js';
export type {
	TranscribeOptions,
	TranscribeResult,
} from '../whatsapp/transcribe.js';
