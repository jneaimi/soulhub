#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Generate daily action notes and inject into the weekly task board.

Reads pipeline outputs (content menu, drafts, seeds, strategist brief)
and produces:
  1. actions/{DATE}-market-intel.md -- detailed daily actions
  2. Appends a section to 02-areas/tasks/YYYY-WNN-tasks.md -- task board integration

Config via BLOCK_CONFIG_* env vars:
    BLOCK_CONFIG_MODE     — daily or weekly (default: daily)
    BLOCK_CONFIG_DATE     — override date YYYY-MM-DD (default: today)
    BLOCK_CONFIG_NO_INJECT — true/false skip task board injection (default: false)

Path resolution via:
    PIPELINE_DIR    — root of the installed pipeline (contains config/)
    PIPELINE_OUTPUT — optional, Soul Hub verifies this file

Usage:
    run.py                   Daily actions (after pipeline)
    run.py --weekly          Weekly review (after weekly pipeline)
    run.py --date 2026-03-27 Override date
"""

import argparse
import glob
import json
import os
import re
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ── Path resolution via PIPELINE_DIR ─────────────
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
CONFIG_DIR = PIPELINE_DIR / "config"

BRAIN = os.path.expanduser("~/SecondBrain")
TASKS_DIR = os.path.join(BRAIN, "02-areas/tasks")
OUTPUT_BASE = Path.home() / "SecondBrain" / "02-areas" / "pipelines" / "market-intel"
REPORTS_DIR = str(OUTPUT_BASE)
ACTIONS_DIR = str(OUTPUT_BASE / "actions")
DRAFTS_BASE = str(OUTPUT_BASE / "drafts")
IDEAS_DIR = str(OUTPUT_BASE / "ideas")

MODE = os.environ.get("BLOCK_CONFIG_MODE", "daily")
DATE_OVERRIDE = os.environ.get("BLOCK_CONFIG_DATE", "")
NO_INJECT = os.environ.get("BLOCK_CONFIG_NO_INJECT", "false").lower() == "true"


def get_week_number(date_str):
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return f"{dt.isocalendar()[0]}-W{dt.isocalendar()[1]:02d}"


def get_day_name(date_str):
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return dt.strftime("%A %b %d")


def find_drafts(date_str, platform_filter=None):
    drafts_dir = os.path.join(DRAFTS_BASE, date_str)
    if not os.path.isdir(drafts_dir):
        return []

    drafts = []
    for f in sorted(os.listdir(drafts_dir)):
        if not f.endswith(".md"):
            continue

        parts = f.replace(".md", "").rsplit("-", 2)
        if len(parts) < 3:
            continue

        lang = parts[-1]
        platform = parts[-2]
        slug = "-".join(f.replace(".md", "").rsplit("-", 2)[:-2])

        if platform_filter and platform not in platform_filter:
            continue

        filepath = os.path.join(drafts_dir, f)
        status = "draft"
        finding_title = slug.replace("-", " ").title()
        tier = ""
        try:
            with open(filepath) as fh:
                content = fh.read()
                m = re.search(r"^status:\s*(.+)$", content, re.MULTILINE)
                if m:
                    status = m.group(1).strip()
                m = re.search(r"^finding_title:\s*[\"']?(.+?)[\"']?\s*$", content, re.MULTILINE)
                if m:
                    finding_title = m.group(1).strip()
                m = re.search(r"^topic:\s*(.+)$", content, re.MULTILINE)
                if m:
                    finding_title = m.group(1).strip()
                m = re.search(r"^tier:\s*(.+)$", content, re.MULTILINE)
                if m:
                    tier = m.group(1).strip()
        except Exception:
            pass

        drafts.append({
            "file": f,
            "path": filepath,
            "slug": slug,
            "platform": platform,
            "lang": lang,
            "status": status,
            "title": finding_title,
            "tier": tier,
            "date": date_str,
        })

    return drafts


def find_backlog(today_str, platform_filter=None, lookback_days=7):
    backlog = []
    today = datetime.strptime(today_str, "%Y-%m-%d")

    for i in range(1, lookback_days + 1):
        past_date = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        drafts = find_drafts(past_date, platform_filter)
        for d in drafts:
            if d["status"] == "draft":
                backlog.append(d)

    return backlog


def find_seeds(date_str):
    seeds_file = os.path.join(IDEAS_DIR, f"{date_str}-seeds.json")
    if not os.path.isfile(seeds_file):
        return []
    try:
        with open(seeds_file) as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            if isinstance(data, dict) and "seeds" in data:
                return data["seeds"]
            return []
    except Exception:
        return []


def read_active_platforms():
    config_path = str(CONFIG_DIR / "content-forge-config.md")
    if not os.path.isfile(config_path):
        return ["linkedin"]

    try:
        with open(config_path) as f:
            content = f.read()
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("#"):
                continue
            if line.startswith("platforms:"):
                m = re.search(r"\[([^\]]+)\]", line)
                if m:
                    return [p.strip() for p in m.group(1).split(",")]
    except Exception:
        pass

    return ["linkedin"]


def generate_daily_actions(date_str):
    platforms = read_active_platforms()
    drafts = find_drafts(date_str, platforms)
    backlog = find_backlog(date_str, platforms)
    seeds = find_seeds(date_str)
    menu_path = os.path.join(REPORTS_DIR, f"{date_str}-content-menu.md")
    has_menu = os.path.isfile(menu_path)

    lines = [
        "---",
        "type: action-list",
        f"created: {date_str}",
        "source: pipeline",
        "status: open",
        "tags: [market-intel, actions, daily]",
        "---",
        "",
        f"# Actions — {date_str}",
        "",
    ]

    if has_menu:
        lines.append("## Review Content Menu")
        lines.append(f"- [ ] Review today's content menu -> [[pipelines/market-intel/{date_str}-content-menu]]")
        lines.append("")

    if drafts:
        hot_drafts = [d for d in drafts if d["tier"].lower() == "hot"]
        warm_drafts = [d for d in drafts if d["tier"].lower() == "warm"]
        other_drafts = [d for d in drafts if d["tier"].lower() not in ("hot", "warm")]

        if hot_drafts:
            lines.append("## Post Today (HOT)")
            for d in hot_drafts:
                lang_label = "EN" if d["lang"] == "en" else "AR"
                lines.append(f"- [ ] LinkedIn {lang_label}: \"{d['title']}\" -> [[pipelines/market-intel/drafts/{date_str}/{d['file'].replace('.md', '')}]]")
            lines.append("")

        if warm_drafts:
            lines.append("## Consider Posting (WARM)")
            for d in warm_drafts:
                lang_label = "EN" if d["lang"] == "en" else "AR"
                lines.append(f"- [ ] LinkedIn {lang_label}: \"{d['title']}\" -> [[pipelines/market-intel/drafts/{date_str}/{d['file'].replace('.md', '')}]]")
            lines.append("")

        if other_drafts:
            lines.append("## Other Drafts")
            for d in other_drafts:
                lang_label = "EN" if d["lang"] == "en" else "AR"
                lines.append(f"- [ ] LinkedIn {lang_label}: \"{d['title']}\" -> [[pipelines/market-intel/drafts/{date_str}/{d['file'].replace('.md', '')}]]")
            lines.append("")

    if seeds:
        lines.append("## Seeds to Watch")
        for s in seeds[:5]:
            title = s.get("title", s.get("title_en", "Unknown"))
            score = s.get("score", s.get("engagement_potential", "?"))
            lines.append(f"- [ ] \"{title}\" (score: {score}) -- check if signal grows tomorrow")
        lines.append("")

    if backlog:
        lines.append("## Backlog (previous days, un-posted)")
        for d in backlog:
            lang_label = "EN" if d["lang"] == "en" else "AR"
            lines.append(f"- [ ] {d['date']}: LinkedIn {lang_label}: \"{d['title']}\" -> [[pipelines/market-intel/drafts/{d['date']}/{d['file'].replace('.md', '')}]]")
        lines.append("")

    if not drafts and not backlog:
        lines.append("## No Actions Today")
        lines.append("Pipeline produced no actionable drafts. Check the Miner report for context.")
        lines.append("")

    return "\n".join(lines)


def generate_weekly_review(date_str):
    platforms = read_active_platforms()

    strategist_reports = sorted(glob.glob(os.path.join(REPORTS_DIR, "*-strategist-weekly.md")), reverse=True)
    has_strategist = len(strategist_reports) > 0

    weekly_reports = sorted(glob.glob(os.path.join(REPORTS_DIR, "*-miner-weekly.md")), reverse=True)
    has_weekly = len(weekly_reports) > 0

    week_start = datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=6)
    total_drafts = 0
    posted_drafts = 0
    for i in range(7):
        d = (week_start + timedelta(days=i)).strftime("%Y-%m-%d")
        day_drafts = find_drafts(d, platforms)
        total_drafts += len(day_drafts)
        posted_drafts += sum(1 for dd in day_drafts if dd["status"] == "posted")

    backlog = find_backlog(date_str, platforms, lookback_days=14)

    lines = [
        "---",
        "type: weekly-review",
        f"created: {date_str}",
        "source: weekly-pipeline",
        "tags: [market-intel, actions, weekly]",
        "---",
        "",
        f"# Weekly Review — {date_str}",
        "",
    ]

    if has_strategist:
        lines.append("## Business Opportunities")
        lines.append(f"- [ ] Read Business Opportunity Brief -> [[pipelines/market-intel/{os.path.basename(strategist_reports[0]).replace('.md', '')}]]")
        lines.append("- [ ] Act on top ACT NOW item -- execute first step this week")
        lines.append("")

    if has_weekly:
        lines.append("## Article Candidates")
        lines.append(f"- [ ] Check Article Radar in weekly report -> [[pipelines/market-intel/{os.path.basename(weekly_reports[0]).replace('.md', '')}]]")
        lines.append("- [ ] If READY candidate exists -- review outline, start draft")
        lines.append("")

    lines.append("## This Week's Stats")
    lines.append(f"- Drafts generated: {total_drafts}")
    lines.append(f"- Drafts posted: {posted_drafts}")
    lines.append(f"- Backlog remaining: {len(backlog)}")
    lines.append("")

    lines.append("## Content Performance (fill manually)")
    lines.append("- Best performing post: ___")
    lines.append("- Total impressions: ___")
    lines.append("- New connections from content: ___")
    lines.append("- Learnings: ___")
    lines.append("")

    if backlog:
        lines.append("## Backlog (un-posted drafts)")
        for d in backlog[:10]:
            lang_label = "EN" if d["lang"] == "en" else "AR"
            lines.append(f"- [ ] {d['date']}: LinkedIn {lang_label}: \"{d['title']}\"")
        if len(backlog) > 10:
            lines.append(f"- ...and {len(backlog) - 10} more")
        lines.append("")

    return "\n".join(lines)


def create_weekly_task_file(date_str):
    week = get_week_number(date_str)
    task_file = os.path.join(TASKS_DIR, f"{week}-tasks.md")

    if os.path.isfile(task_file):
        return task_file

    dt = datetime.strptime(date_str, "%Y-%m-%d")
    monday = dt - timedelta(days=dt.weekday())
    sunday = monday + timedelta(days=6)
    mon_str = monday.strftime("%b %d")
    sun_str = sunday.strftime("%b %d")
    week_num = dt.isocalendar()[1]

    content = f"""---
