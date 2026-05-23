#!/usr/bin/env python3
"""Read and write CSV files."""
import csv
import os
from pathlib import Path
from typing import Any


def write_csv(filepath: str | Path, rows: list[dict[str, Any]], headers: list[str] | None = None) -> None:
    """Write rows to a CSV file.

    Args:
        filepath: Path to the output CSV file.
        rows: List of dicts to write.
        headers: Column names. If None, inferred from the first row's keys.
    """
    path = Path(filepath)
    path.parent.mkdir(parents=True, exist_ok=True)

    if not headers:
        headers = list(rows[0].keys()) if rows else []

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def read_csv(filepath: str | Path) -> list[dict[str, str]]:
    """Read a CSV file and return rows as dicts.

    Args:
        filepath: Path to the CSV file.
    Returns:
        List of row dicts. Empty list if file missing.
    """
    path = Path(filepath)
    if not path.exists():
        return []

    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def append_csv(filepath: str | Path, rows: list[dict[str, Any]]) -> None:
    """Append rows to an existing CSV file.

    If the file doesn't exist, creates it with headers from the first row.

    Args:
        filepath: Path to the CSV file.
        rows: List of dicts to append.
    """
    if not rows:
        return

    path = Path(filepath)
    exists = path.exists()

    if not exists:
        write_csv(filepath, rows)
        return

    # Read existing headers
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or list(rows[0].keys())

    with open(path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writerows(rows)
