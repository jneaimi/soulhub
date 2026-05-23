#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
fill-template.py — peer-brief slot-fill assembler (ADR-034 CP3).

Pipeline tooling (NOT a catalog component): it carries the peer-brief's
domain routing (which draft field feeds which slot), so it lives in scripts/
beside extract-signal-trend.py. The catalog components stay generic.

It reads the peer-brief DOCUMENT TEMPLATE (catalog/documents/peer-brief/
document.yaml) plus the run's computed + drafted values, then emits a concrete
`doc-render` composition on stdout as a JSON OBJECT:

    { "composition": [ {component, inputs, variant?}... ],
      "section_count": int, "warnings": [str...] }

The runner threads `outputs.composition` (a real array, native type preserved
for a lone {{...}} placeholder) into the doc-render step's `composition` input.

Slot fill by effective class:
  static        → the template's binding value (already authored).
  deterministic → from the trend YAML (stacked-area-chart) or computed here
                  (cover reference_code from the context counts).
  judgment      → from the three LLM draft JSON blobs (prose / findings /
                  figures), routed per the PEER_BRIEF map below.

Inputs:
  --template   catalog/documents/peer-brief/document.yaml
  --context    context.json   (split-miner-daily.py)
  --trend      trend.yaml      (extract-signal-trend.py)
  --prose      prose draft JSON   { cover_title, cover_subtitle, exec_summary }
  --findings   findings draft JSON { findings_html, delta_html }
  --figures    figures draft JSON  { bar_items, bar_caption, matrix_rows,
                                     matrix_caption, pull_text, pull_attr,
                                     heatmap_rows, heatmap_caption }
  --date       run date (YYYY-MM-DD) for the reference code

Exit: 0 ok (warnings non-fatal; missing values become visible [MISSING]
placeholders so the render still completes for parity inspection),
2 bad input.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

# Slots the trend helper (extract-signal-trend.py) supplies, by component input.
TREND_SLOTS = {
    "bands",
    "x_ticks",
    "y_ticks",
    "chart_geometry",
    "today_x",
    "today_index",
    "y_max",
    "caption",
}

# Judgment routing: (component, input) -> (draft-blob, draft-field).
# Components that appear ONCE route directly here.
PROSE_MAP = {
    ("cover-page", "title"): ("prose", "cover_title"),
    ("cover-page", "subtitle"): ("prose", "cover_subtitle"),
}
FIGURES_MAP = {
    ("horizontal-bar-chart", "items"): ("figures", "bar_items"),
    ("horizontal-bar-chart", "caption"): ("figures", "bar_caption"),
    ("comparison-dot-matrix", "rows"): ("figures", "matrix_rows"),
    ("comparison-dot-matrix", "caption"): ("figures", "matrix_caption"),
    ("pull-quote", "text"): ("figures", "pull_text"),
    ("pull-quote", "attribution"): ("figures", "pull_attr"),
    ("categorical-heatmap", "rows"): ("figures", "heatmap_rows"),
    ("categorical-heatmap", "caption"): ("figures", "heatmap_caption"),
}
# callout + module appear MORE THAN ONCE, so route their judgment body by the
# entry's static `title` value.
CALLOUT_BY_TITLE = {
    "Executive Summary": ("prose", "exec_summary"),
    "Closing Note": ("closing", "closing_note"),
}
MODULE_BY_TITLE = {
    "Five Findings": ("findings", "findings_html"),
    "Delta vs Previous Run": ("findings", "delta_html"),
    "How to Use This Brief": ("closing", "how_to_use_html"),
}
# The one UNTITLED judgment module is the Notes section (About-the-Author is the
# other untitled module, but its raw_body is static, so it never routes here).
UNTITLED_MODULE = ("closing", "notes_html")


def fail(msg: str, code: int = 2) -> int:
    print(json.dumps({"error": msg}))
    return code


