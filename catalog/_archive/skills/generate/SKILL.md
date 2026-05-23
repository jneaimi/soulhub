---
name: generate
description: Generate images, video clips, and voiceovers using AI APIs. Use when the user says /generate or needs media assets.
user-invocable: true
---

# Generate (/generate)

Create media assets using AI generation APIs.

## Capabilities
- **Images**: Gemini (flash/pro), multiple aspect ratios
- **Video**: Veo (fast/standard), 4-8 second clips
- **Voice**: ElevenLabs (v3/flash), custom voice clones
- **Overlay**: Arabic text on images (Pillow + arabic-reshaper)

## Rules
- Arabic text in images: generate without text, then overlay
- Default to flash/fast models unless pro/standard requested
- Save with .meta.json sidecar for tracking
