#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["weasyprint", "jinja2", "pyyaml"]
# ///
"""
doc-render component v0.1.0 — Naseej document render engine (ADR-030 CP2).

Renders an ordered composition of `kind: presentation` components to a single
PDF via the vendored render core (WeasyPrint). Replaces the external
`katib-build` dependency.

I/O contract (see BLOCK.md):
  stdin:  { composition: [{component, inputs}...], brand?, lang?, out_pdf, catalog_root? }
  stdout: { pdf_path, bytes, components_rendered, warnings }
  exit:   0 ok | 2 bad input | 5 compose/render error

`composition` is an ordered list; each entry names a `kind: presentation`
component in the catalog and supplies its `inputs`. `brand` is an inline token
map OR a path to a brand YAML file (full Naseej brand config is Phase 2).
`catalog_root` overrides the component search dir (used by tests); it defaults
to this component's parent, i.e. catalog/components/.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# run.py runs with cwd = its own dir (the runner spawns `uv run run.py` from
# record.dir), and sys.path[0] is the script dir — so `render_core` (a sibling
# package) is importable. Be explicit anyway for robustness under other cwds.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from render_core import (  # noqa: E402
    ComposeError,
    TokenError,
    compose,
    load_base_tokens,
    load_brand,
    merge_tokens,
    render_to_pdf,
)

DEFAULT_CATALOG_ROOT = SCRIPT_DIR.parent  # catalog/components/


def fail(msg: str, code: int = 2) -> int:
    print(json.dumps({"error": msg}))
    return code


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        return fail(f"stdin is not valid JSON: {e}")
    if not isinstance(payload, dict):
        return fail("stdin JSON must be an object")

    # composition: inline `composition` array, OR `composition_path` to a JSON
    # file (a bare array, or an object with a `composition` key). The file form
    # exists because a large composition exceeds the runner's 10KB inline stdout
    # cap — pipelines write it to a file and pass the path. Generic, not
    # peer-brief specific.
    composition = payload.get("composition")
    if composition is None:
        comp_path = payload.get("composition_path")
        if comp_path is not None:
            if not isinstance(comp_path, str):
                return fail("`composition_path` must be a string path when provided")
            try:
                loaded = json.loads(Path(comp_path).expanduser().read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                return fail(f"cannot read composition_path {comp_path!r}: {e}")
            composition = loaded.get("composition") if isinstance(loaded, dict) else loaded
    if not isinstance(composition, list) or not composition:
        return fail("`composition` (or `composition_path`) must yield a non-empty array of {component, inputs}")

    lang = payload.get("lang", "en")
    if lang not in ("en", "ar"):
        return fail(f"`lang` must be 'en' or 'ar', got {lang!r}")

    out_pdf = payload.get("out_pdf")
    if not isinstance(out_pdf, str) or not out_pdf.strip():
        return fail("`out_pdf` (output path) is required")

    catalog_root_raw = payload.get("catalog_root")
    if catalog_root_raw is not None and not isinstance(catalog_root_raw, str):
        return fail("`catalog_root` must be a string path when provided")
    catalog_root = (
        Path(catalog_root_raw).expanduser() if catalog_root_raw else DEFAULT_CATALOG_ROOT
    )
    if not catalog_root.exists():
        return fail(f"catalog_root does not exist: {catalog_root}")

    # Brands dir for resolving a brand SLUG (ADR-031). Default: the `brands`
    # sibling of catalog_root (catalog/brands when catalog_root is catalog/
    # components). Overridable for tests via the `brands_dir` input.
    brands_dir_raw = payload.get("brands_dir")
    if brands_dir_raw is not None and not isinstance(brands_dir_raw, str):
        return fail("`brands_dir` must be a string path when provided")
    brands_dir = (
        Path(brands_dir_raw).expanduser() if brands_dir_raw else catalog_root.parent / "brands"
    )

    brand = payload.get("brand")  # dict | str(path|slug) | None

    # ── Resolve tokens (base + brand) ──────────────────────────────────────
    try:
        base = load_base_tokens()
        brand_data = load_brand(brand, brands_dir)
        tokens = merge_tokens(base, brand_data)
    except TokenError as e:
        return fail(f"brand/token error: {e}", code=2)

    # ── Compose → render ───────────────────────────────────────────────────
    try:
        page_html, meta = compose(composition, tokens, lang, catalog_root)
    except ComposeError as e:
        return fail(f"compose error: {e}", code=5)
    except Exception as e:  # noqa: BLE001 — any compose-time failure is a render error
        return fail(f"unexpected compose error: {type(e).__name__}: {e}", code=5)

    out_path = Path(out_pdf).expanduser()
    try:
        # base_url = catalog_root so relative asset paths (logos) resolve.
        render_to_pdf(page_html, out_path, base_url=catalog_root)
    except Exception as e:  # noqa: BLE001 — WeasyPrint raises a wide variety
        return fail(f"render error: {type(e).__name__}: {e}", code=5)

    result = {
        "pdf_path": str(out_path.resolve()),
        "bytes": out_path.stat().st_size,
        "components_rendered": meta["components_rendered"],
        "warnings": meta["warnings"],
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
