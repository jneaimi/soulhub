import { config } from '$lib/config';
import type { LayoutServerLoad } from './$types';

/** ADR-008 — surface feature-visibility flags to every page so the nav, the
 *  homepage tiles, and route guards can hide not-yet-released modules. Server
 *  load (not universal) because it reads the server-side `config`. */
export const load: LayoutServerLoad = () => ({
	features: config.features,
});
