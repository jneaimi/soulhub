"""Naseej doc-render vendored render core (ADR-030 CP2).

Ported + trimmed from katib's core/ — token resolution, composition, and the
WeasyPrint render wrapper. Owned by Naseej; zero runtime dependency on
~/dev/katib. The adaptation seam is `compose.load_presentation_component`,
which reads Naseej's flat `kind: presentation` catalog instead of katib recipes.
"""
from .compose import ComposeError, compose, load_presentation_component
from .render import render_to_pdf
from .tokens import (
    TokenError,
    load_base_tokens,
    load_brand,
    merge_tokens,
    render_context,
    tokens_css,
)

__all__ = [
    "ComposeError",
    "compose",
    "load_presentation_component",
    "render_to_pdf",
    "TokenError",
    "load_base_tokens",
    "load_brand",
    "merge_tokens",
    "render_context",
    "tokens_css",
]
