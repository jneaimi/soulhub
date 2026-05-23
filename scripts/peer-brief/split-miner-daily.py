#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# ///
"""split-miner-daily.py — Naseej peer-brief context splitter.

Shared peer-brief pipeline tooling (canonical home: scripts/peer-brief/).
Originated as the ADR-022 v2 splitter; now consumed by the ADR-034 rebuild
pipeline's build-context step.

Reads a Signal Forge miner-daily markdown file, splits it into structured
sections, and emits a JSON context object to stdout for downstream
inline-llm-pass calls.

Output schema (single JSON object on stdout):

    {
      "date": "2026-05-19",
      "title": "...",
      "summary_stats": { "signals": int, "posts": int, "transcripts": int, "platforms": int },
      "signal_summary": str,
      "topics": [{ "n": int, "title": str, "body": str }, ...],
      "pain_points": str,
      "breakthrough": { "title": str, "body": str },
      "content_opportunities": {
        "framework_pillar": str,
        "applied_pillar": str,
        "trends_pillar": str
      },
      "gcc_scorecard": str
    }

The downstream sharp-ask steps each take the full JSON as input_text and are
instructed via system_prompt to extract specific fields (e.g. "use topics[0]
for finding-1; reference gcc_scorecard for the FINDING N row").

Why one stdout blob vs N files: simpler recipe (every step references one
upstream output) + prompt-cache friendly (identical input_text across all
drafts hits the cache after the first cold call).

Usage:
    uv run scripts/peer-brief/split-miner-daily.py --miner-daily PATH
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
# Topic heading, tolerant of the daily LLM format drift. Matches the H2/H3
# shapes seen across the report corpus: `### 1. Title`, `### T1 — Title`,
# `## Trend 1 — Title ⚡ HIGH`. Group 1 = ordinal, group 2 = title.
TOPIC_RE = re.compile(
    r"^#{2,3}\s+(?:Trend\s+|Topic\s+|T)?(\d+)\s*[.):—–-]\s+(.+?)\s*$",
    re.MULTILINE,
)
# Same shape but anchored to a bare heading string (no leading #), for matching
# top-level H2 section headings that ARE topics (e.g. `Trend 1 — ...`).
TOPIC_HEADING_RE = re.compile(r"^(?:Trend\s+|Topic\s+|T)?(\d+)\s*[.):—–-]\s+(.+)$")
SUBSECTION_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
# Trailing strength/emoji noise to strip from a topic title.
_TITLE_NOISE_RE = re.compile(
    r"\s*[⚡\U0001F4CA\U0001F534\U0001F7E1\U0001F7E2].*$"
    r"|\s*\((?:views|GCC[^)]*)\)\s*$",
    re.IGNORECASE,
)
# Heading words that mark a SECTION delimiter, never a topic.
_TOPIC_EXCLUDE_WORDS = (
    "trending topic", "signal overview", "executive summary", "data snapshot",
    "data summary", "data intake", "pain point", "content", "gcc", "source",
    "database", "noise", "performance", "next step", "metadata", "recommendation",
    "quote", "finding", "assessment", "snapshot",
)


def _clean_topic_title(title: str) -> str:
    return _TITLE_NOISE_RE.sub("", title).strip().strip("*").strip()


def _is_section_heading(title: str) -> bool:
    t = title.lower()
    return any(w in t for w in _TOPIC_EXCLUDE_WORDS)
FRONTMATTER_RE = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.DOTALL)


def strip_frontmatter(text: str) -> str:
    """Drop a leading YAML frontmatter block so its metadata (e.g.
    `source_context: '... 22 posts, 18 transcripts, run_id 51'`) can't poison
    the body count scan (run_id 51 would otherwise read as transcripts=51)."""
    return FRONTMATTER_RE.sub("", text, count=1)


def find_section(sections: dict[str, str], *keywords: str) -> str:
    """Return the body of the first H2 whose heading contains ANY keyword
    (case-insensitive). The miner-daily is LLM-generated, so heading wording
    drifts day to day (`Pain Points` / `Pain Points Extracted` / `Top 10 Pain
    Points`); fuzzy matching survives that where exact `.get()` silently lost
    the section."""
    lowered = [k.lower() for k in keywords]
    for heading, body in sections.items():
        h = heading.lower()
        if any(k in h for k in lowered):
            return body
    return ""


def split_by_h2(text: str) -> dict[str, str]:
    """Return a dict keyed by H2 heading → body (text up to next H2 or EOF)."""
    sections: dict[str, str] = {}
    matches = list(SECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[heading] = text[body_start:body_end].strip()
    return sections


def split_by_h3(text: str) -> dict[str, str]:
    """Return a dict keyed by H3 heading → body. Used inside H2 blocks."""
    sub: dict[str, str] = {}
    matches = list(SUBSECTION_RE.finditer(text))
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sub[heading] = text[body_start:body_end].strip()
    return sub


def _topics_from_headings(scope: str) -> list[dict]:
    """Topic headings within `scope`, each body bounded by the next topic."""
    topics: list[dict] = []
    matches = list(TOPIC_RE.finditer(scope))
    for i, m in enumerate(matches):
        title = _clean_topic_title(m.group(2))
        if not title or _is_section_heading(title):
            continue
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(scope)
        topics.append({
            "n": int(m.group(1)),
            "title": title,
            "body": scope[body_start:body_end].strip(),
        })
    return topics


def _topics_from_h2_sections(sections: dict[str, str]) -> list[dict]:
    """Reports whose topics are top-level H2 sections (`## Trend 1 — ...`).
    The H2 body is the topic body."""
    topics: list[dict] = []
    for heading, body in sections.items():
        m = TOPIC_HEADING_RE.match(heading.strip())
        if not m:
            continue
        title = _clean_topic_title(m.group(2))
        if not title or _is_section_heading(title):
            continue
        topics.append({"n": int(m.group(1)), "title": title, "body": body})
    return topics


def _topics_from_table(scope: str) -> list[dict]:
    """Reports that list topics in a markdown table (`| N | Topic | ... |`).
    No per-topic body is available in this shape."""
    topics: list[dict] = []
    for line in scope.splitlines():
        cells = [c.strip() for c in line.split("|") if c.strip() != ""]
        if len(cells) >= 3 and cells[0].isdigit():
            name = cells[1].strip("* ").strip()
            if name and name.lower() not in ("topic", "rank"):
                topics.append({"n": int(cells[0]), "title": name, "body": ""})
    return topics


def parse_topics(
    trending_body: str,
    sections: dict[str, str] | None = None,
    full_body: str = "",
) -> list[dict]:
    """Parse trending topics into [{n, title, body}, ...], tolerant of the daily
    LLM format drift. Strategy order (first non-empty wins): headings inside the
    Trending Topics section -> top-level `## Trend N` H2 sections -> headings
    anywhere in the doc (covers reports whose section heading we did not match)
    -> a markdown topic table. The body is what the peer-brief draft uses for
    finding content, so heading strategies (which carry bodies) win over tables."""
    sections = sections or {}
    return (
        _topics_from_headings(trending_body)
        or _topics_from_h2_sections(sections)
        or _topics_from_headings(full_body)
        or _topics_from_table(trending_body or full_body)
    )


# Label-then-value patterns, anchored on the specific metric label so a number
# elsewhere on the line can't bind to the wrong metric. `[^\d\n]{0,16}` skips the
# separators every observed format uses (`:`, `**`, `|`, spaces) without crossing
# a newline or an intervening number. Tried in order; first hit per metric wins.
#   `**Posts analyzed:** 22`   `| Posts analyzed | 22 |`   `Posts analyzed: 22`
_STAT_LABEL_PATTERNS = {
    "signals": [r"market\s+signals?(?:\s+analy[sz]ed)?", r"signals?\s+analy[sz]ed"],
    "posts": [r"(?:influencer\s+)?posts?\s+analy[sz]ed", r"\bposts?\s+collected"],
    "transcripts": [r"transcripts?(?:\s+posts?)?"],
    "platforms": [r"platforms?"],
    "arabic_signals": [r"arabic(?:[\s-]+(?:signals?|content))?"],
}
# Value-then-label fallback (old cover-card inline: "287 signals · 5 posts").
_STAT_INLINE_PATTERNS = {
    "signals": r"(\d+)\s+(?:market\s+)?signals?\b",
    "posts": r"(\d+)\s+posts?\b",
    "transcripts": r"(\d+)\s+transcripts?\b",
    "platforms": r"(\d+)\s+platforms?\b",
}


def parse_summary_stats(body: str) -> dict:
    """Extract run counts from anywhere in the (frontmatter-stripped) body.

    The miner-daily is LLM-generated and its counts move around: a bold header
    line (`**Posts analyzed:** 22 | **Transcripts:** 18 | **Market signals:** 0`),
    a markdown table (`| Posts analyzed | 7 |`), or an old inline cover-card
    string (`287 signals · 5 posts`). They also live in the PREAMBLE between the
    H1 and the first H2, which `split_by_h2` discards, so we scan the full body
    rather than a single section. Each metric is anchored on its specific label;
    a missing metric stays 0.
    """
    stats = {"signals": 0, "posts": 0, "transcripts": 0, "platforms": 0, "arabic_signals": 0}

    for key, patterns in _STAT_LABEL_PATTERNS.items():
        for label in patterns:
            m = re.search(rf"{label}\b[^\d\n]{{0,16}}(\d+)", body, re.IGNORECASE)
            if m:
                stats[key] = int(m.group(1))
                break

    # Inline value-then-label fallback only for metrics still unset.
    for key, pat in _STAT_INLINE_PATTERNS.items():
        if stats[key] == 0:
            m = re.search(pat, body, re.IGNORECASE)
            if m:
                stats[key] = int(m.group(1))

    return stats


def parse_breakthrough(heading: str, body: str) -> dict:
    """Breakthrough's title sits in the H2 heading itself.

    Heading form: "Breakthrough Signal: The "..." as ..."
    Strip the prefix to recover the title.
    """
    title = heading
    prefix = "Breakthrough Signal:"
    if heading.lower().startswith(prefix.lower()):
        title = heading[len(prefix):].strip().lstrip(":").strip()
    return {"title": title, "body": body}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--miner-daily", required=True, help="Path to the miner-daily markdown")
    ns = p.parse_args()

    text = Path(ns.miner_daily).read_text(encoding="utf-8")
    body = strip_frontmatter(text)

    # Parse H1 for date + title
    h1_match = re.search(r"^#\s+(.+?)\s*$", body, re.MULTILINE)
    title = h1_match.group(1).strip() if h1_match else ""
    date_match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", title)
    date = date_match.group(1) if date_match else ""

    sections = split_by_h2(body)

    # Counts live in the preamble (between H1 and the first H2) and in formats
    # that drift daily, so scan the whole body, not a single section.
    stats = parse_summary_stats(body)

    # Section lookups are fuzzy because the LLM rewords headings every run.
    signal_summary = find_section(sections, "executive summary", "signal summary",
                                  "data summary", "data snapshot", "data intake")

    trending = find_section(sections, "trending topics", "trending", "top 5 trend")
    topics = parse_topics(trending, sections, body)

    pain_points = find_section(sections, "pain point")

    # Breakthrough heading is "Breakthrough Signal: ..." when present; the format
    # often omits it now, in which case the draft derives the hinge from topics.
    breakthrough_heading = next(
        (h for h in sections if "breakthrough" in h.lower()), None
    )
    breakthrough = (
        parse_breakthrough(breakthrough_heading, sections[breakthrough_heading])
        if breakthrough_heading
        else {"title": "", "body": ""}
    )

    content_opportunities_body = find_section(
        sections, "content angles", "content opportunities", "suggested content",
        "content angle",
    )
    pillars = split_by_h3(content_opportunities_body) if content_opportunities_body else {}
    framework_pillar = next((v for k, v in pillars.items() if "Framework" in k), "")
    applied_pillar = next((v for k, v in pillars.items() if "Applied" in k), "")
    trends_pillar = next((v for k, v in pillars.items() if "Trends" in k), "")

    gcc_scorecard = find_section(sections, "gcc relevance", "gcc market", "gcc")

    out = {
        "date": date,
        "title": title,
        "summary_stats": stats,
        "signal_summary": signal_summary,
        "topics": topics,
        "pain_points": pain_points,
        "breakthrough": breakthrough,
        "content_opportunities": {
            "framework_pillar": framework_pillar,
            "applied_pillar": applied_pillar,
            "trends_pillar": trends_pillar,
        },
        "gcc_scorecard": gcc_scorecard,
    }

    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
