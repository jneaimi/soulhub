"""PDF rendering via WeasyPrint.

Vendored from katib core/render.py (ADR-030 CP2) — unchanged. Takes an HTML
string + optional base URL (for resolving relative asset paths like logos)
and writes a PDF.
"""
from __future__ import annotations

from pathlib import Path

from weasyprint import HTML


def render_to_pdf(
    html_str: str,
    out_path: Path | str,
    base_url: Path | str | None = None,
) -> Path:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    base = str(base_url) if base_url else None
    HTML(string=html_str, base_url=base).write_pdf(str(out))
    return out
