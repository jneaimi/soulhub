---
name: categorical-heatmap
version: 0.1.0
type: component
kind: presentation

break_inside: avoid
category: chart
tier: 1
description: "Generic row × column relevance heatmap, rendered as an HTML table of color-coded HIGH/MED/LOW cells. Columns and rows are inputs — no domain assumption."
languages: [en, ar]
template:
  en: en.html
  ar: ar.html
styles: styles.css
tokens:
  - "--accent"
  - "--text-secondary"
sample_inputs:
  eyebrow: "Relevance matrix"
  columns: ["Column 1", "Column 2", "Column 3", "Column 4", "Column 5"]
  rows:
    - { label: "Row one", cells: ["high", "med", "low", "low", "med"] }
    - { label: "Row two", cells: ["med", "high", "low", "med", "low"] }
    - { label: "Row three", cells: ["high", "med", "med", "low", "high"] }
  caption: "Relevance of each row to each column (high / med / low)."
inputs:
  - name: eyebrow
    type: string
    required: false
  - name: title
    type: string
    required: false
  - name: columns
    type: array
    required: true
    description: "Column headers. The caller supplies them — no domain default."
  - name: rows
    type: array
    required: true
    description: "Rows to plot. Each is {label, cells: [high|med|low, ...]} aligned to columns."
  - name: caption
    type: string
    required: false
---

# categorical-heatmap

A generic row × column relevance heatmap (ADR-034 CP1). Renders an HTML `<table>` of color-coded HIGH/MED/LOW cells from `columns` + `rows` ({label, cells}). Domain-neutral — the caller supplies the column headers; reusable for any categorical relevance grid.
