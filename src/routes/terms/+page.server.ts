import type { PageServerLoad } from './$types';
import { operatorName, operatorEmail } from '$lib/branding.js';

// ADR-055 — operator identity is config-driven (SOUL_HUB_OPERATOR_NAME /
// SOUL_HUB_OPERATOR_EMAIL in ~/.soul-hub/.env), so a fresh clone's legal page
// shows a neutral default instead of the author's name/email.
export const load: PageServerLoad = () => ({
	operatorName: operatorName(),
	operatorEmail: operatorEmail(),
});
