#!/usr/bin/env python3
"""market-researcher block — Search market signals for trending topics.

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_MAX_TOPICS           — max topics to research (default: 2)
    BLOCK_CONFIG_PLATFORMS            — comma-separated platforms (default: twitter,reddit,youtube,linkedin,news,forums)
    BLOCK_CONFIG_PINNED_TOPIC         — always-included topic (default: "")
    BLOCK_CONFIG_INCLUDE_ARABIC_SEARCH — true/false (default: true)

Path resolution via:
    PIPELINE_DIR — root of the installed pipeline (contains db/, config/)
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ── Config from env ─────────────────────────────

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / "signals.db"
CONFIG_DIR = PIPELINE_DIR / "config"
OUTPUT_DIR = Path.home() / "SecondBrain" / "02-areas" / "pipelines" / "market-intel"
TEMP_DIR = Path("/tmp/prospector")
DATE = datetime.now().strftime("%Y-%m-%d")

MAX_TOPICS = int(os.environ.get("BLOCK_CONFIG_MAX_TOPICS", "2"))
PLATFORMS = os.environ.get("BLOCK_CONFIG_PLATFORMS", "twitter,reddit,youtube,linkedin,news,forums").split(",")
PINNED_TOPIC = os.environ.get("BLOCK_CONFIG_PINNED_TOPIC", "")
INCLUDE_ARABIC = os.environ.get("BLOCK_CONFIG_INCLUDE_ARABIC_SEARCH", "true").lower() == "true"

COLLECTOR = Path.home() / ".claude/skills/research/scripts/social_collector.py"
DB_SCRIPT_PATH = PIPELINE_DIR / "blocks" / "influencer-scanner" / "scout_db.py"
if not DB_SCRIPT_PATH.exists():
    DB_SCRIPT_PATH = PIPELINE_DIR / "scripts" / "scout_db.py"

PLATFORM_CMD = {
    "twitter": lambda q: ["twitter-search", q, "--pages", "1", "--compact", "--dedup"],
    "reddit": lambda q: ["reddit-search", q, "--compact", "--dedup"],
    "youtube": lambda q: ["youtube-search", q, "--pages", "1", "--compact"],
    "linkedin": lambda q: ["linkedin-search", q, "--sort", "most_recent", "--compact"],
    "news": lambda q: ["news-search", q, "--time", "7d", "--compact"],
    "forums": lambda q: ["forums-search", q, "--time", "week", "--compact"],
}

ARABIC_TERMS = {
    "ai": "ذكاء اصطناعي",
    "ai agent": "وكيل ذكاء اصطناعي",
    "ai agents": "وكلاء ذكاء اصطناعي",
    "automation": "أتمتة",
    "pain point": "مشكلة",
    "problem": "مشكلة",
    "tool": "أداة",
    "tools": "أدوات",
    "workflow": "سير عمل",
    "coding": "برمجة",
    "memory": "ذاكرة",
    "gcc": "الخليج",
    "uae": "الإمارات",
    "saudi": "السعودية",
    "business": "أعمال",
    "startup": "شركة ناشئة",
    "enterprise": "مؤسسات",
    "platform": "منصة",
    "market": "سوق",
    "trend": "اتجاه",
    "opportunity": "فرصة",
}


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def run_cmd(cmd: list[str], timeout: int = 45) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# ── Topic extraction from Miner report ─────────

def find_latest_miner_report() -> Path | None:
    reports = sorted(OUTPUT_DIR.glob("*miner-report.md"), reverse=True)
    if not reports:
        reports = sorted(OUTPUT_DIR.glob("*miner-daily.md"), reverse=True)
    return reports[0] if reports else None


def extract_topics(report_path: Path, max_topics: int) -> list[dict]:
    text = report_path.read_text()
    topics = []

    pattern = re.compile(
        r"^###\s+\d+\.\s+(.+?)$\s*"
        r"(?:\*\*[^*]*\*\*[^\n]*\n)*"
        r".*?(?:\*\*Signal strength:\*\*\s*[🔴🟡🟢]*\s*(HIGH|MEDIUM|LOW))?",
        re.MULTILINE,
    )

    for match in pattern.finditer(text):
        topic_name = match.group(1).strip()
        strength = match.group(2) or "MEDIUM"
        topics.append({"name": topic_name, "strength": strength})

    strength_order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    topics.sort(key=lambda t: strength_order.get(t["strength"], 1))

    return topics[:max_topics]


# ── Query generation ───────────────────────────

def generate_queries(topic_name: str, include_arabic: bool) -> list[tuple[str, str]]:
    queries = [(topic_name, "en")]

    core = topic_name.split("—")[0].split("(")[0].strip()
    if len(core.split()) <= 6:
        queries.append((f"{core} problems challenges", "en"))
    else:
        short = " ".join(core.split()[:4])
        queries.append((f"{short} problems", "en"))

    if include_arabic:
        arabic_query = _to_arabic_query(topic_name)
        if arabic_query:
            queries.append((arabic_query, "ar"))

    return queries


def _to_arabic_query(topic: str) -> str:
    topic_lower = topic.lower()
    arabic_parts = []
    matched = set()
    for en, ar in sorted(ARABIC_TERMS.items(), key=lambda x: -len(x[0])):
        if en in topic_lower and en not in matched:
            arabic_parts.append(ar)
            matched.add(en)
            for word in en.split():
                matched.add(word)
    return " ".join(arabic_parts) if arabic_parts else ""


# ── Fetch and ingest ───────────────────────────

def fetch_and_ingest(topics: list[dict], platforms: list[str], include_arabic: bool) -> dict:
    stats = {"searches": 0, "signals_inserted": 0, "signals_updated": 0, "errors": []}

    total_steps = sum(
        len(generate_queries(t["name"], include_arabic)) * len(platforms)
        for t in topics
    )
    step = 0

    for topic in topics:
        topic_name = topic["name"]
        queries = generate_queries(topic_name, include_arabic)

        log(f"[TOPIC] {topic_name} ({topic['strength']}) — {len(queries)} queries x {len(platforms)} platforms")

        for query, lang in queries:
            for platform in platforms:
                step += 1
                cmd_fn = PLATFORM_CMD.get(platform)
                if not cmd_fn:
                    continue

                log(f"  [{step}/{total_steps}] {platform}/{lang}: {query[:50]}...")

                slug = re.sub(r"[^a-zA-Z0-9]", "_", f"{topic_name[:20]}_{platform}_{lang}")
                outfile = TEMP_DIR / f"{slug}.json"

                try:
                    fetch = run_cmd(
                        ["uv", "run", str(COLLECTOR)] + cmd_fn(query),
                        timeout=45,
                    )
                except subprocess.TimeoutExpired:
                    stats["errors"].append(f"{platform}/{lang} '{query[:30]}': timeout")
                    log("    [TIMEOUT]")
                    continue

                if fetch.returncode != 0:
                    stats["errors"].append(f"{platform}/{lang}: {fetch.stderr[:80].strip()}")
                    log("    [ERROR] fetch failed")
                    continue

                if not fetch.stdout.strip():
                    log("    [WARN] empty response")
                    continue

                outfile.write_text(fetch.stdout)
                stats["searches"] += 1

                try:
                    ingest = run_cmd([
                        "uv", "run", str(DB_SCRIPT_PATH), "ingest-market", str(outfile),
                        "--topic", topic_name,
                        "--platform", platform,
                        "--query", query,
                        "--language", lang,
                    ], timeout=30)
                except subprocess.TimeoutExpired:
                    stats["errors"].append(f"{platform}/{lang} ingest timeout")
                    log("    [TIMEOUT] ingest")
                    continue

                if ingest.returncode == 0:
                    try:
                        r = json.loads(ingest.stdout)
                        inserted = r.get("inserted", 0)
                        updated = r.get("updated", 0)
                        stats["signals_inserted"] += inserted
                        stats["signals_updated"] += updated
                        log(f"    +{inserted} new, {updated} updated")
                    except json.JSONDecodeError:
                        log("    [WARN] ingest output not JSON")
                else:
                    stats["errors"].append(f"{platform}/{lang} ingest: {ingest.stderr[:60]}")
                    log("    [ERROR] ingest failed")

    return stats


# ── Main ───────────────────────────────────────

def main():
    start_time = time.time()
    log(f"Market Researcher starting — {DATE}")

    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    report = find_latest_miner_report()
    if not report:
        log("[ERROR] No Miner report found — run the Miner first")
        sys.exit(1)

    log(f"Source: {report.name}")
    topics = extract_topics(report, MAX_TOPICS)

    if not topics:
        log("[ERROR] No topics extracted from Miner report")
        sys.exit(1)

    if PINNED_TOPIC:
        existing_names = {t["name"].lower() for t in topics}
        if PINNED_TOPIC.lower() not in existing_names:
            topics.append({"name": PINNED_TOPIC, "strength": "PINNED"})
            log(f"Added pinned topic: {PINNED_TOPIC}")

    log(f"Topics: {len(topics)} | Platforms: {', '.join(PLATFORMS)} | Arabic: {INCLUDE_ARABIC}")
    for i, t in enumerate(topics, 1):
        log(f"  {i}. {t['name']} ({t['strength']})")

    stats = fetch_and_ingest(topics=topics, platforms=PLATFORMS, include_arabic=INCLUDE_ARABIC)

    try:
        summary_result = run_cmd(
            ["uv", "run", str(DB_SCRIPT_PATH), "market-summary", "--days", "1"],
            timeout=15,
        )
        if summary_result.returncode == 0:
            market_summary = json.loads(summary_result.stdout)
            total_signals = market_summary.get("signals_last_n_days", "?")
        else:
            total_signals = stats["signals_inserted"] + stats["signals_updated"]
    except Exception:
        total_signals = stats["signals_inserted"] + stats["signals_updated"]

    elapsed = int(time.time() - start_time)

    log("=" * 40)
    log(f"Market Researcher complete — {elapsed // 60}m{elapsed % 60}s")
    log(f"  Topics: {len(topics)}")
    log(f"  Searches: {stats['searches']}")
    log(f"  Signals: +{stats['signals_inserted']} new, {stats['signals_updated']} updated")
    log(f"  Total signals today: {total_signals}")
    if stats["errors"]:
        log(f"  Errors: {len(stats['errors'])}")
        for err in stats["errors"][:5]:
            log(f"    - {err}")
        if len(stats["errors"]) > 5:
            log(f"    ... and {len(stats['errors']) - 5} more")
    log("=" * 40)

    print(json.dumps({
        "date": DATE,
        "topics": len(topics),
        "searches": stats["searches"],
        "signals_inserted": stats["signals_inserted"],
        "signals_updated": stats["signals_updated"],
        "errors": len(stats["errors"]),
        "elapsed_seconds": elapsed,
    }))


if __name__ == "__main__":
    main()
