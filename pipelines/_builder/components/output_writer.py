#!/usr/bin/env python3
"""Write output JSON or markdown to PIPELINE_OUTPUT."""
import json, os
from pathlib import Path
from typing import Any


def write_output(data: Any, fmt: str = "json") -> str:
    """Write output to PIPELINE_OUTPUT path.

    Args:
        data: Data to write. For "json" format, must be JSON-serializable.
              For "md" format, should be a string.
        fmt: Output format — "json" or "md".
    Returns:
        The output file path written to.
    Raises:
        ValueError: If PIPELINE_OUTPUT is not set.
    """
    output_path = os.environ.get("PIPELINE_OUTPUT", "")
    if not output_path:
        raise ValueError("PIPELINE_OUTPUT env var not set")

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if fmt == "json":
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    elif fmt == "md":
        path.write_text(str(data) + "\n")
    else:
        raise ValueError(f"Unknown format: {fmt}")

    print(f"Output: {output_path}")
    return str(path)
