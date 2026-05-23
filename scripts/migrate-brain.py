#!/usr/bin/env python3
"""
SecondBrain → Vault Migration Script

Migrates notes from ~/SecondBrain/ to ~/vault/ with:
- Zone mapping (numbered folders → flat zones)
- Type remapping (62 unmapped types → vault-compatible)
- Wikilink path rewriting (strip numbered prefixes)
- Duplicate detection (newest-mtime wins)
- Frontmatter patching (add missing required fields)
- Media file copying (PNGs, Excalidraw alongside .md)
- Dry-run mode (report without writing)

Usage:
  python3 scripts/migrate-brain.py --dry-run    # Report only
  python3 scripts/migrate-brain.py --execute    # Actually migrate
"""

import os
import re
import sys
import shutil
import json
from pathlib import Path
from datetime import datetime
from collections import Counter

# ── Configuration ──

SB_ROOT = Path.home() / "SecondBrain"
VAULT_ROOT = Path.home() / "vault"

# Folders to skip entirely
SKIP_DIRS = {'.obsidian', '_search_index', '.git', 'node_modules', 'templates', '.trash', 'ready'}
SKIP_FILES = {'_catalog.json', '_pending-fixes.json', 'VAULT-INDEX.md', '.DS_Store'}

# Zone mapping: SecondBrain folder → vault zone
ZONE_MAP = {
    '00-inbox':     'inbox',
    '01-projects':  'projects',
    '02-areas':     None,          # Sub-mapped below
    '03-resources': None,          # Sub-mapped below
    '04-knowledge': None,          # Sub-mapped below
    '05-archive':   'archive',
}

# Sub-mappings for 02-areas
AREA_MAP = {
    'claude-soul':   'operations',     # Soul system → operations
    'coding':        'knowledge',
    'cooking':       'knowledge',      # Recipes → knowledge with type:recipe
    'crm':           'knowledge',
    'devops':        'knowledge',
    'personal':      'inbox',
    'pipelines':     'operations',
    'signal-forge':  'content',        # Signal Forge outputs → content
    'tasks':         'inbox',
}

# Sub-mappings for 03-resources
RESOURCE_MAP = {
    'debugging':      'knowledge',
    'frameworks':     'knowledge',
    'patterns':       'knowledge',
    'skills-manual':  'knowledge',
    'snippets':       'knowledge',
}

# Sub-mappings for 04-knowledge
KNOWLEDGE_MAP = {
    'decisions':  'knowledge',
    'learnings':  'knowledge',
    'research':   'knowledge',
}

# Type remapping
TYPE_REMAP = {
    'adr':                  'decision',
    'analytics':            'analysis',
    'architecture':         'decision',
    'architecture-review':  'decision',
    'area':                 'guide',
    'area-index':           'index',
    'audit':                'report',
    'changelog':            'output',
    'content-draft':        'draft',
    'data-pack':            'data-pack',
    'ideas-bank':           'ideas',
    'legal-document':       'reference',
    'linkedin-draft':       'social-draft',
    'market-dashboard':     'signal-report',
    'market-decision':      'signal-report',
    'market-discovery':     'signal-report',
    'media-output':         'media-asset',
    'project-plan':         'project',
    'research-report':      'report',
    'resource':             'reference',
    'snapshot':             'signal-report',
    'strategist-prep':      'strategist-prep',
    'twitter-draft':        'social-draft',
    'twitter-thread':       'social-post',
    'twitter-thread-draft': 'social-draft',
    'weekly-review':        'review',
    'soul':                 'config',
    'identity':             'config',
    'boundaries':           'config',
    'vision':               'config',
    'user-profile':         'config',
    'system-config':        'config',
    'action-list':          'task',
    'tracking':             'task',
}

