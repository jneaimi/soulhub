#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
extract-signal-trend.py — Pull stacked-area trend data from the Signal Forge
SQLite for embedding in a peer-brief recipe (Figure 0).

Output: YAML block on stdout with fields {eyebrow, x_labels, today_index,
y_max, bands[], caption}. Pre-computes SVG polygon points so the renderer
component is dumb.

Usage:
    uv run extract-signal-trend.py
    uv run extract-signal-trend.py --days 14 --top 4 --as-of 2026-05-14
    uv run extract-signal-trend.py --db /path/to/signals.db --top 5
"""
from __future__ import annotations

import argparse
import datetime as dt
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

import yaml

DEFAULT_DB = Path.home() / "dev/signal-forge/db/signals.db"

# Brand-aligned palette (jasem brand). Bottom band gets the strongest tone.
COLORS = ["#F59E0B", "#FB923C", "#FDBA74", "#FED7AA", "#A1A1AA"]

# SVG geometry
VIEW_W = 600
PAD_LEFT = 40
PAD_RIGHT = 20
PAD_TOP = 20
PAD_BOTTOM = 30
CHART_TOP = PAD_TOP
CHART_BOTTOM = 210  # gives chart_height = 190
CHART_LEFT = PAD_LEFT
CHART_RIGHT = VIEW_W - PAD_RIGHT
CHART_W = CHART_RIGHT - CHART_LEFT
CHART_H = CHART_BOTTOM - CHART_TOP


def fetch_cluster_counts(db: Path, days: int, as_of: str | None) -> dict[str, dict[str, int]]:
    """Return {date_iso: {topic: count}} for run-days inside the window with data."""
    if as_of is None:
        as_of = dt.date.today().isoformat()
    cutoff = (dt.date.fromisoformat(as_of) - dt.timedelta(days=days)).isoformat()

    sql = """
        SELECT date(ms.fetched_at) AS day,
               msr.topic           AS topic,
               COUNT(*)            AS sigs
          FROM market_signals ms
          JOIN market_searches msr ON ms.search_id = msr.id
         WHERE date(ms.fetched_at) >= ?
           AND date(ms.fetched_at) <= ?
         GROUP BY day, topic
         HAVING sigs > 0
         ORDER BY day, sigs DESC
    """
    counts: dict[str, dict[str, int]] = defaultdict(dict)
    with sqlite3.connect(db) as conn:
        for day, topic, sigs in conn.execute(sql, (cutoff, as_of)):
            counts[day][topic] = sigs
    return dict(counts)


def pick_top_clusters(counts: dict[str, dict[str, int]], as_of: str, top_n: int) -> list[str]:
    """Top N clusters from today's counts. Falls back to most recent day if today is empty."""
    if as_of in counts and counts[as_of]:
        today = counts[as_of]
    else:
        # Fall back to most recent day with data
        recent = sorted([d for d in counts if counts[d]], reverse=True)
        if not recent:
            return []
        today = counts[recent[0]]
    sorted_topics = sorted(today.items(), key=lambda kv: kv[1], reverse=True)
    return [t for t, _ in sorted_topics[:top_n]]


def shorten(label: str, max_len: int = 36) -> str:
    """Trim long topic strings for the legend."""
    label = label.strip()
    # Strip noisy suffixes
    for marker in ("⚡", "(Signal Strength", "—"):
        if marker in label:
            label = label.split(marker)[0].strip(" ·-")
    return label if len(label) <= max_len else label[: max_len - 1] + "…"


