import QRCode from 'qrcode';

/** Convert a raw Baileys QR string into a PNG data URL the settings UI
 *  can drop into an `<img src>`. Returns the empty string on failure so
 *  the UI can fall back to a copy/paste workflow. */
export async function qrToDataUrl(raw: string): Promise<string> {
	try {
		return await QRCode.toDataURL(raw, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
	} catch {
		return '';
	}
}

/** ANSI block-art rendering of the QR for terminal output — handy for
 *  headless first-run pairing where the Settings UI isn't reachable yet.
 *  Uses the `qrcode` library's built-in terminal renderer (`small: true`
 *  halves the height by encoding two rows per line). */
export async function qrToAscii(raw: string): Promise<string> {
	try {
		return await QRCode.toString(raw, {
			type: 'terminal',
			small: true,
			errorCorrectionLevel: 'M',
		});
	} catch {
		return '';
	}
}