def load_json_lenient(path: str | None, label: str, warnings: list[str]) -> dict:
    """Parse a draft JSON file, tolerating ```json fences and stray prose."""
    if not path:
        warnings.append(f"{label}: no draft file supplied")
        return {}
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except OSError as e:
        warnings.append(f"{label}: cannot read {path}: {e}")
        return {}
    if text.startswith("```"):
        # strip leading ```json / ``` and trailing ```
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # last-ditch: slice from first { to last }
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        i, j = text.find("{"), text.rfind("}")
        if i != -1 and j != -1 and j > i:
            try:
                return json.loads(text[i : j + 1])
            except json.JSONDecodeError as e:
                warnings.append(f"{label}: JSON parse failed: {e}")
                return {}
        warnings.append(f"{label}: no JSON object found")
        return {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--template", required=True)
    ap.add_argument("--context", required=True)
    ap.add_argument("--trend", required=True)
    ap.add_argument("--prose", required=True)
    ap.add_argument("--findings", required=True)
    ap.add_argument("--figures", required=True)
    ap.add_argument("--closing", required=True, help="closing draft JSON: how_to_use_html, closing_note, notes_html")
    ap.add_argument("--cover", required=True, help="pick-cover JSON: { image: <path> }")
    ap.add_argument("--date", required=True)
    ns = ap.parse_args()

    warnings: list[str] = []

    try:
        tpl = yaml.safe_load(Path(ns.template).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        return fail(f"cannot load template: {e}")
    composition_tpl = tpl.get("composition")
    if not isinstance(composition_tpl, list) or not composition_tpl:
        return fail("template has no composition")

    try:
        context = json.loads(Path(ns.context).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return fail(f"cannot load context: {e}")
    try:
        trend = yaml.safe_load(Path(ns.trend).read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as e:
        return fail(f"cannot load trend: {e}")

    prose = load_json_lenient(ns.prose, "prose", warnings)
    findings = load_json_lenient(ns.findings, "findings", warnings)
    figures = load_json_lenient(ns.figures, "figures", warnings)
    closing = load_json_lenient(ns.closing, "closing", warnings)
    drafts = {"prose": prose, "findings": findings, "figures": figures, "closing": closing}

    # cover image (deterministic — picked from the pool by pick-cover.py)
    cover = load_json_lenient(ns.cover, "cover", warnings)
    cover_image = cover.get("image")

    # ── deterministic: cover reference code ────────────────────────────────
    stats = context.get("summary_stats", {}) or {}
    sig = stats.get("signals", 0)
    posts = stats.get("posts", 0)
    tx = stats.get("transcripts", 0)
    ref_code = (
        f"SF-PEER-{ns.date} · {sig} signals · {posts} posts · "
        f"{tx} transcript{'s' if tx != 1 else ''}"
    )

    def route_judgment(component: str, slot: str, static_title: str | None):
        if component == "module" and slot == "raw_body":
            if static_title in MODULE_BY_TITLE:
                blob, field = MODULE_BY_TITLE[static_title]
            elif static_title is None:
                blob, field = UNTITLED_MODULE          # the Notes section
            else:
                return None
            return drafts[blob].get(field)
        if component == "callout" and slot == "body":
            if static_title in CALLOUT_BY_TITLE:
                blob, field = CALLOUT_BY_TITLE[static_title]
                return drafts[blob].get(field)
            return None
        if (component, slot) in PROSE_MAP:
            blob, field = PROSE_MAP[(component, slot)]
            return drafts[blob].get(field)
        if (component, slot) in FIGURES_MAP:
            blob, field = FIGURES_MAP[(component, slot)]
            return drafts[blob].get(field)
        return None

    # ── walk the template, fill each declared slot by class ────────────────
    composition: list[dict] = []
    for i, entry in enumerate(composition_tpl):
        component = entry.get("component")
        slots = entry.get("slots", {}) or {}
        static_title = None
        t = slots.get("title", {})
        if isinstance(t, dict) and t.get("class") == "static":
            static_title = t.get("value")

        inputs: dict = {}
        for slot, binding in slots.items():
            if not isinstance(binding, dict):
                continue
            cls = binding.get("class", "judgment")
            if cls == "static":
                inputs[slot] = binding.get("value")
            elif cls == "deterministic":
                if component == "stacked-area-chart" and slot in TREND_SLOTS:
                    if slot in trend:
                        inputs[slot] = trend[slot]
                    else:
                        warnings.append(f"composition[{i}] {component}.{slot}: trend missing key")
                        inputs[slot] = f"[MISSING:{slot}]"
                elif component == "cover-page" and slot == "reference_code":
                    inputs[slot] = ref_code
                elif component == "cover-page" and slot == "image":
                    if cover_image:
                        inputs[slot] = cover_image
                    else:
                        warnings.append(f"composition[{i}] cover-page.image: no cover image picked")
                        # omit the slot → cover falls back to the minimalist layout
                else:
                    warnings.append(f"composition[{i}] {component}.{slot}: no deterministic source")
                    inputs[slot] = f"[MISSING:{slot}]"
            else:  # judgment
                val = route_judgment(component, slot, static_title)
                if val is None:
                    warnings.append(f"composition[{i}] {component}.{slot}: draft value missing")
                    inputs[slot] = f"[MISSING:{component}.{slot}]"
                else:
                    inputs[slot] = val

        out_entry: dict = {"component": component, "inputs": inputs}
        if entry.get("variant"):
            out_entry["variant"] = entry["variant"]
        if entry.get("break_inside"):
            out_entry["break_inside"] = entry["break_inside"]
        composition.append(out_entry)

    print(
        json.dumps(
            {
                "composition": composition,
                "section_count": len(composition),
                "warnings": warnings,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
