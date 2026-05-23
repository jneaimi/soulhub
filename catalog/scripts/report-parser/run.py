#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Parse a Miner report (markdown) and insert findings into the DB.

Bridges the gap: the Miner writes great markdown reports but struggles with
structured JSON insertion. This script reads the report, extracts findings,
and stores them in the intelligence layer.

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_RUN_MODE — daily or weekly (default: daily)

Path resolution via:
    PIPELINE_DIR — root of the installed pipeline (contains db/)

Usage:
    run.py <report.md>
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# ── Path resolution via PIPELINE_DIR ─────────────
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = str(PIPELINE_DIR / "db" / "signals.db")

RUN_MODE = os.environ.get("BLOCK_CONFIG_RUN_MODE", "daily")


def get_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.row_factory = sqlite3.Row
    return db


def parse_frontmatter(text):
    """Extract YAML frontmatter values."""
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    fm = {}
    for line in parts[1].strip().split("\n"):
        if ":" in line:
            key, val = line.split(":", 1)
            fm[key.strip()] = val.strip()
    return fm


def extract_trending_topics(text):
    """Extract trending topics from ### headers in the Trending Topics section."""
    findings = []
    sections = re.split(r'^## ', text, flags=re.MULTILINE)
    trending_section = ""
    for s in sections:
        if "Trending" in s.split("\n")[0] or "Findings" in s.split("\n")[0] or "Top" in s.split("\n")[0] and "Topic" in s.split("\n")[0]:
            trending_section = s
            break

    if not trending_section:
        return findings

    topics = re.split(r'^###\s+\d+\.\s*', trending_section, flags=re.MULTILINE)
    for topic in topics[1:]:
        lines = topic.strip().split("\n")
        if not lines:
            continue

        title = lines[0].strip().rstrip(" —").strip()
        title = re.sub(r'\*\*', '', title)
        title = title.split("—")[0].strip() if "—" in title else title

        strength = "medium"
        full_text = "\n".join(lines)
        if "HIGH" in full_text.upper() or "\U0001f525" in full_text:
            strength = "high"
        elif "LOW" in full_text.upper():
            strength = "low"

        pillar = ""
        pillar_match = re.search(r'[Pp]illar[:\s]*(?:map:?)?\s*(\w+)', full_text)
        if pillar_match:
            p = pillar_match.group(1).lower()
            if p in ("framework", "applied", "trends"):
                pillar = p

        engagement = 0
        view_match = re.search(r'([\d,]+)\s*views', full_text)
        if view_match:
            engagement = int(view_match.group(1).replace(",", ""))

        source_count = len(re.findall(r'@\w+|post[_ ]#?\d|signal|post_id', full_text, re.IGNORECASE))

        angle = ""
        angle_match = re.search(r'[Aa]ngle[:\s]+(.+?)(?:\n|$)', full_text)
        if angle_match:
            angle = angle_match.group(1).strip()

        quotes = re.findall(r'>\s*\*"(.+?)"\*', full_text)
        evidence = []
        for q in quotes[:3]:
            evidence.append({"quote": q[:200]})

        findings.append({
            "type": "trend",
            "title": title[:200],
            "description": "\n".join(lines[1:5]).strip()[:500],
            "evidence": evidence,
            "pillar": pillar,
            "signal_strength": strength,
            "engagement_total": engagement,
            "source_count": max(source_count, 1),
            "suggested_angle": angle[:300],
        })

    return findings


def extract_pain_points(text):
    """Extract pain points from the Pain Points section."""
    findings = []
    sections = re.split(r'^## ', text, flags=re.MULTILINE)
    pain_section = ""
    for s in sections:
        if "Pain Point" in s:
            pain_section = s
            break

    if not pain_section:
        return findings

    rows = re.findall(r'\|\s*\d+\s*\|(.+?)\|(.+?)\|(.+?)\|', pain_section)
    for row in rows:
        title = row[0].strip().strip("*").strip('"').strip()
        source = row[1].strip()
        strength = row[2].strip().lower()

        findings.append({
            "type": "pain_point",
            "title": title[:200],
            "description": f"Source: {source}",
            "evidence": [],
            "pillar": "",
            "signal_strength": "high" if "strong" in strength else "medium",
            "engagement_total": 0,
            "source_count": 1,
            "suggested_angle": "",
        })

    if not rows:
        points = re.split(r'^### \d+\.\s*', pain_section, flags=re.MULTILINE)
        for point in points[1:]:
            lines = point.strip().split("\n")
            title = lines[0].strip().strip('"').strip("*").strip()
            findings.append({
                "type": "pain_point",
                "title": title[:200],
                "description": "\n".join(lines[1:3]).strip()[:500],
                "evidence": [],
                "signal_strength": "medium",
                "source_count": 1,
            })

    return findings


