---
name: box-dieline-exporter
type: script
runtime: python
description: Tiles each finalized motif across the dieline geometry derived from dims.json, writes print-ready PNGs at 300dpi with NOMAD wordmark and category label
author: jasem
version: 1.0.0

inputs:
  - name: finals_index
    type: file
    format: json
    description: finals-index.json from box-motif-finalizer

outputs:
  - name: dielines_index
    type: file
    format: json
    description: Index of print-ready dieline PNGs, one per category × direction

config:
  - name: dpi
    type: number
    label: Print DPI
    description: Pixels per inch — 300 is press standard
    default: 300
    min: 150
    max: 600
    required: true
  - name: wordmark
    type: text
    label: NOMAD wordmark text
    description: Brand wordmark drawn on the front panel
    default: 'NOMAD'
    required: true
  - name: category_label_en
    type: toggle
    label: Add English category label
    description: Print the category name on the front panel below the wordmark
    default: true
  - name: category_label_ar
    type: text
    label: Arabic category label override (optional)
    description: 'If set per run, this Arabic string overrides default. Per-category Arabic mapping lives in config/categories.json (label_ar field).'
    default: ''
  - name: bleed_mm
    type: number
    label: Bleed (mm)
    description: Extra image area beyond the cut line — printer needs ~3mm
    default: 3
    min: 0
    max: 10
    required: true

env: []

data: {}
---

# box-dieline-exporter

Reads `output/dims.json` (dieline geometry derived by `box-fit-calculator`) and the finals manifest, then for every `(category × direction)` cell:

1. Builds a print-DPI canvas at the dieline's flat sheet size + bleed.
2. Tiles the motif across all 4 side panels using direction-specific patterning (A single feature / B 3×3 / C 6×6 — same logic as the mockup compositor).
3. Composites a NOMAD wordmark + EN/AR category label on the front panel.
4. Saves a flat dieline PNG ready for the printer's cut/crease overlay.

The output PNGs are NOT a substitute for a vector dieline — they are raster artwork sized to the dieline's panel layout. Hand them to the printer alongside the vector cut/crease file.
