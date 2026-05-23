---
name: report-maker
type: script
runtime: python
description: Read results from DB and generate a markdown summary report
author: jasem
version: 1.0.0

inputs:
  - name: fetch_result
    type: file
    format: json
    description: Output from data-fetcher step

outputs:
  - name: report
    type: file
    format: markdown
    description: Summary report in markdown

config: []
env: []

data:
  requires: [results]
  produces: []
  database: data.db
---

# Report Maker

Reads fetched results from the SQLite database and generates a markdown summary report grouped by category.
