#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["youtube-transcript-api"]
# ///
"""
Market Intel database manager.

Path resolution via:
    PIPELINE_DIR — root of the installed pipeline (contains db/)

Usage:
    run.py init                              Initialize DB schema
    run.py sync-roster <roster.json>         Sync influencers from JSON
    run.py insert-post <post.json>           Insert a post (deduplicates)
    run.py bulk-insert <posts.json>          Insert many posts at once (preferred)
    run.py insert-comments <comments.json>   Insert comments for a post
    run.py ingest <raw.json> --handle H --platform P   Parse social_collector output + bulk insert
    run.py ingest-market <raw.json> --topic T --platform P --query Q  Ingest market signals
    run.py summary                           Show DB stats
    run.py latest [--days N]                 Show latest posts (default: 1 day)
    run.py market-summary [--days N]         Show market signal stats
    run.py log-run                           Log an analysis run (returns run_id)
    run.py add-finding <finding.json>        Add finding(s) with dedup
    run.py update-run <run_id>               Update run stats
    run.py mark-mined                        Mark data as processed
    run.py unmined                           Show count of unprocessed data
    run.py findings-summary [--days N]       Findings breakdown
    run.py fetch-transcripts                 Fetch YouTube transcripts
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ── Path resolution via PIPELINE_DIR ─────────────
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = str(PIPELINE_DIR / "db" / "signals.db")


def get_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.row_factory = sqlite3.Row
    return db


def cmd_init(_args):
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS influencers (
            id INTEGER PRIMARY KEY,
            handle TEXT NOT NULL,
            platform TEXT NOT NULL,
            focus TEXT,
            why_follow TEXT,
            added_at TEXT DEFAULT (datetime('now')),
            active INTEGER DEFAULT 1,
            UNIQUE(handle, platform)
        );

        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY,
            influencer_id INTEGER REFERENCES influencers(id),
            platform_post_id TEXT,
            url TEXT,
            content TEXT,
            transcript TEXT,
            post_date TEXT,
            fetched_at TEXT DEFAULT (datetime('now')),
            views INTEGER DEFAULT 0,
            likes INTEGER DEFAULT 0,
            comments_count INTEGER DEFAULT 0,
            shares INTEGER DEFAULT 0,
            UNIQUE(influencer_id, platform_post_id)
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY,
            post_id INTEGER REFERENCES posts(id),
            author TEXT,
            content TEXT,
            likes INTEGER DEFAULT 0,
            fetched_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_posts_fetched ON posts(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_posts_influencer ON posts(influencer_id);
        CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

        CREATE TABLE IF NOT EXISTS market_searches (
            id INTEGER PRIMARY KEY,
            query TEXT NOT NULL,
            platform TEXT NOT NULL,
            language TEXT DEFAULT 'en',
            topic TEXT,
            searched_at TEXT DEFAULT (datetime('now')),
            result_count INTEGER DEFAULT 0,
            UNIQUE(query, platform, language)
        );

        CREATE TABLE IF NOT EXISTS market_signals (
            id INTEGER PRIMARY KEY,
            search_id INTEGER REFERENCES market_searches(id),
            platform TEXT NOT NULL,
            author TEXT,
            content TEXT,
            url TEXT,
            post_date TEXT,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            shares INTEGER DEFAULT 0,
            fetched_at TEXT DEFAULT (datetime('now')),
            platform_post_id TEXT,
            UNIQUE(platform, platform_post_id)
        );

        CREATE INDEX IF NOT EXISTS idx_market_signals_search ON market_signals(search_id);
        CREATE INDEX IF NOT EXISTS idx_market_signals_fetched ON market_signals(fetched_at);
        CREATE INDEX IF NOT EXISTS idx_market_searches_topic ON market_searches(topic);

        CREATE TABLE IF NOT EXISTS analysis_runs (
            id INTEGER PRIMARY KEY,
            run_date TEXT NOT NULL,
            mode TEXT DEFAULT 'daily',
            posts_analyzed INTEGER DEFAULT 0,
            signals_analyzed INTEGER DEFAULT 0,
            transcripts_analyzed INTEGER DEFAULT 0,
            findings_created INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(run_date, mode)
        );

        CREATE TABLE IF NOT EXISTS findings (
            id INTEGER PRIMARY KEY,
            run_id INTEGER REFERENCES analysis_runs(id),
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            evidence TEXT,
            pillar TEXT,
            signal_strength TEXT DEFAULT 'medium',
            engagement_total INTEGER DEFAULT 0,
            source_count INTEGER DEFAULT 0,
            suggested_angle TEXT,
            status TEXT DEFAULT 'new',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS finding_links (
            id INTEGER PRIMARY KEY,
            finding_id INTEGER REFERENCES findings(id),
            related_finding_id INTEGER REFERENCES findings(id),
            link_type TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS opportunities (
            id INTEGER PRIMARY KEY,
            finding_id INTEGER REFERENCES findings(id),
            category TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            target_market TEXT,
            evidence TEXT,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'idea',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS market_scores (
            id INTEGER PRIMARY KEY,
            finding_id INTEGER REFERENCES findings(id),
            market TEXT NOT NULL,
            relevance TEXT DEFAULT 'none',
            context TEXT,
            audience TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(finding_id, market)
        );

        CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
        CREATE INDEX IF NOT EXISTS idx_findings_type ON findings(type);
        CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
        CREATE INDEX IF NOT EXISTS idx_finding_links_finding ON finding_links(finding_id);
        CREATE INDEX IF NOT EXISTS idx_opportunities_category ON opportunities(category);
        CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
        CREATE INDEX IF NOT EXISTS idx_market_scores_finding ON market_scores(finding_id);
        CREATE INDEX IF NOT EXISTS idx_market_scores_market ON market_scores(market);
    """)
    db.commit()
    db.close()
    print(json.dumps({"status": "ok", "db": DB_PATH}))


