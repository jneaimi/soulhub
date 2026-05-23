#!/usr/bin/env python3
"""Pre-run hook: scan target directory and output stats as JSON."""

import json
import os
import sys


def scan_directory(path):
    file_count = 0
    total_lines = 0

    for root, _dirs, files in os.walk(path):
        for f in files:
            file_count += 1
            filepath = os.path.join(root, f)
            try:
                with open(filepath, "r", errors="ignore") as fh:
                    total_lines += sum(1 for _ in fh)
            except (OSError, UnicodeDecodeError):
                pass

    return file_count, total_lines


def main():
    target = os.environ.get("PLAYBOOK_INPUT", ".")
    file_count, total_lines = scan_directory(target)

    result = {
        "timeout_seconds": min(300, max(30, file_count * 2)),
        "findings_count": file_count,
        "total_lines": total_lines,
        "target": target,
    }

    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