type: task
created: {date_str}
tags: [tasks, weekly, w{week_num}]
week: {week}
status: active
---

# Week {week_num} Tasks ({mon_str}-{sun_str})

## Ongoing This Week

### Social Media Launch
- [ ] Review Market Intel content menu daily
- [ ] Post 2-3 LinkedIn posts (EN + AR)
- [ ] Engage: comment on 3-5 relevant posts

---

## Completed

_(check off items as you complete them)_

---

## Notes

"""
    os.makedirs(TASKS_DIR, exist_ok=True)
    with open(task_file, "w") as f:
        f.write(content)

    index_file = os.path.join(TASKS_DIR, "index.md")
    if os.path.isfile(index_file):
        with open(index_file) as f:
            index_content = f.read()

        new_link = f"- [[{week}-tasks]] -- Week {week_num} ({mon_str}-{sun_str})"
        if f"[[{week}-tasks]]" not in index_content:
            if "## This Week" in index_content and "## Archive" in index_content:
                this_week_section = index_content.split("## This Week")[1].split("## Archive")[0]
                old_links = [l.strip() for l in this_week_section.strip().split("\n") if l.strip().startswith("- [[")]
                archive_section = index_content.split("## Archive")[1]

                index_content = index_content.split("## This Week")[0]
                index_content += f"## This Week\n\n{new_link}\n\n## Archive\n"
                for old in old_links:
                    index_content += f"\n{old}"
                index_content += archive_section if not archive_section.strip().startswith("_") else f"\n{archive_section}"

                with open(index_file, "w") as f:
                    f.write(index_content)

    return task_file


def inject_into_task_board(date_str, is_weekly=False):
    week = get_week_number(date_str)
    task_file = os.path.join(TASKS_DIR, f"{week}-tasks.md")

    if not os.path.isfile(task_file):
        task_file = create_weekly_task_file(date_str)

    platforms = read_active_platforms()
    day_name = get_day_name(date_str)

    section_lines = [
        "",
        f"## {day_name}",
        "",
    ]

    if is_weekly:
        section_lines.append("### Market Intel — Weekly Review (auto-generated)")
        strategist_reports = sorted(glob.glob(os.path.join(REPORTS_DIR, "*-strategist-weekly.md")), reverse=True)
        weekly_reports = sorted(glob.glob(os.path.join(REPORTS_DIR, "*-miner-weekly.md")), reverse=True)

        if strategist_reports:
            section_lines.append(f"- [ ] Read Business Opportunity Brief -> [[pipelines/market-intel/{os.path.basename(strategist_reports[0]).replace('.md', '')}]]")
        if weekly_reports:
            section_lines.append(f"- [ ] Check Article Radar -> [[pipelines/market-intel/{os.path.basename(weekly_reports[0]).replace('.md', '')}]]")
        section_lines.append(f"- [ ] Review weekly actions -> [[pipelines/market-intel/actions/{date_str}-weekly-review]]")
    else:
        section_lines.append("### Market Intel — Content (auto-generated)")

        drafts = find_drafts(date_str, platforms)
        menu_path = os.path.join(REPORTS_DIR, f"{date_str}-content-menu.md")

        if os.path.isfile(menu_path):
            section_lines.append(f"- [ ] Review content menu -> [[pipelines/market-intel/{date_str}-content-menu]]")

        for d in drafts:
            if d["status"] != "draft":
                continue
            lang_label = "EN" if d["lang"] == "en" else "AR"
            section_lines.append(f"- [ ] Post LinkedIn {lang_label}: \"{d['title']}\" -> [[pipelines/market-intel/drafts/{date_str}/{d['file'].replace('.md', '')}]]")

        backlog = find_backlog(date_str, platforms, lookback_days=7)
        if backlog:
            section_lines.append("")
            section_lines.append("### Market Intel — Backlog")
            for bl in backlog[:5]:
                lang_label = "EN" if bl["lang"] == "en" else "AR"
                section_lines.append(f"- [ ] {bl['date']}: LinkedIn {lang_label}: \"{bl['title']}\"")

    section_text = "\n".join(section_lines) + "\n"

    with open(task_file) as f:
        content = f.read()

    marker = f"## {day_name}"
    if marker in content:
        if "Market Intel" in content.split(marker, 1)[1].split("\n## ", 1)[0]:
            return False

    if "## Completed" in content:
        parts = content.split("## Completed", 1)
        content = parts[0].rstrip() + "\n" + section_text + "\n## Completed" + parts[1]
    elif "---" in content and content.rstrip().endswith("---"):
        idx = content.rstrip().rfind("---")
        content = content[:idx].rstrip() + "\n" + section_text + "\n---\n"
    else:
        content = content.rstrip() + "\n" + section_text

    with open(task_file, "w") as f:
        f.write(content)

    return True


def main():
    parser = argparse.ArgumentParser(description="Generate Market Intel action notes")
    parser.add_argument("--weekly", action="store_true", help="Generate weekly review")
    parser.add_argument("--date", default=None, help="Date (default: today)")
    parser.add_argument("--no-inject", action="store_true", help="Don't inject into task board")
    args = parser.parse_args()

    is_weekly = args.weekly or MODE == "weekly"
    date_str = args.date or DATE_OVERRIDE or datetime.now().strftime("%Y-%m-%d")
    no_inject = args.no_inject or NO_INJECT

    os.makedirs(ACTIONS_DIR, exist_ok=True)

    if is_weekly:
        content = generate_weekly_review(date_str)
        action_file = os.path.join(ACTIONS_DIR, f"{date_str}-weekly-review.md")
        with open(action_file, "w") as f:
            f.write(content)
        print(json.dumps({"type": "weekly", "file": action_file}))

        if not no_inject:
            injected = inject_into_task_board(date_str, is_weekly=True)
            if injected:
                print(json.dumps({"injected": True, "target": "task-board"}))
    else:
        content = generate_daily_actions(date_str)
        action_file = os.path.join(ACTIONS_DIR, f"{date_str}-market-intel.md")
        with open(action_file, "w") as f:
            f.write(content)
        print(json.dumps({"type": "daily", "file": action_file}))

        if not no_inject:
            injected = inject_into_task_board(date_str, is_weekly=False)
            if injected:
                print(json.dumps({"injected": True, "target": "task-board"}))

    # Copy to PIPELINE_OUTPUT if set (Soul Hub verifies this file)
    pipeline_output = os.environ.get("PIPELINE_OUTPUT")
    if pipeline_output and os.path.isfile(action_file):
        os.makedirs(os.path.dirname(pipeline_output), exist_ok=True)
        if pipeline_output != action_file:
            shutil.copy2(action_file, pipeline_output)


if __name__ == "__main__":
    main()
