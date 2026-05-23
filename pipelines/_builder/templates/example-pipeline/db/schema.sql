CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    score INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now'))
);
