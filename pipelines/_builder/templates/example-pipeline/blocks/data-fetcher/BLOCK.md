---
name: data-fetcher
type: script
runtime: python
description: Read keywords from config, simulate fetching results, store in DB
author: jasem
version: 1.0.0

inputs:
  - name: keywords
    type: file
    format: json
    description: Keywords config file
    default: config/keywords.json

outputs:
  - name: results
    type: file
    format: json
    description: Fetched results as JSON
  - name: db_rows
    type: db-table
    table: results
    description: Results stored in SQLite

config:
  - name: max_results
    type: number
    label: Max results per keyword
    description: Limit results returned per keyword
    default: 10
    min: 1
    max: 100
    required: false

env: []

data:
  requires: []
  produces: [results]
  database: data.db
---

# Data Fetcher

Reads keywords from config JSON, fetches sample results for each keyword, and stores them in the SQLite database. Outputs a JSON summary of what was fetched.