# Types that go to specific zones regardless of source folder
TYPE_ZONE_OVERRIDE = {
    'agent-profile': 'operations',
    'config':        'operations',
    'playbook':      'operations',
    'session-log':   'operations',
    'recipe':        'knowledge',
    'pattern':       'knowledge',
    'snippet':       'knowledge',
    'research':      'knowledge',
    'report':        'knowledge',
    'analysis':      'knowledge',
    'review':        'knowledge',
    'decision':      'knowledge',
    'learning':      'knowledge',
    'debugging':     'knowledge',
    'reference':     'knowledge',
    'guide':         'knowledge',
    'wiki':          'knowledge',
    'draft':         'content',
    'social-draft':  'content',
    'social-post':   'content',
    'article-draft': 'content',
    'video-script':  'content',
    'video-script-draft': 'content',
    'content-menu':  'content',
    'content-prep':  'content',
    'ideas':         'content',
    'daily-quote':   'content',
    'media-asset':   'content',
    'insight-draft': 'content',
    'miner-report':  'content',
    'signal-report': 'content',
    'strategist-prep': 'content',
}

# Wikilink path rewrites (strip numbered prefixes)
WIKILINK_REWRITES = [
    (r'\[\[00-inbox/', '[[inbox/'),
    (r'\[\[01-projects/', '[[projects/'),
    (r'\[\[02-areas/signal-forge/', '[[content/signal-forge/'),
    (r'\[\[02-areas/claude-soul/', '[[operations/claude-soul/'),
    (r'\[\[02-areas/cooking/', '[[knowledge/cooking/'),
    (r'\[\[02-areas/pipelines/', '[[operations/pipelines/'),
    (r'\[\[02-areas/', '[[knowledge/'),
    (r'\[\[03-resources/patterns/', '[[knowledge/patterns/'),
    (r'\[\[03-resources/debugging/', '[[knowledge/debugging/'),
    (r'\[\[03-resources/', '[[knowledge/'),
    (r'\[\[04-knowledge/research/', '[[knowledge/research/'),
    (r'\[\[04-knowledge/decisions/', '[[knowledge/decisions/'),
    (r'\[\[04-knowledge/learnings/', '[[knowledge/learnings/'),
    (r'\[\[04-knowledge/', '[[knowledge/'),
    (r'\[\[05-archive/', '[[archive/'),
]


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from markdown content."""
    if not content.startswith('---\n'):
        return {}, content
    end = content.find('\n---\n', 4)
    if end == -1:
        # Try \n---\r\n or just \n--- at EOF
        end = content.find('\n---', 4)
        if end == -1:
            return {}, content

    fm_text = content[4:end]
    body = content[end+4:].lstrip('\n') if end + 4 < len(content) else ''

    meta = {}
    current_key = None
    list_mode = False

    for line in fm_text.split('\n'):
        stripped = line.strip()
        if not stripped:
            continue

        # List item
        if stripped.startswith('- ') and current_key and list_mode:
            val = stripped[2:].strip().strip('"').strip("'")
            meta[current_key].append(val)
            continue

        # Key-value
        if ':' in stripped:
            key, _, val = stripped.partition(':')
            key = key.strip()
            val = val.strip().strip('"').strip("'")

            if val == '' or val == '[]':
                meta[key] = []
                current_key = key
                list_mode = True
            elif val.startswith('[') and val.endswith(']'):
                # Inline array
                items = [v.strip().strip('"').strip("'") for v in val[1:-1].split(',') if v.strip()]
                meta[key] = items
                current_key = key
                list_mode = False
            else:
                meta[key] = val
                current_key = key
                list_mode = False

    return meta, body


def rebuild_frontmatter(meta: dict, body: str) -> str:
    """Rebuild markdown content with frontmatter."""
    lines = ['---']
    for key, val in meta.items():
        if isinstance(val, list):
            if len(val) == 0:
                lines.append(f'{key}: []')
            elif len(val) <= 5 and all(isinstance(v, str) and ',' not in v for v in val):
                items = ', '.join(val)
                lines.append(f'{key}: [{items}]')
            else:
                lines.append(f'{key}:')
                for item in val:
                    lines.append(f'  - {item}')
        elif isinstance(val, bool):
            lines.append(f'{key}: {"true" if val else "false"}')
        else:
            lines.append(f'{key}: {val}')
    lines.append('---')
    lines.append('')
    return '\n'.join(lines) + body


def resolve_zone(sb_path: str, meta: dict) -> str:
    """Determine target vault zone for a SecondBrain file."""
    parts = sb_path.split('/')
    top_folder = parts[0] if parts else ''

    # Check type-based zone override first
    note_type = meta.get('type', '')
    remapped_type = TYPE_REMAP.get(note_type, note_type)
    if remapped_type in TYPE_ZONE_OVERRIDE:
        return TYPE_ZONE_OVERRIDE[remapped_type]

    # Folder-based mapping
    if top_folder in ZONE_MAP and ZONE_MAP[top_folder] is not None:
        zone = ZONE_MAP[top_folder]
        if top_folder == '01-projects' and len(parts) > 1:
            # Keep project subfolder structure
            return f"projects/{'/'.join(parts[1:])}"
        return zone

    # Sub-mappings
    if top_folder == '02-areas' and len(parts) > 1:
        area = parts[1]
        zone = AREA_MAP.get(area, 'knowledge')
        # Keep subfolder structure for signal-forge
        if area == 'signal-forge' and len(parts) > 2:
            return f"content/signal-forge/{'/'.join(parts[2:])}"
        if area == 'claude-soul':
            return f"operations/claude-soul/{'/'.join(parts[2:])}" if len(parts) > 2 else 'operations/claude-soul'
        return zone

    if top_folder == '03-resources' and len(parts) > 1:
        return RESOURCE_MAP.get(parts[1], 'knowledge')

    if top_folder == '04-knowledge' and len(parts) > 1:
        return KNOWLEDGE_MAP.get(parts[1], 'knowledge')

    return 'inbox'  # fallback


def resolve_target_path(sb_path: str, meta: dict) -> str:
    """Determine full target path (zone + relative path) in vault."""
    parts = sb_path.split('/')
    filename = parts[-1]

    zone = resolve_zone(sb_path, meta)

    # For projects, preserve subfolder structure minus the numbered prefix
    if zone.startswith('projects/'):
        # sb: 01-projects/soul-hub/decisions/foo.md → vault: projects/soul-hub/decisions/foo.md
        return zone if zone.endswith(filename) else f"{zone}/{filename}" if not '/' in zone.split('/')[-1] or zone.endswith('/') else zone

    # For signal-forge content, preserve report structure
    if 'signal-forge' in zone:
        return f"{zone}/{filename}" if not zone.endswith(filename) else zone

    # For everything else, flat in zone
    return f"{zone}/{filename}"


def rewrite_wikilinks(content: str) -> str:
    """Rewrite wikilinks to use vault paths instead of SecondBrain paths."""
    for pattern, replacement in WIKILINK_REWRITES:
        content = re.sub(pattern, replacement, content)
    return content


def patch_frontmatter(meta: dict, sb_path: str, target_zone: str) -> dict:
    """Patch frontmatter to comply with vault governance."""
    meta = dict(meta)  # copy

    # Remap type
    if 'type' in meta and meta['type'] in TYPE_REMAP:
        meta['type'] = TYPE_REMAP[meta['type']]

    # Ensure required global fields
    if 'type' not in meta or not meta['type']:
        # Guess type from filename or path
        if 'recipe' in sb_path.lower() or 'cooking' in sb_path.lower():
            meta['type'] = 'recipe'
        elif 'pattern' in sb_path.lower():
            meta['type'] = 'pattern'
        elif 'research' in sb_path.lower():
            meta['type'] = 'research'
        elif 'decision' in sb_path.lower() or 'adr' in sb_path.lower():
            meta['type'] = 'decision'
        elif 'debug' in sb_path.lower():
            meta['type'] = 'debugging'
        elif 'index' in sb_path.lower():
            meta['type'] = 'index'
        elif 'draft' in sb_path.lower():
            meta['type'] = 'draft'
        else:
            meta['type'] = 'reference'

    if 'created' not in meta or not meta['created']:
        # Try to extract date from filename
        date_match = re.match(r'(\d{4}-\d{2}-\d{2})', Path(sb_path).stem)
        if date_match:
            meta['created'] = date_match.group(1)
        else:
            meta['created'] = datetime.now().strftime('%Y-%m-%d')

    if 'tags' not in meta or not meta['tags']:
        meta['tags'] = ['imported']
    elif isinstance(meta['tags'], str):
        meta['tags'] = [meta['tags']]

    # Zone-specific required fields
    if target_zone.startswith('projects/') and 'project' not in meta:
        # Extract project name from path
        project_parts = target_zone.split('/')
        if len(project_parts) >= 2:
            meta['project'] = project_parts[1]

    if target_zone == 'knowledge' and meta['type'] in ('research', 'report', 'analysis'):
        if 'source' not in meta:
            meta['source'] = 'secondbrain-import'

    if target_zone == 'knowledge' and meta['type'] in ('pattern', 'snippet'):
        if 'language' not in meta:
            meta['language'] = 'mixed'

    return meta


def scan_secondbrain() -> list[dict]:
    """Scan SecondBrain and build migration plan."""
    plan = []

    for root, dirs, files in os.walk(SB_ROOT):
        # Filter out skip dirs
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]

        rel_root = os.path.relpath(root, SB_ROOT)
        if rel_root == '.':
            rel_root = ''

        for filename in files:
            if filename in SKIP_FILES:
                continue
            if filename.startswith('.'):
                continue

            sb_rel = f"{rel_root}/{filename}" if rel_root else filename
            sb_abs = os.path.join(root, filename)

            # Handle markdown files
            if filename.endswith('.md'):
                try:
                    content = open(sb_abs, 'r', encoding='utf-8').read()
                except Exception:
                    continue

                meta, body = parse_frontmatter(content)
                target_zone = resolve_zone(sb_rel, meta)
                target_path = resolve_target_path(sb_rel, meta)

                # Clean up target path (remove double slashes, trailing slashes)
                target_path = re.sub(r'/+', '/', target_path).strip('/')
                if not target_path.endswith('.md'):
                    target_path += '/' + filename

                # Check for duplicate in vault
                vault_abs = VAULT_ROOT / target_path
                is_duplicate = vault_abs.exists()

                # If duplicate, compare mtimes
                action = 'skip'
                if not is_duplicate:
                    action = 'copy'
                else:
                    sb_mtime = os.path.getmtime(sb_abs)
                    vault_mtime = os.path.getmtime(vault_abs)
                    if sb_mtime > vault_mtime:
                        action = 'overwrite'
                    else:
                        action = 'skip'

                plan.append({
                    'source': sb_rel,
                    'target': target_path,
                    'action': action,
                    'type': meta.get('type', ''),
                    'remapped_type': TYPE_REMAP.get(meta.get('type', ''), meta.get('type', '')),
                    'is_md': True,
                    'size': os.path.getsize(sb_abs),
                })

            # Handle media files
            elif filename.endswith(('.png', '.jpg', '.jpeg', '.gif', '.excalidraw')):
                target_dir = resolve_zone(sb_rel, {})
                target_path = f"{target_dir}/{filename}"
                target_path = re.sub(r'/+', '/', target_path).strip('/')

                vault_abs = VAULT_ROOT / target_path
                action = 'skip' if vault_abs.exists() else 'copy'

                plan.append({
                    'source': sb_rel,
                    'target': target_path,
                    'action': action,
                    'type': 'media',
                    'remapped_type': 'media',
                    'is_md': False,
                    'size': os.path.getsize(sb_abs),
                })

    return plan


def print_report(plan: list[dict]):
    """Print migration dry-run report."""
    actions = Counter(item['action'] for item in plan)
    zones = Counter(item['target'].split('/')[0] for item in plan if item['action'] != 'skip')
    types = Counter(item['remapped_type'] for item in plan if item['action'] != 'skip' and item['is_md'])

    print("\n" + "=" * 60)
    print("  MIGRATION DRY-RUN REPORT")
    print("=" * 60)

    print(f"\n  Total files scanned: {len(plan)}")
    print(f"  To copy:     {actions.get('copy', 0)}")
    print(f"  To overwrite: {actions.get('overwrite', 0)}")
    print(f"  To skip:     {actions.get('skip', 0)}")
    total_size = sum(item['size'] for item in plan if item['action'] != 'skip')
    print(f"  Total size:  {total_size / 1024:.0f} KB")

    print(f"\n  By target zone:")
    for zone, count in zones.most_common():
        print(f"    {zone:20s} {count:4d}")

    print(f"\n  By type (after remap):")
    for t, count in types.most_common(15):
        print(f"    {t:20s} {count:4d}")
    if len(types) > 15:
        print(f"    ... and {len(types) - 15} more types")

    # Show overwrite candidates
    overwrites = [item for item in plan if item['action'] == 'overwrite']
    if overwrites:
        print(f"\n  Overwrite candidates ({len(overwrites)}):")
        for item in overwrites[:10]:
            print(f"    {item['source'][:50]:50s} → {item['target'][:40]}")
        if len(overwrites) > 10:
            print(f"    ... and {len(overwrites) - 10} more")

    print("\n" + "=" * 60)


def execute_migration(plan: list[dict]):
    """Execute the migration."""
    copied = 0
    overwritten = 0
    errors = []

    for item in plan:
        if item['action'] == 'skip':
            continue

        source_abs = SB_ROOT / item['source']
        target_abs = VAULT_ROOT / item['target']

        try:
            # Create target directory
            target_abs.parent.mkdir(parents=True, exist_ok=True)

            if item['is_md']:
                # Read, patch, rewrite, write
                content = source_abs.read_text(encoding='utf-8')
                meta, body = parse_frontmatter(content)

                target_zone = item['target'].split('/')[0]
                meta = patch_frontmatter(meta, item['source'], target_zone)
                body = rewrite_wikilinks(body)

                new_content = rebuild_frontmatter(meta, body)
                target_abs.write_text(new_content, encoding='utf-8')
            else:
                # Media: straight copy
                shutil.copy2(str(source_abs), str(target_abs))

            if item['action'] == 'copy':
                copied += 1
            else:
                overwritten += 1

        except Exception as e:
            errors.append(f"{item['source']}: {e}")

    print(f"\n  Migration complete:")
    print(f"    Copied:     {copied}")
    print(f"    Overwritten: {overwritten}")
    print(f"    Errors:     {len(errors)}")

    if errors:
        print(f"\n  Errors:")
        for err in errors[:20]:
            print(f"    {err}")

    return copied, overwritten, errors


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('--dry-run', '--execute'):
        print("Usage: python3 scripts/migrate-brain.py --dry-run|--execute")
        sys.exit(1)

    mode = sys.argv[1]

    print(f"Scanning {SB_ROOT}...")
    plan = scan_secondbrain()

    print_report(plan)

    if mode == '--dry-run':
        print("\n  This was a dry run. Use --execute to migrate.")
    elif mode == '--execute':
        print("\n  Executing migration...")
        copied, overwritten, errors = execute_migration(plan)

        # Trigger vault reindex
        print("\n  Triggering vault reindex...")
        import urllib.request
        try:
            req = urllib.request.Request('http://localhost:2400/api/vault/reindex', method='POST')
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                print(f"  Reindexed: {data.get('stats', {}).get('totalNotes', '?')} notes")
        except Exception as e:
            print(f"  Reindex failed (run manually): {e}")


if __name__ == '__main__':
    main()
