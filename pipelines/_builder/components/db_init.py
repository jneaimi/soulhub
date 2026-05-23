#!/usr/bin/env python3
"""Initialize SQLite database from schema.sql."""
import os, sqlite3
from pathlib import Path


def init_db(pipeline_dir: str | Path | None = None, db_name: str = "data.db") -> sqlite3.Connection:
    """Create DB and apply schema.sql if the DB doesn't exist yet.

    Args:
        pipeline_dir: Pipeline root. Defaults to PIPELINE_DIR env var.
        db_name: Database filename inside db/. Defaults to BLOCK_DATABASE env var or "data.db".
    Returns:
        Open sqlite3 connection.
    """
    pipeline_dir = Path(pipeline_dir or os.environ.get("PIPELINE_DIR", "."))
    db_name = os.environ.get("BLOCK_DATABASE", db_name)
    db_path = pipeline_dir / "db" / db_name
    schema_path = pipeline_dir / "db" / "schema.sql"

    db_path.parent.mkdir(parents=True, exist_ok=True)
    is_new = not db_path.exists()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    if is_new and schema_path.exists():
        conn.executescript(schema_path.read_text())
        conn.commit()

    return conn
