#!/usr/bin/env python3
"""
Pre-run hook: load brand voice context and anti-slop rules.
Combines user-provided brand voice with format-specific writing guidelines.

Usage: python3 hooks/load-brand-context.py "<brand_voice>" "<format>" "<audience>"
Output: JSON to stdout + hooks/output/brand-context.md
"""
import sys
import json
from pathlib import Path

HOOKS_OUTPUT = Path(__file__).parent / "output"
HOOKS_OUTPUT.mkdir(exist_ok=True)

brand_voice = sys.argv[1] if len(sys.argv) > 1 else ""
content_format = sys.argv[2] if len(sys.argv) > 2 else "blog-post"
audience = sys.argv[3] if len(sys.argv) > 3 else "professionals"

# Default brand voice if none provided
if not brand_voice.strip():
    brand_voice = "Professional, clear, and engaging. Write with authority but remain approachable. Use active voice. Avoid jargon unless the audience expects it."

# Anti-slop rules (universal — no AI-sounding filler)
anti_slop = """## Anti-Slop Rules (MANDATORY)

Do NOT use these words/phrases — they signal AI-generated content:
- "In today's rapidly evolving landscape"
- "Dive deep" / "deep dive"
- "Game-changer" / "paradigm shift"
- "Unlock" / "unleash" / "harness the power"
- "It's important to note that"
- "In conclusion" (find a better closer)
- "Leverage" (use "use" instead)
- "Cutting-edge" / "revolutionary" / "groundbreaking"
- "Seamlessly" / "effortlessly"
- "Navigate the complexities"
- "Foster" / "cultivate" (unless about farming)
- "Robust" / "comprehensive" / "holistic"
- "Moving forward" / "going forward"
- Any sentence starting with "In the world of..."

Write like a human expert, not a language model."""

# Format-specific writing guides
format_guides = {
    "blog-post": """## Blog Post Guide
- **Length:** 800-1200 words
- **Structure:** Hook → Problem → Solution → Examples → CTA
- **Title:** Clear benefit, under 60 chars for SEO
- **Subheadings:** Every 200-300 words, scannable
- **Paragraphs:** 2-3 sentences max
- **Include:** At least 1 real example or case study
- **End with:** Clear next step for the reader""",

    "newsletter": """## Newsletter Guide
- **Length:** 400-600 words
- **Structure:** TL;DR → Main insight → Supporting points → One CTA
- **Tone:** Conversational, like writing to a smart friend
- **Format:** Heavy use of bullet points, bold key phrases
- **Subject line:** Create curiosity or promise value
- **P.S.:** Optional but effective for secondary CTA""",

    "linkedin-post": """## LinkedIn Post Guide
- **Length:** 150-300 words (max 3000 chars)
- **Hook:** First line must stop the scroll — bold claim, question, or story opener
- **Structure:** Hook → 3-5 short paragraphs → CTA
- **Line breaks:** After every 1-2 sentences (mobile readability)
- **Tone:** Professional but personal — "I" perspective works well
- **End with:** Question or soft CTA to drive comments
- **No hashtags in body** — add 3-5 at the very end""",

    "technical-article": """## Technical Article Guide
- **Length:** 1500-2500 words
- **Structure:** Problem → Background → Approach → Implementation → Results → Takeaways
- **Prerequisites:** State what the reader should know upfront
- **Code:** Include runnable examples, explain non-obvious lines
- **Diagrams:** Describe where visuals would help (can be added later)
- **Tone:** Precise, peer-to-peer — assume the reader is competent
- **End with:** Summary of key decisions and when to apply this approach""",
}

format_guide = format_guides.get(content_format, format_guides["blog-post"])

# Compose the full brand context
context = f"""# Brand & Writing Context

## Brand Voice
{brand_voice}

## Target Audience
{audience}

{format_guide}

{anti_slop}
"""

# Write context file
context_path = HOOKS_OUTPUT / "brand-context.md"
context_path.write_text(context)

# JSON output
output = {
    "status": "completed",
    "has_custom_brand_voice": bool(sys.argv[1].strip()) if len(sys.argv) > 1 else False,
    "format": content_format,
    "audience": audience,
    "context_path": str(context_path),
}

print(json.dumps(output))
