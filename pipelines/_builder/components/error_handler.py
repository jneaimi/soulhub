#!/usr/bin/env python3
"""Standard error output format for pipeline blocks."""
import json
import sys
import traceback
from datetime import datetime, timezone
from typing import Callable


def pipeline_error(message: str, step: str | None = None, details: str | None = None) -> None:
    """Print a structured error to stderr and exit.

    Args:
        message: Human-readable error description.
        step: Optional step ID where the error occurred.
        details: Optional extra context (stack trace, raw response, etc.).
    """
    error = {
        "error": message,
        "step": step,
        "details": details,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)


def with_error_handling(main_func: Callable[[], None]) -> Callable[[], None]:
    """Wrap a main() function to catch unhandled exceptions.

    Usage:
        if __name__ == "__main__":
            with_error_handling(main)()

    Args:
        main_func: The function to wrap.
    Returns:
        A wrapper that catches exceptions and calls pipeline_error.
    """
    def wrapper():
        try:
            main_func()
        except SystemExit:
            raise
        except Exception as e:
            pipeline_error(
                message=str(e),
                details=traceback.format_exc(),
            )
    return wrapper
