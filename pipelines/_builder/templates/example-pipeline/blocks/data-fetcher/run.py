#!/usr/bin/env python3
"""data-fetcher — Read keywords config, fetch results, store in DB."""

import json
import os
import sqlite3
from pathlib import Path

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / "data.db"
CONFIG_PATH = PIPELINE_DIR / "config" / "keywords.json"
SCHEMA_PATH = PIPELINE_DIR / "db" / "schema.sql"
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", str(PIPELINE_DIR / "output" / "fetch-result.json"))

MAX_RESULTS = int(os.environ.get("BLOCK_CONFIG_MAX_RESULTS", "10"))


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.executescript(SCHEMA_PATH.read_text())
    conn.close()


def main():
    init_db()

    with open(CONFIG_PATH) as f:
        keywords = json.load(f)

    conn = sqlite3.connect(str(DB_PATH))
    inserted = 0

    for kw in keywords:
        keyword = kw["keyword"]
        category = kw["category"]

        # Simulated results — replace with real API call
        results = [
            {"title": f"Article about {keyword} #{i+1}", "url": f"https://example.com/{keyword.replace(' ', '-')}/{i+1}", "score": 10 - i}
            for i in range(min(3, MAX_RESULTS))
        ]

        for r in results:
            conn.execute(
                "INSERT INTO results (keyword, category, title, url, score) VALUES (?, ?, ?, ?, ?)",
                (keyword, category, r["title"], r["url"], r["score"]),
            )
            inserted += 1

    conn.commit()
    conn.close()

    summary = {"keywords": len(keywords), "inserted": inserted}
    Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(OUTPUT_PATH).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
