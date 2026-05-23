#!/usr/bin/env python3
"""Backfill `falsifier_date` into ADR frontmatter from body prose.

ADR-038 Phase 2's Gantt diamond renders only when `falsifier_date` is in
frontmatter, but most ADRs declare the falsifier as prose inside a
`## Falsifier` (or `## Falsifier date`, or in some ADRs `## Validation
gates`) section — e.g. "By 2026-07-01, at least one of …".

This script walks every `type: decision` note in the vault, finds the
first `YYYY-MM-DD` in or near a Falsifier section, and writes it to
frontmatter. Notes that already have `falsifier_date:` are left alone.
Dry-run by default; pass --apply to write.

Usage:
  python3 scripts/backfill-falsifier-dates.py            # dry-run
  python3 scripts/backfill-falsifier-dates.py --apply    # write to disk
  python3 scripts/backfill-falsifier-dates.py --project soul-hub-whatsapp

Run from anywhere — the script resolves the vault path via $HOME.
"""

import argparse
import re
from pathlib import Path

# Match "## Falsifier", "## Falsifier date", "## Validation gates" headings.
FALSIFIER_HEADING = re.compile(r'^##\s+(Falsifier|Validation\s+gate)', re.IGNORECASE | re.MULTILINE)
# Stop at the next H2.
NEXT_HEADING = re.compile(r'^##\s+', re.MULTILINE)
# Match a date like "By **2026-07-01**" or "by 2026-07-01" or "**2026-07-01**".
# Prefer dates that follow a "By"/"by" qualifier — those are the deadline ones.
BY_DATE = re.compile(r'\b[Bb]y\s+\**\s*(\d{4}-\d{2}-\d{2})\s*\**')
ANY_DATE = re.compile(r'\*\*(\d{4}-\d{2}-\d{2})\*\*|(?<![-\d])(\d{4}-\d{2}-\d{2})(?![-\d])')

FRONTMATTER_RE = re.compile(r'^---\n(.*?)\n---\n', re.DOTALL)


def extract_falsifier_date(body: str) -> str | None:
    """Return the first plausible falsifier date in the body, or None."""
    m = FALSIFIER_HEADING.search(body)
    if not m:
        return None
    section_start = m.end()
    next_h = NEXT_HEADING.search(body, section_start)
    section = body[section_start : next_h.start() if next_h else len(body)]

    # Prefer "By DATE" — that's the deadline-style language ADR-038/039 use.
    by_match = BY_DATE.search(section)
    if by_match:
        return by_match.group(1)

    # Fallback: any ISO date in the section.
    any_match = ANY_DATE.search(section)
    if any_match:
        return any_match.group(1) or any_match.group(2)

    return None


def has_falsifier_in_frontmatter(fm: str) -> bool:
    return bool(re.search(r'^falsifier_date\s*:', fm, re.MULTILINE))


def is_decision(fm: str) -> bool:
    return bool(re.search(r'^type\s*:\s*decision\b', fm, re.MULTILINE))


def insert_falsifier_date(raw: str, date: str) -> str:
    """Insert `falsifier_date: 'YYYY-MM-DD'` just before the closing `---`
    of the frontmatter block. Preserves existing layout."""
    m = FRONTMATTER_RE.match(raw)
    if not m:
        return raw
    fm_end = m.end() - 4  # position of the closing `---\n`
    insert = f"falsifier_date: '{date}'\n"
    return raw[:fm_end] + insert + raw[fm_end:]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true', help='Write changes to disk')
    p.add_argument('--project', help='Limit to one project slug')
    p.add_argument('--vault', default=str(Path.home() / 'vault'))
    args = p.parse_args()

    vault = Path(args.vault)
    projects_dir = vault / 'projects'
    if not projects_dir.exists():
        print(f"ERROR: {projects_dir} does not exist")
        return 1

    pattern = f"{args.project}/**/*.md" if args.project else "**/*.md"

    scanned = 0
    skipped_already_set = 0
    skipped_not_decision = 0
    skipped_no_falsifier = 0
    backfilled: list[tuple[str, str]] = []

    for f in sorted(projects_dir.glob(pattern)):
        raw = f.read_text()
        m = FRONTMATTER_RE.match(raw)
        if not m:
            continue
        fm = m.group(1)
        if not is_decision(fm):
            skipped_not_decision += 1
            continue
        scanned += 1
        if has_falsifier_in_frontmatter(fm):
            skipped_already_set += 1
            continue
        body = raw[m.end() :]
        date = extract_falsifier_date(body)
        if not date:
            skipped_no_falsifier += 1
            continue
        rel = f.relative_to(vault)
        backfilled.append((str(rel), date))
        if args.apply:
            new_raw = insert_falsifier_date(raw, date)
            f.write_text(new_raw)

    # Report
    print(f"Scanned:               {scanned} type=decision notes")
    print(f"Already had it:        {skipped_already_set}")
    print(f"No falsifier section:  {skipped_no_falsifier}")
    print(f"Not a decision:        {skipped_not_decision}")
    print(f"Would backfill:        {len(backfilled)}")
    print()
    for path, date in backfilled:
        print(f"  {date}  {path}")
    print()
    if not args.apply:
        print("Dry run. Re-run with --apply to write.")
    else:
        print(f"Wrote {len(backfilled)} files.")

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
