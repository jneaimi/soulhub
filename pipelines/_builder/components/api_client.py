#!/usr/bin/env python3
"""Reusable HTTP client for fetching JSON from APIs."""
import json
import time
import urllib.error
import urllib.request
from typing import Any

USER_AGENT = "SoulHub-Pipeline/1.0"
MAX_RETRIES = 3


def _request(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 15) -> dict[str, Any]:
    """Internal: make an HTTP request with retries and exponential backoff.

    Args:
        url: The URL to request.
        data: POST body (bytes). None for GET.
        headers: Extra headers.
        timeout: Request timeout in seconds.
    Returns:
        Parsed JSON response as a dict.
    Raises:
        RuntimeError: On persistent failure after retries.
    """
    hdrs = {"User-Agent": USER_AGENT}
    if headers:
        hdrs.update(headers)
    if data is not None:
        hdrs.setdefault("Content-Type", "application/json")

    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as e:
            last_error = f"HTTP {e.code}: {e.reason}"
        except urllib.error.URLError as e:
            last_error = f"URL error: {e.reason}"
        except TimeoutError:
            last_error = f"Timeout after {timeout}s"
        except json.JSONDecodeError as e:
            last_error = f"Invalid JSON: {e}"

        if attempt < MAX_RETRIES - 1:
            time.sleep(2 ** attempt)

    raise RuntimeError(f"Request to {url} failed after {MAX_RETRIES} attempts: {last_error}")


def fetch_json(url: str, headers: dict | None = None, timeout: int = 15) -> dict[str, Any]:
    """GET a URL and return parsed JSON.

    Args:
        url: The URL to fetch.
        headers: Optional extra headers.
        timeout: Request timeout in seconds.
    Returns:
        Parsed JSON response.
    """
    return _request(url, headers=headers, timeout=timeout)


def post_json(url: str, data: Any, headers: dict | None = None, timeout: int = 15) -> dict[str, Any]:
    """POST JSON data to a URL and return parsed JSON response.

    Args:
        url: The URL to post to.
        data: Data to serialize as JSON body.
        headers: Optional extra headers.
        timeout: Request timeout in seconds.
    Returns:
        Parsed JSON response.
    """
    body = json.dumps(data).encode("utf-8")
    return _request(url, data=body, headers=headers, timeout=timeout)