def cmd_sync_roster(args):
    """Sync influencer roster. Input: JSON array of {handle, platform, focus, why_follow}."""
    roster = json.load(open(args.file))
    db = get_db()
    added = 0
    updated = 0
    for entry in roster:
        cur = db.execute(
            "SELECT id FROM influencers WHERE handle = ? AND platform = ?",
            (entry["handle"], entry["platform"])
        )
        row = cur.fetchone()
        if row:
            db.execute(
                "UPDATE influencers SET focus = ?, why_follow = ?, active = 1 WHERE id = ?",
                (entry.get("focus", ""), entry.get("why_follow", ""), row["id"])
            )
            updated += 1
        else:
            db.execute(
                "INSERT INTO influencers (handle, platform, focus, why_follow) VALUES (?, ?, ?, ?)",
                (entry["handle"], entry["platform"], entry.get("focus", ""), entry.get("why_follow", ""))
            )
            added += 1
    db.commit()
    db.close()
    print(json.dumps({"added": added, "updated": updated}))


def cmd_insert_post(args):
    """Insert a post. Input: JSON with influencer_handle, platform, platform_post_id, url, content, post_date, views, likes, comments_count, shares."""
    post = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    db = get_db()

    cur = db.execute(
        "SELECT id FROM influencers WHERE handle = ? AND platform = ?",
        (post["influencer_handle"], post["platform"])
    )
    row = cur.fetchone()
    if not row:
        print(json.dumps({"error": f"Influencer {post['influencer_handle']} on {post['platform']} not found"}), file=sys.stderr)
        sys.exit(1)

    influencer_id = row["id"]
    platform_post_id = post.get("platform_post_id", post.get("url", ""))

    try:
        db.execute(
            """INSERT INTO posts (influencer_id, platform_post_id, url, content, post_date, views, likes, comments_count, shares)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                influencer_id, platform_post_id,
                post.get("url", ""), post.get("content", ""),
                post.get("post_date", ""), post.get("views", 0),
                post.get("likes", 0), post.get("comments_count", 0),
                post.get("shares", 0),
            )
        )
        db.commit()
        post_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        print(json.dumps({"status": "inserted", "post_id": post_id}))
    except sqlite3.IntegrityError:
        db.execute(
            """UPDATE posts SET views = ?, likes = ?, comments_count = ?, shares = ?, fetched_at = datetime('now')
               WHERE influencer_id = ? AND platform_post_id = ?""",
            (
                post.get("views", 0), post.get("likes", 0),
                post.get("comments_count", 0), post.get("shares", 0),
                influencer_id, platform_post_id,
            )
        )
        db.commit()
        row = db.execute(
            "SELECT id FROM posts WHERE influencer_id = ? AND platform_post_id = ?",
            (influencer_id, platform_post_id)
        ).fetchone()
        print(json.dumps({"status": "updated", "post_id": row["id"]}))
    finally:
        db.close()


def cmd_bulk_insert(args):
    """Bulk insert posts. Input: JSON array of post objects."""
    posts = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    db = get_db()
    inserted = 0
    updated = 0
    errors = 0

    inf_cache = {}
    for row in db.execute("SELECT id, handle, platform FROM influencers").fetchall():
        inf_cache[(row["handle"], row["platform"])] = row["id"]

    for post in posts:
        key = (post["influencer_handle"], post["platform"])
        influencer_id = inf_cache.get(key)
        if not influencer_id:
            errors += 1
            continue

        platform_post_id = post.get("platform_post_id", post.get("url", ""))
        try:
            db.execute(
                """INSERT INTO posts (influencer_id, platform_post_id, url, content, post_date, views, likes, comments_count, shares)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    influencer_id, platform_post_id, post.get("url", ""),
                    post.get("content", ""), post.get("post_date", ""),
                    post.get("views", 0), post.get("likes", 0),
                    post.get("comments_count", 0), post.get("shares", 0),
                )
            )
            inserted += 1
        except sqlite3.IntegrityError:
            db.execute(
                """UPDATE posts SET views = ?, likes = ?, comments_count = ?, shares = ?, fetched_at = datetime('now')
                   WHERE influencer_id = ? AND platform_post_id = ?""",
                (
                    post.get("views", 0), post.get("likes", 0),
                    post.get("comments_count", 0), post.get("shares", 0),
                    influencer_id, platform_post_id,
                )
            )
            updated += 1

    db.commit()
    db.close()
    print(json.dumps({"inserted": inserted, "updated": updated, "errors": errors}))


