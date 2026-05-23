#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""CP2 test suite for the doc-render component (ADR-030).

Invokes run.py exactly as the Naseej runner does — `uv run run.py` from the
component dir, JSON on stdin, JSON on stdout — so it exercises the real
stdin-json contract end to end (including PEP 723 dep resolution + WeasyPrint).

Happy paths: EN render (3 callouts), AR render (ar template), AR→EN fallback
warning. Sad paths: missing/empty composition, unknown component, non-presentation
component, bad lang, missing out_pdf, invalid JSON, nonexistent catalog_root.

Run:  uv run --script tests/test_doc_render.py   (from the component dir)
      or with an absolute path from anywhere.
Exit: 0 all pass | 1 one or more failed.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

COMPONENT_DIR = Path(__file__).resolve().parent.parent
RUN_PY = COMPONENT_DIR / "run.py"
FIXTURE_CATALOG = Path(__file__).resolve().parent / "fixtures" / "components"
FIXTURE_BRANDS = Path(__file__).resolve().parent / "fixtures" / "brands"

PASS = 0
FAIL = 0


def invoke(payload, raw_stdin: str | None = None) -> tuple[int, dict]:
    """Run run.py with the given payload (or raw stdin string). Returns
    (exit_code, parsed_stdout_json). Parsed JSON is {} if stdout isn't JSON."""
    stdin = raw_stdin if raw_stdin is not None else json.dumps(payload)
    proc = subprocess.run(
        ["uv", "run", str(RUN_PY)],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=str(COMPONENT_DIR),
    )
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out = {"__raw_stdout__": proc.stdout, "__stderr__": proc.stderr}
    return proc.returncode, out


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  {detail}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="doc-render-test-"))
    catalog = str(FIXTURE_CATALOG)

    callout_comp = [
        {"component": "callout", "inputs": {"tone": "info", "title": "Executive Summary",
         "body": "287 market signals processed. Four of five findings carry GCC relevance."}},
        {"component": "callout", "inputs": {"tone": "warn", "title": "Caveat",
         "body": "The pipeline captures public social signals only."}},
        {"component": "callout", "inputs": {"tone": "neutral",
         "body": "A non-status highlight box uses tag_bg plus accent border."}},
    ]

    print("HAPPY PATHS")

    # 1. EN render, 3 components, no warnings.
    out_en = tmp / "en.pdf"
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(out_en), "catalog_root": catalog})
    check("EN render exits 0", code == 0, f"code={code} res={res}")
    check("EN pdf exists + non-trivial", out_en.exists() and out_en.stat().st_size > 1000,
          f"exists={out_en.exists()} size={out_en.stat().st_size if out_en.exists() else 0}")
    check("EN components_rendered == 3", res.get("components_rendered") == 3, str(res.get("components_rendered")))
    check("EN warnings empty", res.get("warnings") == [], str(res.get("warnings")))
    check("EN bytes matches file", res.get("bytes") == (out_en.stat().st_size if out_en.exists() else -1),
          f"reported={res.get('bytes')}")

    # 2. AR render with the ar template — no fallback warning.
    out_ar = tmp / "ar.pdf"
    code, res = invoke({"composition": [{"component": "callout",
                        "inputs": {"tone": "tip", "title": "ملخص", "body": "تمت معالجة الإشارات."}}],
                        "lang": "ar", "out_pdf": str(out_ar), "catalog_root": catalog})
    check("AR render exits 0", code == 0, f"code={code} res={res}")
    check("AR pdf exists", out_ar.exists() and out_ar.stat().st_size > 1000, str(res))
    check("AR no fallback warning", res.get("warnings") == [], str(res.get("warnings")))

    # 3. AR render of an en-only component → fallback warning, still succeeds.
    out_fb = tmp / "fallback.pdf"
    code, res = invoke({"composition": [{"component": "callout-en-only",
                        "inputs": {"tone": "info", "body": "Fallback body."}}],
                        "lang": "ar", "out_pdf": str(out_fb), "catalog_root": catalog})
    check("AR-fallback exits 0", code == 0, f"code={code} res={res}")
    check("AR-fallback warns about ar template", any("ar template" in w for w in res.get("warnings", [])),
          str(res.get("warnings")))

    # 4. Inline brand override changes a token (smoke — still renders).
    out_brand = tmp / "brand.pdf"
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(out_brand), "catalog_root": catalog,
                        "brand": {"colors": {"accent": "#7A1F68"}}})
    check("brand-override exits 0", code == 0, f"code={code} res={res}")

    # 5. Brand SLUG resolves against the fixtures brands dir (ADR-031 CP1).
    #    brands_dir defaults to catalog_root.parent/brands = fixtures/brands.
    out_slug = tmp / "brandslug.pdf"
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(out_slug), "catalog_root": catalog,
                        "brand": "testbrand"})
    check("brand SLUG exits 0", code == 0, f"code={code} res={res}")
    check("brand SLUG pdf non-trivial", out_slug.exists() and out_slug.stat().st_size > 1000,
          str(res))

    # 6. Explicit brands_dir override also resolves the slug.
    out_slug2 = tmp / "brandslug2.pdf"
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(out_slug2), "catalog_root": catalog,
                        "brand": "testbrand", "brands_dir": str(FIXTURE_BRANDS)})
    check("brand SLUG via explicit brands_dir exits 0", code == 0, f"code={code} res={res}")

    print("SAD PATHS")

    # 5. Missing composition.
    code, res = invoke({"lang": "en", "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("missing composition → exit 2", code == 2, f"code={code}")
    check("missing composition error mentions composition", "composition" in str(res.get("error", "")), str(res))

    # 6. Empty composition.
    code, res = invoke({"composition": [], "lang": "en", "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("empty composition → exit 2", code == 2, f"code={code}")

    # 7. Unknown component.
    code, res = invoke({"composition": [{"component": "does-not-exist", "inputs": {}}],
                        "lang": "en", "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("unknown component → exit 5", code == 5, f"code={code}")
    check("unknown component error mentions not found", "not found" in str(res.get("error", "")), str(res))

    # 8. Non-presentation component.
    code, res = invoke({"composition": [{"component": "not-presentation", "inputs": {}}],
                        "lang": "en", "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("subprocess component → exit 5", code == 5, f"code={code}")
    check("subprocess error mentions kind", "kind" in str(res.get("error", "")), str(res))

    # 9. Bad lang.
    code, res = invoke({"composition": callout_comp, "lang": "fr",
                        "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("bad lang → exit 2", code == 2, f"code={code}")

    # 10. Missing out_pdf.
    code, res = invoke({"composition": callout_comp, "lang": "en", "catalog_root": catalog})
    check("missing out_pdf → exit 2", code == 2, f"code={code}")

    # 11. Invalid JSON stdin.
    code, res = invoke(None, raw_stdin="{not json")
    check("invalid JSON → exit 2", code == 2, f"code={code}")

    # 12. Nonexistent catalog_root.
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(tmp / "x.pdf"), "catalog_root": "/no/such/dir"})
    check("bad catalog_root → exit 2", code == 2, f"code={code}")

    # 13. Composition entry missing `component` key.
    code, res = invoke({"composition": [{"inputs": {"tone": "info", "body": "x"}}],
                        "lang": "en", "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog})
    check("entry missing component → exit 5", code == 5, f"code={code}")

    # 14. Unknown brand slug → exit 2 (token error).
    code, res = invoke({"composition": callout_comp, "lang": "en",
                        "out_pdf": str(tmp / "x.pdf"), "catalog_root": catalog,
                        "brand": "no-such-brand"})
    check("unknown brand slug → exit 2", code == 2, f"code={code}")
    check("unknown brand error mentions slug", "slug" in str(res.get("error", "")), str(res))

    print(f"\n{PASS} passed, {FAIL} failed")
    # Leave the EN pdf path for an eyeball.
    if out_en.exists():
        print(f"EN sample PDF: {out_en}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