def build_bands(
    counts: dict[str, dict[str, int]],
    days: list[str],
    top_clusters: list[str],
) -> tuple[list[dict], int]:
    """Compute stacked-area polygon points for each cluster + 'Other'.

    Returns (bands, y_max).
    """
    cluster_order = list(top_clusters) + ["__other__"]
    n_days = len(days)

    # Per-day per-cluster values
    matrix: dict[str, list[int]] = {c: [0] * n_days for c in cluster_order}
    for i, day in enumerate(days):
        day_counts = counts.get(day, {})
        seen = 0
        for c in top_clusters:
            v = day_counts.get(c, 0)
            matrix[c][i] = v
            seen += v
        # Other = total minus top clusters' share
        total = sum(day_counts.values())
        matrix["__other__"][i] = max(total - seen, 0)

    # Day totals + global y_max (round up to nearest 50)
    totals = [sum(matrix[c][i] for c in cluster_order) for i in range(n_days)]
    raw_max = max(totals) if totals else 1
    y_max = max(50, ((raw_max + 49) // 50) * 50)

    # X positions
    if n_days == 1:
        xs = [CHART_LEFT + CHART_W / 2]
    else:
        xs = [CHART_LEFT + i * CHART_W / (n_days - 1) for i in range(n_days)]
    y_scale = CHART_H / y_max

    # Cumulative for stacking, bottom to top
    bands = []
    cumulative_below = [0.0] * n_days
    for c_idx, cluster in enumerate(cluster_order):
        # top_y[i] = chart_bottom - (cumulative_below[i] + matrix[c][i]) * y_scale
        # bottom_y[i] = chart_bottom - cumulative_below[i] * y_scale
        top_pts = []
        bot_pts = []
        for i in range(n_days):
            below = cumulative_below[i]
            top = below + matrix[cluster][i]
            top_y = CHART_BOTTOM - top * y_scale
            bot_y = CHART_BOTTOM - below * y_scale
            top_pts.append(f"{xs[i]:.1f},{top_y:.1f}")
            bot_pts.append(f"{xs[i]:.1f},{bot_y:.1f}")
        # Polygon: top edge L→R, then bottom edge R→L
        polygon_pts = " ".join(top_pts + list(reversed(bot_pts)))
        label = "Other clusters" if cluster == "__other__" else shorten(cluster)
        color = COLORS[c_idx] if c_idx < len(COLORS) else "#A1A1AA"
        bands.append({
            "cluster": label,
            "color": color,
            "points": polygon_pts,
            "today_value": matrix[cluster][-1] if n_days else 0,
        })
        # Update cumulative
        for i in range(n_days):
            cumulative_below[i] += matrix[cluster][i]

    return bands, y_max


def build_x_labels(days: list[str]) -> list[dict]:
    """X-axis tick labels with positions in viewBox space."""
    n = len(days)
    if n == 0:
        return []
    if n == 1:
        return [{"x": CHART_LEFT + CHART_W / 2, "label": fmt_day(days[0])}]
    return [
        {
            "x": CHART_LEFT + i * CHART_W / (n - 1),
            "label": fmt_day(d),
        }
        for i, d in enumerate(days)
    ]


def fmt_day(iso: str) -> str:
    """2026-05-14 → 14 May."""
    return dt.date.fromisoformat(iso).strftime("%-d %b")


def build_y_ticks(y_max: int) -> list[dict]:
    """4 ticks: 0, 1/3, 2/3, max."""
    ticks = []
    for frac in (0.0, 1 / 3, 2 / 3, 1.0):
        v = int(round(y_max * frac))
        # Round to nearest 10 for readability
        v = round(v / 10) * 10
        y = CHART_BOTTOM - v * (CHART_H / y_max)
        ticks.append({"y": y, "label": f"{v}"})
    return ticks


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--top", type=int, default=4)
    ap.add_argument("--as-of", default=None, help="Anchor date (YYYY-MM-DD). Default: today.")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: db not found: {args.db}", file=sys.stderr)
        return 1

    as_of = args.as_of or dt.date.today().isoformat()
    counts = fetch_cluster_counts(args.db, args.days, as_of)

    # Sorted run-days inside window
    days = sorted(counts.keys())
    if not days:
        print(f"ERROR: no signal data in last {args.days} days", file=sys.stderr)
        return 2

    top_clusters = pick_top_clusters(counts, as_of, args.top)
    bands, y_max = build_bands(counts, days, top_clusters)
    x_ticks = build_x_labels(days)
    y_ticks = build_y_ticks(y_max)

    today_index = days.index(as_of) if as_of in days else len(days) - 1
    today_x = x_ticks[today_index]["x"]

    daily_totals = [
        sum(counts[d].get(c, 0) for c in counts[d]) for d in days
    ]
    today_total = daily_totals[today_index] if today_index < len(daily_totals) else 0
    avg_excl_today = (
        sum(t for i, t in enumerate(daily_totals) if i != today_index) /
        max(1, len(daily_totals) - 1)
    )
    delta_pct = ((today_total / avg_excl_today) - 1) * 100 if avg_excl_today else 0
    direction = "above" if delta_pct >= 0 else "below"

    block = {
        "eyebrow": (
            f"Figure 0 · 14-day cluster trajectory · today = {fmt_day(as_of)}"
        ),
        "x_ticks": x_ticks,
        "y_ticks": y_ticks,
        "today_index": today_index,
        "today_x": round(today_x, 1),
        "y_max": y_max,
        "chart_geometry": {
            "view_w": VIEW_W,
            "view_h": CHART_BOTTOM + PAD_BOTTOM,
            "chart_top": CHART_TOP,
            "chart_bottom": CHART_BOTTOM,
            "chart_left": CHART_LEFT,
            "chart_right": CHART_RIGHT,
        },
        "bands": bands,
        "caption": (
            f"Stacked daily signal volume across {len(days)} run-days in the last "
            f"{args.days} days ({fmt_day(days[0])}–{fmt_day(days[-1])}). Top {len(top_clusters)} "
            f"clusters of today are coloured; everything else folds into the grey 'Other' band. "
            f"Days with no market-signal collection are omitted from the x-axis. "
            f"Today is {abs(delta_pct):.0f}% {direction} the {len(days) - 1}-day mean."
        ),
    }

    yaml.safe_dump(block, sys.stdout, sort_keys=False, allow_unicode=True, width=120)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
