// Resolve a write verb's body from exactly one of:
//   --content STR        inline string
//   --content -          read all of stdin (fd 0)
//   --content-file PATH  read the file verbatim (UTF-8)
// Inline strings are fragile for multi-line markdown (shell quoting, embedded
// $/backticks, control chars, argv size limit); file/stdin avoid all of that.

import { readFileSync } from 'node:fs';
import { fail } from './output.ts';

// Returns the body string, or undefined when NO source supplied (callers decide
// whether that's an error). Throws via fail() on conflict or unreadable file.
export function resolveContent(args: Record<string, string | undefined>): string | undefined {
  const hasFile = args['content-file'] !== undefined;
  const isStdin = args.content === '-';
  const hasInline = args.content !== undefined && !isStdin;

  const sources = [hasInline, isStdin, hasFile].filter(Boolean).length;
  if (sources > 1) {
    fail('choose exactly one of --content / --content-file / --content -');
  }
  if (sources === 0) return undefined;

  if (isStdin) {
    try {
      return readFileSync(0, 'utf8');
    } catch (err) {
      fail(`--content -: cannot read stdin: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (hasFile) {
    const path = args['content-file'] as string;
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      fail(`--content-file: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return args.content;
}
