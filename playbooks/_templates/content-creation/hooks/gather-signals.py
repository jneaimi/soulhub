#!/usr/bin/env python3
"""
Pre-run hook: gather social signals for a topic.
Uses the /research skill's social_collector if APIDIRECT_API_KEY is set.
Falls back to a basic prompt context if no API key.

Usage: python3 hooks/gather-signals.py "<topic>" "<format>"
Output: JSON to stdout + hooks/output/signals-report.md
"""
import sys
import os
import json
import subprocess
from pathlib import Path

HOOKS_OUTPUT = Path(__file__).parent / "output"
HOOKS_OUTPUT.mkdir(exist_ok=True)

topic = sys.argv[1] if len(sys.argv) > 1 else ""
content_format = sys.argv[2] if len(sys.argv) > 2 else "blog-post"

api_key = os.environ.get("APIDIRECT_API_KEY", "")
collector_script = os.path.expanduser("~/.claude/skills/research/scripts/social_collector.py")

signals_found = 0
report_lines = []

if api_key and os.path.exists(collector_script):
    # Use social collector to search for real signals
    try:
        # Search across platforms for the topic
        result = subprocess.run(
            [
                "python3", collector_script, "search",
                "--query", topic,
                "--platforms", "twitter,reddit,linkedin",
                "--compact", "--dedup",
                "--min-views", "50",
                "--max-results", "15",
            ],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "APIDIRECT_API_KEY": api_key},
        )
        if result.returncode == 0 and result.stdout.strip():
            report_lines.append(f"# Social Signals: {topic}\n")
            report_lines.append(f"**Source:** Live search via social_collector\n")
            report_lines.append(f"**Format target:** {content_format}\n\n")
            report_lines.append(result.stdout)
            signals_found = result.stdout.count("http")  # rough count of links
        else:
            report_lines.append(f"# Social Signals: {topic}\n")
            report_lines.append("No signals found via live search. Researcher should use training knowledge.\n")
    except (subprocess.TimeoutExpired, Exception) as e:
        report_lines.append(f"# Social Signals: {topic}\n")
        report_lines.append(f"Signal collection failed: {e}\nResearcher should use training knowledge.\n")
else:
    # No API key — provide format-aware context instead
    format_guidance = {
        "blog-post": "Target: 800-1200 words, SEO-friendly title, 3-5 subheadings, meta description",
        "newsletter": "Target: 400-600 words, scannable format, bullet points, single CTA",
        "linkedin-post": "Target: 150-300 words, personal hook, professional tone, engagement CTA",
        "technical-article": "Target: 1500-2500 words, code examples, detailed explanations, prerequisites section",
    }
    guidance = format_guidance.get(content_format, format_guidance["blog-post"])

    report_lines.append(f"# Content Brief: {topic}\n")
    report_lines.append(f"**Format:** {content_format}\n")
    report_lines.append(f"**Guidelines:** {guidance}\n\n")
    report_lines.append("No live social signals available (APIDIRECT_API_KEY not set).\n")
    report_lines.append("Researcher should use training knowledge and general best practices.\n")

# Write report
report_content = "\n".join(report_lines)
report_path = HOOKS_OUTPUT / "signals-report.md"
report_path.write_text(report_content)

# JSON output for engine
output = {
    "status": "completed",
    "signals_found": signals_found,
    "has_api_key": bool(api_key),
    "format": content_format,
    "report_path": str(report_path),
}

print(json.dumps(output))
