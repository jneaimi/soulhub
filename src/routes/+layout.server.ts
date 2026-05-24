import { config } from '$lib/config';
import { APP_VERSION } from '$lib/version.js';
import { getUpdateState } from '$lib/update-check/index.js';
import type { LayoutServerLoad } from './$types';

/** ADR-008 — surface feature-visibility flags to every page so the nav, the
 *  homepage tiles, and route guards can hide not-yet-released modules. Server
 *  load (not universal) because it reads the server-side `config`.
 *
 *  ADR-010 — also surface the update-check state (read once from the local
 *  cache) so AppHeader can render the update-available banner. Only computed
 *  when `features.updateCheck` is on; on the operator's private instance the
 *  flag is off, so `update` is null and the banner never renders (F1). */
export const load: LayoutServerLoad = () => ({
	features: config.features,
	update: config.features.updateCheck ? getUpdateState(APP_VERSION) : null,
});
