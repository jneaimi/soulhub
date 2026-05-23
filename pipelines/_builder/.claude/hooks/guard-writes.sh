#!/bin/bash
# Guard: block file writes outside allowed builder destinations
# Allowed: catalog/scripts/*, catalog/agents/*, pipelines/*/
# Blocked: everything else (src/, node_modules/, .claude/, etc.)

# Read the tool input from stdin
INPUT=$(cat)

# Extract the file_path from the JSON input
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0  # No file path — not a write tool, allow
fi

# Resolve to absolute path
SOUL_HUB="$HOME/dev/soul-hub"
CATALOG_SCRIPTS="$SOUL_HUB/catalog/scripts"
CATALOG_AGENTS="$SOUL_HUB/catalog/agents"
PIPELINES="$SOUL_HUB/pipelines"

# Check if path is under allowed directories
ALLOWED=false
case "$FILE_PATH" in
  "$CATALOG_SCRIPTS"/*) ALLOWED=true ;;
  "$CATALOG_AGENTS"/*)  ALLOWED=true ;;
  "$PIPELINES"/*)       ALLOWED=true ;;
  /tmp/*)               ALLOWED=true ;;
  # Allow Claude Plan mode files (.claude/plan*, PLAN.md, etc.)
  */.claude/plan*)      ALLOWED=true ;;
  */PLAN.md)            ALLOWED=true ;;
  */.plan*)             ALLOWED=true ;;
  # Allow staged components review folder
  "$SOUL_HUB"/pipelines/_builder/staged-components/*) ALLOWED=true ;;
esac

if [ "$ALLOWED" = "false" ]; then
  echo "BLOCKED: You cannot modify core files ($FILE_PATH). Instead, create a fix request:"
  echo ""
  echo "Write a fix request to: pipelines/<pipeline-name>/.fix-requests/<timestamp>.md"
  echo "Format:"
  echo "  ---"
  echo "  type: fix-request"
  echo "  file: <path to the file that needs fixing>"
  echo "  severity: blocking|warning"
  echo "  status: pending"
  echo "  ---"
  echo "  # Title"
  echo "  ## Bug (what's wrong)"
  echo "  ## Fix (diff or description)"
  echo "  ## Workaround (if any)"
  echo ""
  echo "The user will review and apply the fix outside the builder."
  exit 2
fi

# --- Content validation for allowed paths ---

BASENAME=$(basename "$FILE_PATH")

# BLOCK.md must have frontmatter delimiters
if [ "$BASENAME" = "BLOCK.md" ]; then
  CONTENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('content',''))" 2>/dev/null)
  if [ -n "$CONTENT" ]; then
    if ! echo "$CONTENT" | head -1 | grep -q '^---$'; then
      echo "BLOCKED: BLOCK.md must start with --- frontmatter delimiters"
      exit 2
    fi
  fi
fi

# Config files in config/ must be .json, not .md
case "$FILE_PATH" in
  */config/*.md)
    echo "BLOCKED: Config files must be .json, not .md. Use JSON with column schema in pipeline.yaml"
    exit 2
    ;;
esac

# Block output/ writes that aren't inside a pipeline directory
case "$FILE_PATH" in
  */output/*)
    # Must be under pipelines/<name>/output/ — extract parent of output/
    PARENT=$(echo "$FILE_PATH" | sed 's|/output/.*||')
    if [ ! -f "$PARENT/pipeline.yaml" ]; then
      echo "BLOCKED: output/ writes must be inside a pipeline directory (one containing pipeline.yaml). Attempted: $FILE_PATH"
      exit 2
    fi
    ;;
esac

# Validate pipeline.yaml has required sections
if [ "$BASENAME" = "pipeline.yaml" ]; then
  CONTENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('content',''))" 2>/dev/null)
  if [ -n "$CONTENT" ]; then
    if ! echo "$CONTENT" | grep -q 'steps:'; then
      echo "BLOCKED: pipeline.yaml must contain a 'steps:' section"
      exit 2
    fi
    if ! echo "$CONTENT" | grep -q 'on_failure:'; then
      echo "BLOCKED: pipeline.yaml must contain an 'on_failure:' section"
      exit 2
    fi
  fi
fi

exit 0

