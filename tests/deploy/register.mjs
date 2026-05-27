/** Register the chat test ESM loader.
 *  Usage: node --import ./tests/chat/register.mjs --test --experimental-strip-types <test-file>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
register(pathToFileURL(resolve(__dirname, 'loader.mjs')).href, {
	parentURL: import.meta.url,
});
