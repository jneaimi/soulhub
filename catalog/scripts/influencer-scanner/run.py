#!/usr/bin/env python3
"""influencer-scanner block — Fetch influencer posts and store in DB.

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_LOOKBACK_DAYS  — days to look back (default: 3)
    BLOCK_CONFIG_PLATFORMS      — comma-separated platforms (default: tiktok,youtube,twitter,linkedin)
    BLOCK_CONFIG_SKIP_COMMENTS  — true/false (default: false)
    BLOCK_CONFIG_SKIP_TRANSCRIPTS — true/false (default: false)

Path resolution via:
    PIPELINE_DIR — root of the installed pipeline (contains db/, config/)
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ── Config from env ─────────────────────────────

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / "signals.db"
CONFIG_DIR = PIPELINE_DIR / "config"
ROSTER_PATH = CONFIG_DIR / "influencer-roster.md"
SCRIPTS_DIR = PIPELINE_DIR / "blocks" / "influencer-scanner"
TEMP_DIR = Path("/tmp/scout")
DATE = datetime.now().strftime("%Y-%m-%d")

LOOKBACK_DAYS = int(os.environ.get("BLOCK_CONFIG_LOOKBACK_DAYS", "3"))
PLATFORMS = os.environ.get("BLOCK_CONFIG_PLATFORMS", "tiktok,youtube,twitter,linkedin").split(",")
SKIP_COMMENTS = os.environ.get("BLOCK_CONFIG_SKIP_COMMENTS", "false").lower() == "true"
SKIP_TRANSCRIPTS = os.environ.get("BLOCK_CONFIG_SKIP_TRANSCRIPTS", "false").lower() == "true"

COLLECTOR = Path.home() / ".claude/skills/research/scripts/social_collector.py"
DB_SCRIPT_PATH = PIPELINE_DIR / "blocks" / "influencer-scanner" / "scout_db.py"
# Fallback: if scout_db.py is not bundled, look in the archive
if not DB_SCRIPT_PATH.exists():
    DB_SCRIPT_PATH = PIPELINE_DIR / "scripts" / "scout_db.py"

PLATFORM_CMD = {
    "tiktok": lambda h: ["tiktok-search", h, "--sort", "most_recent", "--time-range", "1", "--pages", "1", "--compact"],
    "youtube": lambda h: ["youtube-search", h, "--upload-date", "today", "--pages", "1", "--compact"],
    "twitter": lambda h: ["twitter-tweets", h, "--pages", "1", "--compact"],
    "linkedin": lambda h: ["linkedin-search", h, "--sort", "most_recent", "--compact"],
    "instagram": lambda h: ["instagram-search", h, "--pages", "1", "--compact"],
    "reddit": lambda h: ["reddit-search", h, "--compact"],
}

COMMENT_PLATFORMS = {"youtube"}


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def run_cmd(cmd: list[str], timeout: int = 60, stdin_data: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, input=stdin_data, capture_output=True, text=True, timeout=timeout)


# ── Step 1: Parse roster ───────────────────────

def parse_roster() -> list[dict]:
    text = ROSTER_PATH.read_text()
    roster = []
    in_table = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("| Handle"):
            in_table = True
            continue
        if in_table and line.startswith("| ---"):
            continue
        if in_table and line.startswith("|"):
            cols = [c.strip() for c in line.split("|")[1:-1]]
            if len(cols) >= 4:
                roster.append({
                    "handle": cols[0],
                    "platform": cols[1],
                    "focus": cols[2],
                    "why_follow": cols[3],
                })
        elif in_table and not line.startswith("|"):
            break
    return roster


# ── Step 2: Sync roster to DB ──────────────────

def sync_roster(roster: list[dict]) -> bool:
    roster_file = TEMP_DIR / "roster.json"
    roster_file.write_text(json.dumps(roster, indent=2))
    result = run_cmd(["uv", "run", str(DB_SCRIPT_PATH), "sync-roster", str(roster_file)])
    if result.returncode != 0:
        log(f"[ERROR] Roster sync failed: {result.stderr[:200]}")
        return False
    log(f"[OK] Roster synced ({len(roster)} influencers)")
    return True


# ── Step 3: Fetch and ingest posts ─────────────

def fetch_and_ingest(roster: list[dict], lookback: int) -> dict:
    stats = {"total": 0, "inserted": 0, "updated": 0, "errors": []}

    for i, inf in enumerate(roster, 1):
        handle = inf["handle"]
        platform = inf["platform"]

        if platform not in PLATFORMS:
            continue

        cmd_args = PLATFORM_CMD.get(platform)
        if not cmd_args:
            log(f"[SKIP] {i}/{len(roster)} Unknown platform: {platform}")
            continue

        log(f"[STEP] {i}/{len(roster)} Fetching @{handle} on {platform}")

        safe_handle = handle.replace(" ", "_").replace("/", "_")
        outfile = TEMP_DIR / f"{safe_handle}_{platform}.json"

        try:
            fetch_cmd = ["uv", "run", str(COLLECTOR)] + cmd_args(handle)
            fetch = run_cmd(fetch_cmd, timeout=45)
        except subprocess.TimeoutExpired:
            err = f"@{handle} ({platform}): fetch timeout"
            log(f"  [TIMEOUT] {err}")
            stats["errors"].append(err)
            continue

        if fetch.returncode != 0:
            err = f"@{handle} ({platform}): fetch failed — {fetch.stderr[:100].strip()}"
            log(f"  [ERROR] {err}")
            stats["errors"].append(err)
            continue

        if not fetch.stdout.strip():
            log(f"  [WARN] @{handle}: empty response")
            stats["errors"].append(f"@{handle} ({platform}): empty response")
            continue

        outfile.write_text(fetch.stdout)

        try:
            ingest = run_cmd([
                "uv", "run", str(DB_SCRIPT_PATH), "ingest", str(outfile),
                "--handle", handle,
                "--platform", platform,
                "--lookback-days", str(lookback),
            ], timeout=30)
        except subprocess.TimeoutExpired:
            err = f"@{handle} ({platform}): ingest timeout"
            log(f"  [TIMEOUT] {err}")
            stats["errors"].append(err)
            continue

        if ingest.returncode == 0:
            try:
                r = json.loads(ingest.stdout)
                inserted = r.get("inserted", 0)
                updated = r.get("updated", 0)
                stats["inserted"] += inserted
                stats["updated"] += updated
                stats["total"] += inserted + updated
                log(f"  +{inserted} new, {updated} updated")
            except json.JSONDecodeError:
                log(f"  [WARN] ingest output not JSON: {ingest.stdout[:100]}")
        else:
            err = f"@{handle} ({platform}): ingest failed — {ingest.stderr[:100].strip()}"
            log(f"  [ERROR] {err}")
            stats["errors"].append(err)

    return stats


# ── Step 4: Fetch transcripts ──────────────────

def fetch_transcripts() -> int:
    log("[STEP] Fetching YouTube transcripts")
    try:
        result = run_cmd(["uv", "run", str(DB_SCRIPT_PATH), "fetch-transcripts"], timeout=120)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                count = data.get("fetched", data.get("transcripts_fetched", 0))
                log(f"  Transcripts fetched: {count}")
                return count
            except (json.JSONDecodeError, AttributeError):
                log(f"  Transcripts done: {result.stdout.strip()[:100]}")
                return 0
        else:
            log(f"  [WARN] Transcript fetch failed: {result.stderr[:100]}")
            return 0
    except subprocess.TimeoutExpired:
        log("  [TIMEOUT] Transcript fetch exceeded 120s")
        return 0


# ── Step 5: Fetch comments ─────────────────────

def fetch_comments(lookback: int) -> int:
    log("[STEP] Fetching YouTube comments")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT p.id, p.platform_post_id, i.handle, p.content,
               (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE i.platform = 'youtube'
          AND p.fetched_at >= datetime('now', ? || ' days')
          AND p.platform_post_id IS NOT NULL
          AND p.platform_post_id != ''
        ORDER BY p.fetched_at DESC
    """, (f"-{lookback}",)).fetchall()

    conn.close()

    to_fetch = [r for r in rows if r["comment_count"] < 5]

    if not to_fetch:
        log("  No posts need comments")
        return 0

    total_comments = 0
    for row in to_fetch:
        post_id = row["id"]
        raw_id = row["platform_post_id"]
        handle = row["handle"]

        video_id = raw_id
        if "watch?v=" in raw_id:
            video_id = raw_id.split("watch?v=")[1].split("&")[0]
        elif "youtu.be/" in raw_id:
            video_id = raw_id.split("youtu.be/")[1].split("?")[0]

        log(f"  Fetching comments for @{handle} ({video_id})")

        try:
            fetch = run_cmd([
                "uv", "run", str(COLLECTOR),
                "yt-comments",
                "--pages", "1",
                "--order", "relevance",
                "--compact",
                "--", video_id,
            ], timeout=30)
        except subprocess.TimeoutExpired:
            log(f"    [TIMEOUT] Comment fetch for {video_id}")
            continue

        if fetch.returncode != 0:
            log(f"    [ERROR] {fetch.stderr[:80].strip()}")
            continue

        try:
            data = json.loads(fetch.stdout)
            raw_comments = data.get("results", data.get("comments", []))
        except json.JSONDecodeError:
            log("    [WARN] Invalid JSON response")
            continue

        comments = []
        spam_words = ["subscribe", "follow me", "check my", "visit my", "click here"]
        for c in raw_comments:
            text = c.get("text", c.get("content", c.get("snippet", "")))
            if not text or len(text.split()) < 5:
                continue
            if any(w in text.lower() for w in spam_words):
                continue
            comments.append({
                "author": c.get("author", c.get("username", "unknown")),
                "content": text,
                "likes": int(c.get("likes", c.get("like_count", 0)) or 0),
            })

        if not comments:
            log("    No quality comments found")
            continue

        payload = json.dumps({"post_id": post_id, "comments": comments})
        try:
            insert = run_cmd(
                ["uv", "run", str(DB_SCRIPT_PATH), "insert-comments", "-"],
                timeout=15,
                stdin_data=payload,
            )
            if insert.returncode == 0:
                log(f"    Stored {len(comments)} comments")
                total_comments += len(comments)
            else:
                log(f"    [ERROR] Insert failed: {insert.stderr[:80]}")
        except subprocess.TimeoutExpired:
            log(f"    [TIMEOUT] Comment insert for {video_id}")

    return total_comments


