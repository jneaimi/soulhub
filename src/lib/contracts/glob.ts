/** Tiny glob matcher for contract file globs — soul-hub-governance ADR-002.
 *
 *  Deliberately self-contained (no transitive dep on picomatch) and tiny: the
 *  semantics must be re-expressible in the bash advisory hook. Supported:
 *    `**` — any characters, including `/`
 *    `*`  — any characters except `/`
 *    `?`  — exactly one character except `/`
 *  Everything else is literal. Anchored (full-string) match. */

/** Compile a glob to an anchored RegExp with `**`/`*`/`?` semantics. */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				// `**` (optionally followed by `/`) → match across path separators.
				re += '.*';
				i++;
				if (glob[i + 1] === '/') i++; // consume the slash so `**/x` also matches `x`
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]\\'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp('^' + re + '$');
}

/** True if `path` matches `glob` (full-string, with the semantics above). */
export function globMatch(glob: string, path: string): boolean {
	return globToRegExp(glob).test(path);
}

/** Simplify a glob for bash `[[ $p == $glob ]]`, where a single `*` already
 *  crosses `/`. Collapsing `**`→`*` makes the bash matcher slightly more
 *  permissive than the node one — acceptable for an advisory hook (over-match
 *  shows an extra notice; never under-matches). */
export function toBashGlob(glob: string): string {
	return glob.replace(/\*\*/g, '*');
}
