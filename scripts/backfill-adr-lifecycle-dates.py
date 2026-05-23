#!/usr/bin/env python3
"""Backfill lifecycle dates for ADRs in a project by walking git history.

Per ~/vault/projects/CLAUDE.md governance: dates inferred from BULK commits
(>5 files in one commit) get a `date_inferred: true` flag alongside so the
Gantt can render uncertainty visually.

Usage:
  python3 backfill-dates.py <project>          # dry-run, no writes
  python3 backfill-dates.py <project> --apply  # write to disk

Run from inside the vault directory.
"""

import re
import subprocess
import sys
from pathlib import Path

PROJECT = sys.argv[1] if len(sys.argv) > 1 else "soul-hub-whatsapp"
APPLY = "--apply" in sys.argv

SYNONYM = {
    "proposed": "proposed",
    "accepted": "accepted",
    "approved": "accepted",
    "shipped": "shipped",
    "implemented": "shipped",
    "complete": "shipped",
    "migrated": "shipped",
    "rejected": "rejected",
    "parked": "parked",
    "deferred": "parked",
    "superseded": "superseded",
    "phase-1-shipped": "shipped",
    "phase-2-shipped": "shipped",
    "phase-2-5-shipped": "shipped",
    "phase-1+2-shipped": "shipped",
    "phase-1+4-lite-shipped": "shipped",
    "partially-accepted": "accepted",
    "active": "accepted",
    "current": "accepted",
}

CANONICAL_TO_FIELD = {
    "accepted": "accepted_on",
    "shipped": "shipped_on",
    "rejected": "rejected_on",
    "parked": "parked_on",
    "superseded": "superseded_on",
}

BULK_THRESHOLD = 5  # commits touching >5 files = bulk migration / import


def normalize(raw: str | None) -> str | None:
    if not raw:
        return None
    return SYNONYM.get(raw.strip().strip('"').strip("'").lower())


def parse_status(text: str) -> str | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    fm = text[3:end]
    m = re.search(r"^status:\s*(.+)$", fm, re.M)
    return normalize(m.group(1)) if m else None


def already_has(text: str, field: str) -> bool:
    if not text.startswith("---"):
        return False
    end = text.find("\n---", 4)
    fm = text[3:end]
    return bool(re.search(rf"^{field}:\s*\S", fm, re.M))


def git_log_commits(file_path: str) -> list[tuple[str, str]]:
    out = subprocess.run(
        ["git", "log", "--reverse", "--follow", "--pretty=format:%H %ad",
         "--date=short", "--", file_path],
        capture_output=True, text=True
    ).stdout
    return [(line.split()[0], line.split()[1]) for line in out.splitlines() if line.strip()]


def file_at_commit(commit: str, file_path: str) -> str:
    out = subprocess.run(
        ["git", "show", f"{commit}:{file_path}"],
        capture_output=True, text=True
    )
    return out.stdout if out.returncode == 0 else ""


def commit_touches_count(commit: str) -> int:
    out = subprocess.run(
        ["git", "show", "--name-only", "--pretty=format:", commit],
        capture_output=True, text=True
    ).stdout
    return len([l for l in out.splitlines() if l.strip()])


def insert_field(text: str, field: str, value: str) -> str:
    """Insert a frontmatter field at the end of the YAML block (before
    closing `---`). Idempotent — does nothing if field already present."""
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 4)
    if end < 0:
        return text
    fm = text[3:end]
    if re.search(rf"^{field}:\s*\S", fm, re.M):
        return text  # already present, leave it
    new_fm = fm.rstrip() + f"\n{field}: {value}\n"
    return "---" + new_fm + text[end:]


def main():
    project_dir = Path(f"projects/{PROJECT}")
    if not project_dir.exists():
        print(f"ERROR: {project_dir} not found")
        sys.exit(1)

    bulk_cache: dict[str, bool] = {}
    def is_bulk(commit: str) -> bool:
        if commit not in bulk_cache:
            bulk_cache[commit] = commit_touches_count(commit) > BULK_THRESHOLD
        return bulk_cache[commit]

    proposals = []  # list of (relpath, current_status, [(field, date, commit, is_bulk_flag)])

    for md in sorted(project_dir.rglob("*.md")):
        try:
            current_text = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if not re.search(r"^type:\s*decision\b", current_text, re.M):
            continue
        current_status = parse_status(current_text)
        if not current_status:
            continue

        commits = git_log_commits(str(md))
        if not commits:
            continue

        first_seen: dict[str, tuple[str, str]] = {}
        for commit, date in commits:
            text = file_at_commit(commit, str(md))
            status = parse_status(text)
            if status and status not in first_seen:
                first_seen[status] = (date, commit)

        order = ["proposed", "accepted", "shipped"]
        writes = []
        for canonical, field in CANONICAL_TO_FIELD.items():
            if canonical not in first_seen:
                continue
            in_lifecycle = (
                canonical == current_status
                or (canonical in order and current_status in order
                    and order.index(canonical) <= order.index(current_status))
                or (canonical in ("rejected", "parked", "superseded") and canonical == current_status)
            )
            if not in_lifecycle:
                continue
            date, commit = first_seen[canonical]
            if not already_has(current_text, field):
                writes.append((field, date, commit, is_bulk(commit)))

        if writes:
            proposals.append((str(md), current_status, writes))

    # Print report
    mode = "APPLY" if APPLY else "DRY-RUN"
    print(f"=== {mode} backfill: projects/{PROJECT} ===\n")
    print(f"Files with proposed writes: {len(proposals)}\n")

    bulk_writes = 0
    clean_writes = 0
    for path, status, writes in proposals:
        title = path.split("/")[-1].replace(".md", "")
        print(f"  [{status:<10}] {title}")
        for field, date, commit, is_bulk_flag in writes:
            flag = "  ⚠ inferred" if is_bulk_flag else "  ✓ exact"
            print(f"      {field}: {date}    (from {commit[:10]}){flag}")
            if is_bulk_flag:
                bulk_writes += 1
            else:
                clean_writes += 1
        print()

    total = bulk_writes + clean_writes
    files_with_inferred = sum(
        1 for _, _, writes in proposals if any(b for _, _, _, b in writes)
    )
    print(f"\n=== Summary ===")
    print(f"Total writes: {total}  (exact: {clean_writes}, inferred: {bulk_writes})")
    print(f"Files with at least one inferred date: {files_with_inferred} (will get `date_inferred: true`)")

    if not APPLY:
        print(f"\nDry-run only. Re-run with --apply to write.")
        return

    # APPLY
    print(f"\n=== Writing files ===")
    written = 0
    for path, status, writes in proposals:
        text = Path(path).read_text(encoding="utf-8")
        original = text
        any_inferred = False
        for field, date, _, is_bulk_flag in writes:
            text = insert_field(text, field, date)
            if is_bulk_flag:
                any_inferred = True
        if any_inferred:
            text = insert_field(text, "date_inferred", "true")
        if text != original:
            Path(path).write_text(text, encoding="utf-8")
            written += 1
            print(f"  ✓ {path}")
    print(f"\nWrote {written} files. Vault watcher + auto-committer will pick them up.")


if __name__ == "__main__":
    main()
