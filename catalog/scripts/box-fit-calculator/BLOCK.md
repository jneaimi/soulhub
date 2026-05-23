---
name: box-fit-calculator
type: script
runtime: python
description: Compute how many delivery boxes fit per container and optionally propose optimized box dimensions
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: fit_report
    type: file
    format: markdown
    description: Human-readable report of box-to-container fit, plus dims.json sidecar for downstream steps

config:
  - name: box_dims
    type: text
    label: Target box dimensions (LxWxH mm)
    description: 'Target outer dimensions of the gable box, e.g. 140x140x280'
    default: '140x140x280'
    required: true
  - name: optimize
    type: toggle
    label: Optimize box dimensions
    description: When on, propose alternative box dims that maximize boxes-per-trip while still holding the internal components
    default: true
  - name: containers_file
    type: text
    label: Containers config path (relative to pipeline dir)
    description: JSON file with delivery container specs
    default: 'config/containers.json'
    required: true

env: []

data: {}
---

# box-fit-calculator

Computes how many delivery boxes fit inside each container (delivery bike top box, scooter side bag, car trunk slot, etc.) for a given target box size. When `optimize=true`, it also evaluates a small grid of alternative box sizes (constrained to still hold the internal components — 750ml bowl, 450ml side tub, 200g side box, 110ml portion cup) and reports whether a different size would fit more boxes per trip.

Writes two files into the pipeline `output/` directory:
- `fit-report.md` — markdown summary (PIPELINE_OUTPUT)
- `dims.json` — machine-readable dimensions and fit data (consumed by `box-direction-analyzer`, `box-mockup-compositor`, `box-dieline-exporter`, `box-packing-spec`)
