---
name: box-mockup-compositor
type: script
runtime: python
description: Composites finalized motifs onto a gable-box mockup silhouette so the user sees each motif in product context
author: jasem
version: 1.0.0

inputs:
  - name: finals_index
    type: file
    format: json
    description: finals-index.json from box-motif-finalizer

outputs:
  - name: mockups_index
    type: file
    format: json
    description: Index of mockup PNGs (one per category × direction) plus a contact-sheet PNG suitable for review

config:
  - name: nomad_wordmark
    type: text
    label: Wordmark text
    description: Static brand label drawn beneath the motif on the mockup
    default: 'NOMAD'
    required: true
  - name: tagline
    type: text
    label: Tagline (optional)
    description: Small text under the wordmark on the mockup. Leave empty to hide.
    default: 'LOGO PLACEHOLDER'

env: []

data: {}
---

# box-mockup-compositor

Reads the finals-index manifest, opens each `(category × direction)` final image, and composites it onto a 2D gable-box silhouette using Pillow. Different directions use different motif treatments to mimic the original A/B/C styling:

- **A — Heritage Route:** single feature panel, cream background, motif centered
- **B — Mother's Kitchen:** light pattern tiling (3×3), kraft background
- **C — Bold Nomad:** dense pattern tiling (6×6), high-contrast background

Writes one mockup PNG per final, plus a contact-sheet PNG showing all 12 cells in a 4×3 grid for fast user review during/after the approval gate.
