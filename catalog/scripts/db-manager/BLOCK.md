---
name: db-manager
type: script
runtime: python
description: Shared SQLite DB CLI for market intelligence — schema init, data ingestion, queries
author: jasem
version: 1.0.0

inputs:
  - name: command
    type: text
    description: Subcommand to run (init, sync-roster, ingest, summary, etc.)

outputs:
  - name: status
    type: json
    description: Command-specific JSON output

config: []

env: []

data:
  requires: []
  produces: [influencers, posts, comments, market_searches, market_signals, analysis_runs, findings, finding_links, opportunities, market_scores]
  database: signals.db
---

# DB Manager

Shared database CLI used by all market intelligence blocks. Manages the SQLite schema and provides subcommands for data ingestion, querying, and maintenance.

## Subcommands
- `init` — Initialize DB schema (10 tables)
- `sync-roster <roster.json>` — Sync influencer roster
- `insert-post <post.json>` — Insert a single post
- `bulk-insert <posts.json>` — Bulk insert posts
- `ingest <raw.json> --handle H --platform P` — Parse social_collector output + insert
- `ingest-market <raw.json> --topic T --platform P --query Q` — Ingest market signals
- `insert-comments <comments.json>` — Insert comments for a post
- `summary` — Show DB statistics
- `latest [--days N]` — Show latest posts
- `market-summary [--days N]` — Market signal stats
- `log-run` — Log an analysis run (returns run_id)
- `add-finding <finding.json>` — Add finding(s) with dedup
- `update-run` — Update run stats after completion
- `mark-mined` — Mark data as processed
- `unmined` — Show count of unprocessed data
- `findings-summary [--days N]` — Findings breakdown
- `fetch-transcripts` — Fetch YouTube transcripts

## Files
- `run.py` — main script (CLI entry point)
- `BLOCK.md` — this manifest