# ── Step 6: Summary ────────────────────────────

def get_summary() -> dict:
    try:
        result = run_cmd(["uv", "run", str(DB_SCRIPT_PATH), "summary"], timeout=15)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception:
        pass
    return {}


# ── Main ───────────────────────────────────────

def main():
    start_time = time.time()
    log(f"Influencer Scanner starting — {DATE}")

    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    if not DB_PATH.exists():
        log("[INIT] Creating database")
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        run_cmd(["uv", "run", str(DB_SCRIPT_PATH), "init"])

    roster = parse_roster()
    log(f"Roster: {len(roster)} influencers | Lookback: {LOOKBACK_DAYS}d | Platforms: {','.join(PLATFORMS)}")

    if not sync_roster(roster):
        log("[ABORT] Roster sync failed")
        sys.exit(1)

    ingest_stats = fetch_and_ingest(roster, LOOKBACK_DAYS)
    log(f"[OK] Posts: +{ingest_stats['inserted']} new, {ingest_stats['updated']} updated")

    if not SKIP_TRANSCRIPTS:
        fetch_transcripts()

    comments_stored = 0
    if not SKIP_COMMENTS:
        comments_stored = fetch_comments(LOOKBACK_DAYS)
        log(f"[OK] Comments: {comments_stored} stored")

    summary = get_summary()
    elapsed = int(time.time() - start_time)

    log("=" * 40)
    log(f"Influencer Scanner complete — {elapsed // 60}m{elapsed % 60}s")
    log(f"  Posts today: {summary.get('posts_today', '?')}")
    log(f"  Ingested: +{ingest_stats['inserted']} new, {ingest_stats['updated']} updated")
    log(f"  Comments: {comments_stored} new")
    if ingest_stats["errors"]:
        log(f"  Errors: {len(ingest_stats['errors'])}")
        for err in ingest_stats["errors"]:
            log(f"    - {err}")
    log("=" * 40)

    print(json.dumps({
        "date": DATE,
        "posts_today": summary.get("posts_today", 0),
        "inserted": ingest_stats["inserted"],
        "updated": ingest_stats["updated"],
        "comments_stored": comments_stored,
        "errors": len(ingest_stats["errors"]),
        "elapsed_seconds": elapsed,
    }))


if __name__ == "__main__":
    main()
