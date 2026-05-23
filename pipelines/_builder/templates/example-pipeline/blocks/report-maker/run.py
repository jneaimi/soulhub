#!/usr/bin/env python3
"""report-maker — Read results from DB, write markdown report."""

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / "data.db"
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", str(PIPELINE_DIR / "output" / "report.md"))


def main():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    rows = conn.execute("SELECT * FROM results ORDER BY category, score DESC").fetchall()
    conn.close()

    if not rows:
        report = "# Report\n\nNo results found.\n"
    else:
        lines = [f"# Keyword Tracker Report", f"", f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}", f""]
        current_cat = None
        for r in rows:
            if r["category"] != current_cat:
                current_cat = r["category"]
                lines.append(f"## {current_cat.title()}")
                lines.append("")
            url_part = f" — [{r['url']}]({r['url']})" if r["url"] else ""
            lines.append(f"- **{r['title']}** (score: {r['score']}){url_part}")
        lines.append("")
        report = "\n".join(lines)

    Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(OUTPUT_PATH).write_text(report)
    print(json.dumps({"rows": len(rows), "output": OUTPUT_PATH}))


if __name__ == "__main__":
    main()
