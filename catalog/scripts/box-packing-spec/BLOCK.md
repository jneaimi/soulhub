---
name: box-packing-spec
type: script
runtime: python
description: Generates a packing spec markdown with per-container box counts, payload estimates, and top-down packing diagrams
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: packing_spec
    type: file
    format: markdown
    description: Operations-ready packing spec with diagrams for delivery partners

config:
  - name: avg_box_weight_kg
    type: number
    label: Average filled-box weight (kg)
    description: Used to estimate payload per trip and warn against weight limit
    default: 1.5
    min: 0.2
    max: 10
    required: true

env: []

data: {}
---

# box-packing-spec

Reads `output/dims.json` (produced by `box-fit-calculator`) and emits a hand-off packing spec the user can give to a delivery partner. For every container:

- Best orientation
- Boxes-per-trip count
- Top-down packing diagram (PNG embedded inline)
- Payload weight estimate vs the container's `max_weight_kg`

Also includes a final "if you adopt the optimized box dims" subsection when the calculator proposed a smaller box.