def _extract_field(item, *keys, default=None):
    """Try multiple field names, return first non-empty value."""
    for k in keys:
        v = item.get(k)
        if v is not None and v != "":
            return v
    return default


def cmd_ingest(args):
    """Parse raw social_collector.py output and bulk insert. Filters by author match and date."""
    data = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    results = data.get("results", [])
    handle = args.handle
    platform = args.platform
    now = datetime.now()
    lookback = getattr(args, "lookback_days", 3) or 3
    valid_dates = {(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(lookback)}

    posts = []
    skipped_author = 0
    skipped_old = 0

    for item in results:
        author = _extract_field(item, "author", "username", "channel", "creator", default="").lower()
        if author and handle.lower().replace(".", "") not in author.replace(".", ""):
            skipped_author += 1
            continue

        post_date = _extract_field(item, "date", "created_at", "published_at", "create_time", default="")
        if post_date and str(post_date)[:10] not in valid_dates:
            skipped_old += 1
            continue

        post = {
            "influencer_handle": handle,
            "platform": platform,
            "platform_post_id": _extract_field(item, "id", "videoId", "url", default=""),
            "url": _extract_field(item, "url", "link", default=""),
            "content": _extract_field(item, "text", "title", "snippet", "description", "caption", default=""),
            "post_date": str(post_date),
            "views": int(_extract_field(item, "views", "play_count", "view_count", default=0) or 0),
            "likes": int(_extract_field(item, "likes", "digg_count", "favorite_count", "like_count", default=0) or 0),
            "comments_count": int(_extract_field(item, "comments", "comment_count", "reply_count", default=0) or 0),
            "shares": int(_extract_field(item, "shares", "share_count", "retweet_count", default=0) or 0),
        }
        posts.append(post)

    if not posts:
        print(json.dumps({
            "handle": handle, "platform": platform,
            "inserted": 0, "updated": 0,
            "skipped_author": skipped_author, "skipped_old": skipped_old,
            "total_results": len(results),
        }))
        return

    db = get_db()
    inf_row = db.execute(
        "SELECT id FROM influencers WHERE handle = ? AND platform = ?",
        (handle, platform)
    ).fetchone()
    if not inf_row:
        db.close()
        print(json.dumps({"error": f"Influencer {handle} on {platform} not found"}), file=sys.stderr)
        sys.exit(1)

    influencer_id = inf_row["id"]
    inserted = 0
    updated = 0

    for post in posts:
        platform_post_id = post["platform_post_id"]
        try:
            db.execute(
                """INSERT INTO posts (influencer_id, platform_post_id, url, content, post_date, views, likes, comments_count, shares)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    influencer_id, platform_post_id, post["url"],
                    post["content"], post["post_date"],
                    post["views"], post["likes"],
                    post["comments_count"], post["shares"],
                )
            )
            inserted += 1
        except sqlite3.IntegrityError:
            db.execute(
                """UPDATE posts SET views = ?, likes = ?, comments_count = ?, shares = ?, fetched_at = datetime('now')
                   WHERE influencer_id = ? AND platform_post_id = ?""",
                (post["views"], post["likes"], post["comments_count"], post["shares"], influencer_id, platform_post_id)
            )
            updated += 1

    db.commit()
    db.close()
    print(json.dumps({
        "handle": handle, "platform": platform,
        "inserted": inserted, "updated": updated,
        "skipped_author": skipped_author, "skipped_old": skipped_old,
        "total_results": len(results),
    }))


def cmd_insert_comments(args):
    """Insert comments for a post. Input: JSON with post_id and comments array."""
    data = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    db = get_db()
    post_id = data["post_id"]
    inserted = 0
    for c in data.get("comments", []):
        content = c.get("content", "").strip()
        word_count = len(content.split())
        if word_count < 5:
            continue
        if any(spam in content.lower() for spam in ["follow me", "check my", "subscribe to", "dm me", "link in bio"]):
            continue
        db.execute(
            "INSERT INTO comments (post_id, author, content, likes) VALUES (?, ?, ?, ?)",
            (post_id, c.get("author", ""), content, c.get("likes", 0))
        )
        inserted += 1
    db.commit()
    db.close()
    print(json.dumps({"post_id": post_id, "inserted": inserted, "filtered": len(data.get("comments", [])) - inserted}))


def cmd_summary(_args):
    db = get_db()
    influencers = db.execute("SELECT COUNT(*) as n FROM influencers WHERE active = 1").fetchone()["n"]
    posts = db.execute("SELECT COUNT(*) as n FROM posts").fetchone()["n"]
    comments = db.execute("SELECT COUNT(*) as n FROM comments").fetchone()["n"]
    today_posts = db.execute(
        "SELECT COUNT(*) as n FROM posts WHERE date(fetched_at) = date('now')"
    ).fetchone()["n"]

    platforms = db.execute(
        "SELECT i.platform, COUNT(p.id) as post_count FROM influencers i LEFT JOIN posts p ON p.influencer_id = i.id GROUP BY i.platform"
    ).fetchall()

    market_signals = db.execute("SELECT COUNT(*) as n FROM market_signals").fetchone()["n"]
    market_searches = db.execute("SELECT COUNT(*) as n FROM market_searches").fetchone()["n"]

    db.close()
    result = {
        "influencers_active": influencers,
        "total_posts": posts,
        "total_comments": comments,
        "posts_today": today_posts,
        "by_platform": {r["platform"]: r["post_count"] for r in platforms},
        "market_signals": market_signals,
        "market_searches": market_searches,
    }
    print(json.dumps(result, indent=2))


def cmd_latest(args):
    db = get_db()
    days = args.days or 1
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = db.execute(
        """SELECT p.*, i.handle, i.platform
           FROM posts p JOIN influencers i ON p.influencer_id = i.id
           WHERE p.fetched_at >= ?
           ORDER BY p.likes DESC""",
        (cutoff,)
    ).fetchall()
    db.close()
    results = []
    for r in rows:
        results.append({
            "handle": r["handle"],
            "platform": r["platform"],
            "content": (r["content"] or "")[:200],
            "url": r["url"],
            "views": r["views"],
            "likes": r["likes"],
            "comments_count": r["comments_count"],
            "post_date": r["post_date"],
        })
    print(json.dumps(results, indent=2, ensure_ascii=False))


def cmd_ingest_market(args):
    """Ingest market signals from social_collector.py output."""
    data = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    results = data.get("results", [])
    query = args.query
    platform = args.platform
    topic = args.topic
    language = args.language or "en"

    db = get_db()

    try:
        db.execute(
            "INSERT INTO market_searches (query, platform, language, topic, result_count) VALUES (?, ?, ?, ?, ?)",
            (query, platform, language, topic, len(results))
        )
    except sqlite3.IntegrityError:
        db.execute(
            "UPDATE market_searches SET searched_at = datetime('now'), result_count = ?, topic = ? WHERE query = ? AND platform = ? AND language = ?",
            (len(results), topic, query, platform, language)
        )
    db.commit()

    search_id = db.execute(
        "SELECT id FROM market_searches WHERE query = ? AND platform = ? AND language = ?",
        (query, platform, language)
    ).fetchone()["id"]

    inserted = 0
    updated = 0
    for item in results:
        content = _extract_field(item, "text", "title", "snippet", "description", "caption", default="")
        platform_post_id = _extract_field(item, "id", "videoId", "url", default="")
        if not platform_post_id:
            continue

        url = _extract_field(item, "url", "link", default="")
        author = _extract_field(item, "author", "username", "channel", "creator", default="")
        post_date = _extract_field(item, "date", "created_at", "published_at", default="")
        views = int(_extract_field(item, "views", "play_count", "view_count", default=0) or 0)
        likes = int(_extract_field(item, "likes", "digg_count", "favorite_count", "like_count", default=0) or 0)
        comments_count = int(_extract_field(item, "comments", "comment_count", "reply_count", default=0) or 0)
        shares = int(_extract_field(item, "shares", "share_count", "retweet_count", default=0) or 0)

        try:
            db.execute(
                """INSERT INTO market_signals (search_id, platform, author, content, url, post_date, likes, comments, views, shares, platform_post_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (search_id, platform, author, content, url, str(post_date), likes, comments_count, views, shares, platform_post_id)
            )
            inserted += 1
        except sqlite3.IntegrityError:
            db.execute(
                """UPDATE market_signals SET likes = ?, comments = ?, views = ?, shares = ?, fetched_at = datetime('now')
                   WHERE platform = ? AND platform_post_id = ?""",
                (likes, comments_count, views, shares, platform, platform_post_id)
            )
            updated += 1

    db.commit()
    db.close()
    print(json.dumps({
        "search_id": search_id, "topic": topic, "platform": platform,
        "query": query, "language": language,
        "inserted": inserted, "updated": updated, "total_results": len(results),
    }))


def cmd_market_summary(args):
    """Show market signal statistics."""
    db = get_db()
    days = args.days or 7

    searches = db.execute(
        "SELECT COUNT(*) as n FROM market_searches WHERE searched_at >= datetime('now', ?)",
        (f'-{days} days',)
    ).fetchone()["n"]
    signals = db.execute(
        "SELECT COUNT(*) as n FROM market_signals WHERE fetched_at >= datetime('now', ?)",
        (f'-{days} days',)
    ).fetchone()["n"]
    total_signals = db.execute("SELECT COUNT(*) as n FROM market_signals").fetchone()["n"]
    total_searches = db.execute("SELECT COUNT(*) as n FROM market_searches").fetchone()["n"]

    topics = db.execute(
        """SELECT ms.topic, COUNT(sig.id) as signal_count, SUM(sig.likes) as total_likes
           FROM market_searches ms
           JOIN market_signals sig ON sig.search_id = ms.id
           GROUP BY ms.topic ORDER BY signal_count DESC"""
    ).fetchall()

    platforms = db.execute(
        "SELECT platform, COUNT(*) as n FROM market_signals GROUP BY platform ORDER BY n DESC"
    ).fetchall()

    db.close()
    print(json.dumps({
        "searches_last_n_days": searches,
        "signals_last_n_days": signals,
        "total_searches": total_searches,
        "total_signals": total_signals,
        "by_topic": {r["topic"]: {"signals": r["signal_count"], "likes": r["total_likes"]} for r in topics},
        "by_platform": {r["platform"]: r["n"] for r in platforms},
    }, indent=2))


def cmd_log_run(args):
    """Log an analysis run. Returns the run_id for linking findings."""
    db = get_db()
    run_date = args.date or datetime.now().strftime("%Y-%m-%d")
    mode = args.mode or "daily"

    try:
        db.execute(
            "INSERT INTO analysis_runs (run_date, mode) VALUES (?, ?)",
            (run_date, mode)
        )
    except sqlite3.IntegrityError:
        db.execute(
            "UPDATE analysis_runs SET created_at = datetime('now') WHERE run_date = ? AND mode = ?",
            (run_date, mode)
        )
    db.commit()
    row = db.execute(
        "SELECT id FROM analysis_runs WHERE run_date = ? AND mode = ?",
        (run_date, mode)
    ).fetchone()
    db.close()
    print(json.dumps({"run_id": row["id"], "run_date": run_date, "mode": mode}))


def _normalize_title(title):
    """Normalize a finding title for dedup comparison."""
    t = title.lower().strip()
    t = re.sub(r"\*\*", "", t)
    t = t.strip('"').strip("'")
    t = re.split(r"\s*[—–]\s+", t)[0]
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _titles_match(a, b):
    """Check if two titles are similar enough to be duplicates (>=60% word overlap)."""
    words_a = set(_normalize_title(a).split())
    words_b = set(_normalize_title(b).split())
    if not words_a or not words_b:
        return False
    overlap = len(words_a & words_b)
    smaller = min(len(words_a), len(words_b))
    return (overlap / smaller) >= 0.6 if smaller > 0 else False


def cmd_add_finding(args):
    """Add a finding from a miner run. Deduplicates against existing findings from the last 7 days."""
    data = json.load(open(args.file)) if args.file != "-" else json.load(sys.stdin)
    db = get_db()

    items = data if isinstance(data, list) else [data]
    inserted = 0
    updated = 0
    skipped = 0

    existing = db.execute(
        "SELECT id, title, source_count, engagement_total FROM findings WHERE created_at >= datetime('now', '-7 days')"
    ).fetchall()

    for f in items:
        new_title = f["title"]

        match_id = None
        for ex in existing:
            if _titles_match(new_title, ex["title"]):
                match_id = ex["id"]
                break

        if match_id:
            new_sources = f.get("source_count", 0) or 0
            new_engagement = f.get("engagement_total", 0) or 0
            ex_row = [e for e in existing if e["id"] == match_id][0]

            if new_sources > (ex_row["source_count"] or 0) or new_engagement > (ex_row["engagement_total"] or 0):
                db.execute(
                    """UPDATE findings SET
                       source_count = MAX(source_count, ?),
                       engagement_total = MAX(engagement_total, ?),
                       signal_strength = CASE WHEN ? IN ('high') THEN ? ELSE signal_strength END,
                       description = CASE WHEN LENGTH(?) > LENGTH(COALESCE(description, '')) THEN ? ELSE description END,
                       pillar = CASE WHEN COALESCE(pillar, '') = '' OR pillar = '?' THEN COALESCE(NULLIF(?, ''), pillar) ELSE pillar END
                    WHERE id = ?""",
                    (
                        new_sources, new_engagement,
                        f.get("signal_strength", "medium"), f.get("signal_strength", "medium"),
                        f.get("description", ""), f.get("description", ""),
                        f.get("pillar", ""),
                        match_id,
                    )
                )
                for ms in f.get("market_scores", []):
                    try:
                        db.execute(
                            "INSERT INTO market_scores (finding_id, market, relevance, context, audience) VALUES (?, ?, ?, ?, ?)",
                            (match_id, ms["market"], ms.get("relevance", "none"), ms.get("context", ""), ms.get("audience", ""))
                        )
                    except sqlite3.IntegrityError:
                        rel_order = {"high": 3, "medium": 2, "low": 1, "none": 0}
                        new_rel = rel_order.get(ms.get("relevance", "none"), 0)
                        if new_rel > 0:
                            db.execute(
                                """UPDATE market_scores SET relevance = ?, context = COALESCE(NULLIF(?, ''), context),
                                   audience = COALESCE(NULLIF(?, ''), audience)
                                   WHERE finding_id = ? AND market = ? AND ? > (
                                       SELECT CASE relevance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END
                                   )""",
                                (ms.get("relevance"), ms.get("context", ""), ms.get("audience", ""),
                                 match_id, ms["market"], new_rel)
                            )
                updated += 1
            else:
                skipped += 1
            continue

        cur = db.execute(
            """INSERT INTO findings (run_id, type, title, description, evidence, pillar,
               signal_strength, engagement_total, source_count, suggested_angle)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                f.get("run_id"), f["type"], f["title"],
                f.get("description", ""), json.dumps(f.get("evidence", [])),
                f.get("pillar", ""), f.get("signal_strength", "medium"),
                f.get("engagement_total", 0), f.get("source_count", 0),
                f.get("suggested_angle", ""),
            )
        )
        finding_id = cur.lastrowid

        existing.append({"id": finding_id, "title": new_title,
                        "source_count": f.get("source_count", 0),
                        "engagement_total": f.get("engagement_total", 0)})

        for ms in f.get("market_scores", []):
            try:
                db.execute(
                    "INSERT INTO market_scores (finding_id, market, relevance, context, audience) VALUES (?, ?, ?, ?, ?)",
                    (finding_id, ms["market"], ms.get("relevance", "none"), ms.get("context", ""), ms.get("audience", ""))
                )
            except sqlite3.IntegrityError:
                pass

        opp = f.get("opportunity")
        if opp:
            db.execute(
                """INSERT INTO opportunities (finding_id, category, title, description, target_market, evidence, priority)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (finding_id, opp["category"], opp["title"], opp.get("description", ""),
                 opp.get("target_market", ""), json.dumps(opp.get("evidence", [])), opp.get("priority", "medium"))
            )

        inserted += 1

    db.commit()
    db.close()
    print(json.dumps({"inserted": inserted, "updated": updated, "skipped": skipped}))


def cmd_update_run(args):
    """Update analysis run stats after completion."""
    db = get_db()
    db.execute(
        """UPDATE analysis_runs SET posts_analyzed = ?, signals_analyzed = ?,
           transcripts_analyzed = ?, findings_created = ?, cost_usd = ?
           WHERE id = ?""",
        (args.posts, args.signals, args.transcripts, args.findings, args.cost, args.run_id)
    )
    db.commit()
    db.close()
    print(json.dumps({"status": "updated", "run_id": args.run_id}))


def cmd_mark_mined(args):
    """Mark posts and market_signals as mined."""
    db = get_db()
    lookback = args.lookback_days or 7
    cutoff = (datetime.now() - timedelta(days=lookback)).isoformat()

    try:
        db.execute("ALTER TABLE posts ADD COLUMN mined_at TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        db.execute("ALTER TABLE market_signals ADD COLUMN mined_at TEXT")
    except sqlite3.OperationalError:
        pass

    posts_marked = db.execute(
        "UPDATE posts SET mined_at = datetime('now') WHERE mined_at IS NULL AND fetched_at >= ?",
        (cutoff,)
    ).rowcount
    signals_marked = db.execute(
        "UPDATE market_signals SET mined_at = datetime('now') WHERE mined_at IS NULL AND fetched_at >= ?",
        (cutoff,)
    ).rowcount

    db.commit()
    db.close()
    print(json.dumps({"posts_marked": posts_marked, "signals_marked": signals_marked}))


def cmd_unmined(_args):
    """Show count of unmined data."""
    db = get_db()

    try:
        posts = db.execute("SELECT COUNT(*) as n FROM posts WHERE mined_at IS NULL").fetchone()["n"]
    except sqlite3.OperationalError:
        posts = db.execute("SELECT COUNT(*) as n FROM posts").fetchone()["n"]
    try:
        signals = db.execute("SELECT COUNT(*) as n FROM market_signals WHERE mined_at IS NULL").fetchone()["n"]
    except sqlite3.OperationalError:
        signals = db.execute("SELECT COUNT(*) as n FROM market_signals").fetchone()["n"]

    db.close()
    print(json.dumps({"unmined_posts": posts, "unmined_signals": signals, "total_unmined": posts + signals}))


def cmd_findings_summary(args):
    """Show findings summary."""
    db = get_db()
    days = args.days or 7
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()

    by_type = db.execute(
        "SELECT type, COUNT(*) as n, SUM(engagement_total) as engagement FROM findings WHERE created_at >= ? GROUP BY type ORDER BY n DESC",
        (cutoff,)
    ).fetchall()

    by_pillar = db.execute(
        "SELECT pillar, COUNT(*) as n FROM findings WHERE created_at >= ? AND pillar != '' GROUP BY pillar ORDER BY n DESC",
        (cutoff,)
    ).fetchall()

    by_market = db.execute(
        """SELECT ms.market, ms.relevance, COUNT(*) as n
           FROM market_scores ms JOIN findings f ON ms.finding_id = f.id
           WHERE f.created_at >= ? GROUP BY ms.market, ms.relevance ORDER BY ms.market, n DESC""",
        (cutoff,)
    ).fetchall()

    opps = db.execute(
        "SELECT category, COUNT(*) as n FROM opportunities WHERE created_at >= ? GROUP BY category ORDER BY n DESC",
        (cutoff,)
    ).fetchall()

    runs = db.execute(
        "SELECT COUNT(*) as n, SUM(findings_created) as total_findings, SUM(cost_usd) as total_cost FROM analysis_runs WHERE created_at >= ?",
        (cutoff,)
    ).fetchall()

    total_findings = db.execute("SELECT COUNT(*) as n FROM findings WHERE created_at >= ?", (cutoff,)).fetchone()["n"]

    db.close()
    print(json.dumps({
        "period_days": days,
        "total_findings": total_findings,
        "by_type": {r["type"]: {"count": r["n"], "engagement": r["engagement"]} for r in by_type},
        "by_pillar": {r["pillar"]: r["n"] for r in by_pillar},
        "by_market": {f"{r['market']}_{r['relevance']}": r["n"] for r in by_market},
        "opportunities": {r["category"]: r["n"] for r in opps},
        "runs": {"count": runs[0]["n"], "findings": runs[0]["total_findings"], "cost": round(runs[0]["total_cost"] or 0, 2)},
    }, indent=2))


def cmd_fetch_transcripts(_args):
    """Fetch YouTube transcripts for posts that don't have one yet."""
    from youtube_transcript_api import YouTubeTranscriptApi

    db = get_db()
    rows = db.execute("""
        SELECT p.id, p.platform_post_id, p.url, i.platform
        FROM posts p JOIN influencers i ON p.influencer_id = i.id
        WHERE i.platform = 'youtube' AND (p.transcript IS NULL OR p.transcript = '')
    """).fetchall()

    if not rows:
        print(json.dumps({"status": "no posts need transcripts", "checked": 0}))
        db.close()
        return

    api = YouTubeTranscriptApi()
    fetched = 0
    failed = 0

    for row in rows:
        video_id = row["platform_post_id"]
        url = row["url"] or ""
        if "watch?v=" in url:
            video_id = url.split("watch?v=")[1].split("&")[0]
        elif "youtu.be/" in url:
            video_id = url.split("youtu.be/")[1].split("?")[0]

        if not video_id or len(video_id) < 5:
            failed += 1
            continue

        try:
            transcript = api.fetch(video_id, languages=["en", "ar"])
            full_text = " ".join(s.text for s in transcript)
            db.execute("UPDATE posts SET transcript = ? WHERE id = ?", (full_text, row["id"]))
            fetched += 1
        except Exception:
            db.execute("UPDATE posts SET transcript = '[unavailable]' WHERE id = ?", (row["id"],))
            failed += 1

    db.commit()
    db.close()
    print(json.dumps({"fetched": fetched, "failed": failed, "total": len(rows)}))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Market Intel DB manager")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Initialize database schema")

    sr = sub.add_parser("sync-roster", help="Sync influencer roster from JSON")
    sr.add_argument("file", help="Path to roster JSON file")

    ip = sub.add_parser("insert-post", help="Insert a post (JSON)")
    ip.add_argument("file", nargs="?", default="-", help="JSON file or - for stdin")

    bi = sub.add_parser("bulk-insert", help="Bulk insert posts (JSON array)")
    bi.add_argument("file", nargs="?", default="-", help="JSON file or - for stdin")

    ig = sub.add_parser("ingest", help="Parse social_collector output + bulk insert")
    ig.add_argument("file", nargs="?", default="-", help="Raw social_collector JSON or - for stdin")
    ig.add_argument("--handle", required=True, help="Influencer handle")
    ig.add_argument("--platform", required=True, help="Platform name")
    ig.add_argument("--lookback-days", type=int, default=3, help="Accept posts from last N days (default: 3)")

    ic = sub.add_parser("insert-comments", help="Insert comments for a post")
    ic.add_argument("file", nargs="?", default="-", help="JSON file or - for stdin")

    im = sub.add_parser("ingest-market", help="Ingest market signals from social_collector output")
    im.add_argument("file", nargs="?", default="-", help="Raw social_collector JSON or - for stdin")
    im.add_argument("--topic", required=True, help="Topic name")
    im.add_argument("--platform", required=True, help="Platform name")
    im.add_argument("--query", required=True, help="Search query used")
    im.add_argument("--language", default="en", help="Search language (default: en)")

    sub.add_parser("summary", help="Show DB statistics")

    lt = sub.add_parser("latest", help="Show latest posts")
    lt.add_argument("--days", type=int, default=1, help="Lookback days (default: 1)")

    ms = sub.add_parser("market-summary", help="Show market signal statistics")
    ms.add_argument("--days", type=int, default=7, help="Lookback days (default: 7)")

    lr = sub.add_parser("log-run", help="Log an analysis run, returns run_id")
    lr.add_argument("--date", default=None, help="Run date (default: today)")
    lr.add_argument("--mode", default="daily", help="Run mode: daily/weekly/full")

    af = sub.add_parser("add-finding", help="Add finding(s) from a miner run (JSON)")
    af.add_argument("file", nargs="?", default="-", help="JSON file or - for stdin")

    ur = sub.add_parser("update-run", help="Update analysis run stats")
    ur.add_argument("run_id", type=int, help="Run ID")
    ur.add_argument("--posts", type=int, default=0)
    ur.add_argument("--signals", type=int, default=0)
    ur.add_argument("--transcripts", type=int, default=0)
    ur.add_argument("--findings", type=int, default=0)
    ur.add_argument("--cost", type=float, default=0)

    mm = sub.add_parser("mark-mined", help="Mark posts and signals as mined")
    mm.add_argument("--lookback-days", type=int, default=7)

    sub.add_parser("unmined", help="Show count of unmined data")

    fs = sub.add_parser("findings-summary", help="Show findings summary")
    fs.add_argument("--days", type=int, default=7, help="Lookback days (default: 7)")

    sub.add_parser("fetch-transcripts", help="Fetch YouTube transcripts for posts missing them")

    args = p.parse_args()
    {
        "init": cmd_init,
        "sync-roster": cmd_sync_roster,
        "insert-post": cmd_insert_post,
        "bulk-insert": cmd_bulk_insert,
        "ingest": cmd_ingest,
        "ingest-market": cmd_ingest_market,
        "insert-comments": cmd_insert_comments,
        "summary": cmd_summary,
        "latest": cmd_latest,
        "market-summary": cmd_market_summary,
        "log-run": cmd_log_run,
        "add-finding": cmd_add_finding,
        "update-run": cmd_update_run,
        "mark-mined": cmd_mark_mined,
        "unmined": cmd_unmined,
        "findings-summary": cmd_findings_summary,
        "fetch-transcripts": cmd_fetch_transcripts,
    }[args.command](args)
