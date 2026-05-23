---
name: box-direction-analyzer
type: script
runtime: python
description: Walk the samples folder, extract dominant palette per A/B/C reference image, and emit a style-fingerprint markdown brief
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: directions
    type: file
    format: markdown
    description: Markdown style fingerprint for each direction (A Heritage Route, B Mother's Kitchen, C Bold Nomad) — palette hex codes, line-style notes, and reference image paths

config:
  - name: samples_folder
    type: text
    label: Samples folder (relative to pipeline dir)
    description: Folder containing reference images (dieline, form-factor, components, directions A/B/C mockup)
    default: 'samples'
    required: true
  - name: directions_file
    type: text
    label: Directions config path (relative to pipeline dir)
    description: JSON file with declared direction metadata (palette description, line style)
    default: 'config/directions.json'
    required: true
  - name: directions_image
    type: text
    label: Directions reference image filename
    description: Filename within samples_folder containing the side-by-side A/B/C mockup
    default: '04-directions-abc.jpeg'
    required: true

env: []

data: {}
---

# box-direction-analyzer

Reads the declared directions (palette + line-style descriptions from `config/directions.json`) and enriches them with actual dominant hex colors extracted from the side-by-side A/B/C reference image. Produces a single markdown brief consumed by the `box-motif-designer` agent — every motif prompt downstream of this step will cite specific hex codes from this brief.

The script crops the directions reference image into three equal vertical thirds (A | B | C), runs Pillow's adaptive palette quantization on each crop, and reports the top 5 colors per direction.
