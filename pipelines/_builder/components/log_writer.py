#!/usr/bin/env python3
"""Append timestamped entries to a log file.

Usage:
    from log_writer import log_action

    log_action("Sent notification to #general", log_path="output/actions.log")
    log_action("Called API endpoint /v1/data", log_path="output/actions.log")

Output format:
    [2026-04-07 15:30:00] ACTION: description
"""

import os
from datetime import datetime
from pathlib import Path


def log_action(description: str, log_path: str | None = None) -> str:
    """Append a timestamped action entry to a log file.

    Args:
        description: What happened (e.g. "Posted to Slack #general").
        log_path: Path to log file. Defaults to PIPELINE_OUTPUT or "output/actions.log".
    Returns:
        The formatted log line that was written.
    """
    if log_path is None:
        log_path = os.environ.get("PIPELINE_OUTPUT", "output/actions.log")

    path = Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] ACTION: {description}\n"

    with open(path, "a") as f:
        f.write(line)

    return line.strip()
