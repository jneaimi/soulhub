// Build-time application version, sourced from package.json (resolveJsonModule).
// Vite/Rollup inline these at build time, so there is no runtime fs read or
// path-resolution fragility across dev (`npm run dev`) and the adapter-node
// production bundle.
import pkg from '../../package.json';

/** semver from package.json, e.g. "2.0.0" */
export const APP_VERSION: string = pkg.version;

/** Display name of the product (package.json `name` is the npm slug). */
export const APP_NAME = 'Soul Hub';
