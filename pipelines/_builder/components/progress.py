#!/usr/bin/env python3
"""Standard progress reporting for pipeline blocks."""


def report_progress(percent: int, label: str = "") -> None:
    """Print a progress update to stdout.

    Format: PROGRESS: 50% label
    The pipeline runner can parse these lines for progress bars.

    Args:
        percent: Completion percentage (0-100).
        label: Optional label describing current work.
    """
    msg = f"PROGRESS: {percent}%"
    if label:
        msg += f" {label}"
    print(msg, flush=True)


def report_status(message: str) -> None:
    """Print a status message to stdout.

    Format: STATUS: message

    Args:
        message: Status description.
    """
    print(f"STATUS: {message}", flush=True)