def extract_opportunities(text):
    """Extract content opportunities."""
    opps = []
    sections = re.split(r'^## ', text, flags=re.MULTILINE)
    opp_section = ""
    for s in sections:
        header = s.split("\n")[0]
        if "Content" in header and ("Opportunit" in header or "Angle" in header or "Suggest" in header):
            opp_section = s
            break
        if "Opportunit" in header:
            opp_section = s
            break

    if not opp_section:
        return opps

    entries = re.split(r'^###\s+|^\*\*[A-Z]\.\s*', opp_section, flags=re.MULTILINE)
    if len(entries) <= 1:
        entries = re.split(r'^\*\*[^*]+\*\*', opp_section, flags=re.MULTILINE)
        bold_titles = re.findall(r'^\*\*([^*]+)\*\*', opp_section, flags=re.MULTILINE)
        if bold_titles:
            for bt in bold_titles:
                opps.append({
                    "category": "content",
                    "title": bt.strip()[:200],
                    "description": "",
                    "target_market": "gcc" if "gcc" in opp_section.lower() else "",
                    "priority": "high" if "High" in opp_section.split(bt)[0] else "medium",
                })
            return opps
    for entry in entries[1:]:
        lines = entry.strip().split("\n")
        if not lines:
            continue
        title = lines[0].strip().strip("*").strip('"').strip()
        if not title or len(title) < 5:
            continue

        priority = "medium"
        full = "\n".join(lines)
        if "High Priority" in opp_section.split(entry)[0] if entry in opp_section else "":
            priority = "high"

        pillar_match = re.search(r'[Pp]illar[:\s]+(\w+)', full)
        pillar = pillar_match.group(1).lower() if pillar_match else ""

        market = "gcc" if "gcc" in full.lower() or "GCC" in full else ""

        opps.append({
            "category": "content",
            "title": title[:200],
            "description": "\n".join(lines[1:3]).strip()[:500],
            "target_market": market,
            "priority": priority,
        })

    return opps


def extract_gcc_relevance(text):
    """Extract GCC relevance info."""
    sections = re.split(r'^## ', text, flags=re.MULTILINE)
    for s in sections:
        if "GCC" in s:
            if "HIGH" in s.upper() or "strong" in s.lower():
                return "high", s[:300]
            elif "MEDIUM" in s.upper() or "thin" in s.lower() or "warm" in s.lower():
                return "medium", s[:300]
            else:
                return "low", s[:300]
    return "none", ""


def main():
    parser = argparse.ArgumentParser(description="Parse Miner report into DB findings")
    parser.add_argument("report", help="Path to miner report markdown file")
    parser.add_argument("--run-mode", default=None, help="Run mode (daily/weekly)")
    args = parser.parse_args()

    run_mode = args.run_mode or RUN_MODE

    text = open(args.report).read()
    fm = parse_frontmatter(text)
    run_date = fm.get("created", datetime.now().strftime("%Y-%m-%d"))

    db = get_db()

    try:
        db.execute("INSERT INTO analysis_runs (run_date, mode) VALUES (?, ?)", (run_date, run_mode))
    except sqlite3.IntegrityError:
        db.execute("UPDATE analysis_runs SET created_at = datetime('now') WHERE run_date = ? AND mode = ?", (run_date, run_mode))
    db.commit()
    run_id = db.execute("SELECT id FROM analysis_runs WHERE run_date = ? AND mode = ?", (run_date, run_mode)).fetchone()["id"]

    trends = extract_trending_topics(text)
    pain_points = extract_pain_points(text)
    opportunities = extract_opportunities(text)
    gcc_relevance, gcc_context = extract_gcc_relevance(text)

    total_findings = 0
    finding_ids = []

    for f in trends + pain_points:
        cur = db.execute(
            """INSERT INTO findings (run_id, type, title, description, evidence, pillar,
               signal_strength, engagement_total, source_count, suggested_angle)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, f.get("type", "trend"), f["title"], f.get("description", ""),
             json.dumps(f.get("evidence", [])), f.get("pillar", ""),
             f.get("signal_strength", "medium"), f.get("engagement_total", 0),
             f.get("source_count", 0), f.get("suggested_angle", ""))
        )
        fid = cur.lastrowid
        finding_ids.append(fid)
        total_findings += 1

        if gcc_relevance != "none":
            try:
                db.execute(
                    "INSERT INTO market_scores (finding_id, market, relevance, context) VALUES (?, 'gcc', ?, ?)",
                    (fid, gcc_relevance, gcc_context[:500])
                )
            except sqlite3.IntegrityError:
                pass

    total_opps = 0
    for opp in opportunities:
        linked_finding = finding_ids[0] if finding_ids else None
        db.execute(
            """INSERT INTO opportunities (finding_id, category, title, description, target_market, priority)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (linked_finding, opp["category"], opp["title"], opp.get("description", ""),
             opp.get("target_market", ""), opp.get("priority", "medium"))
        )
        total_opps += 1

    db.execute(
        "UPDATE analysis_runs SET findings_created = ? WHERE id = ?",
        (total_findings, run_id)
    )

    db.commit()
    db.close()

    print(json.dumps({
        "run_id": run_id,
        "run_date": run_date,
        "trends": len(trends),
        "pain_points": len(pain_points),
        "opportunities": total_opps,
        "total_findings": total_findings,
        "gcc_relevance": gcc_relevance,
    }))


if __name__ == "__main__":
    main()
