#!/usr/bin/env python3
"""Read JSON config files with column awareness."""
import json, os
from pathlib import Path
from typing import Any


def read_config(config_path: str | Path) -> list[dict[str, Any]]:
    """Read a JSON config file and return rows.

    Args:
        config_path: Absolute or relative path to the JSON config file.
                     If relative, resolved against PIPELINE_DIR.
    Returns:
        List of row dicts. Empty list if file missing or invalid.
    """
    path = Path(config_path)
    if not path.is_absolute():
        pipeline_dir = Path(os.environ.get("PIPELINE_DIR", "."))
        path = pipeline_dir / path

    if not path.exists():
        return []

    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def get_column_values(rows: list[dict[str, Any]], column: str) -> list[Any]:
    """Extract values for a specific column from config rows.

    Args:
        rows: Config rows from read_config().
        column: Column name to extract.
    Returns:
        List of non-None values for that column.
    """
    return [row[column] for row in rows if column in row and row[column] is not None]
