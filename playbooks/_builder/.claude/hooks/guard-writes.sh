#!/bin/bash
# Guard: validate playbook file writes for structure and governance compliance
# Allowed paths: playbooks/*, /tmp/*, plan files
# Validates: playbook.yaml structure, role files, model aliases, variable refs

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

SOUL_HUB="$HOME/dev/soul-hub"
PLAYBOOKS="$SOUL_HUB/playbooks"

# Check if path is under allowed directories
ALLOWED=false
case "$FILE_PATH" in
  "$PLAYBOOKS"/*)          ALLOWED=true ;;
  /tmp/*)                  ALLOWED=true ;;
  */.claude/plan*)         ALLOWED=true ;;
  */PLAN.md)               ALLOWED=true ;;
  */.plan*)                ALLOWED=true ;;
esac

if [ "$ALLOWED" = "false" ]; then
  echo "BLOCKED: You cannot modify files outside playbooks/ ($FILE_PATH). Instead, create a fix request:"
  echo ""
  echo "Write to: playbooks/<name>/.fix-requests/<timestamp>.md"
  echo "Format: type: fix-request, file: <path>, severity: blocking|warning"
  exit 2
fi

# --- Content validation for allowed paths ---

BASENAME=$(basename "$FILE_PATH")
CONTENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('tool_input',{}).get('content',''); print(c)" 2>/dev/null)

# ─── playbook.yaml: full governance validation ───
if [ "$BASENAME" = "playbook.yaml" ] && [ -n "$CONTENT" ]; then

  # Required sections
  if ! echo "$CONTENT" | grep -q 'roles:'; then
    echo "BLOCKED: playbook.yaml must contain a 'roles:' section"
    echo "See CONTRACTS.md § 1 for the full schema."
    exit 2
  fi
  if ! echo "$CONTENT" | grep -q 'phases:'; then
    echo "BLOCKED: playbook.yaml must contain a 'phases:' section"
    exit 2
  fi
  if ! echo "$CONTENT" | grep -q 'output:'; then
    echo "BLOCKED: playbook.yaml must contain an 'output:' section"
    exit 2
  fi
  if ! echo "$CONTENT" | grep -q 'type: playbook'; then
    if ! echo "$CONTENT" | grep -q 'type: playbook-chain'; then
      echo "BLOCKED: playbook.yaml must have 'type: playbook' or 'type: playbook-chain'"
      exit 2
    fi
  fi

  # Model alias validation — block full model IDs
  if echo "$CONTENT" | grep -qE 'model:\s*(claude-sonnet|claude-opus|claude-haiku|claude-[0-9])'; then
    echo "BLOCKED: Use model aliases (sonnet, opus, haiku) — not full model IDs like claude-sonnet-4."
    echo "The engine translates aliases to the correct model version."
    exit 2
  fi

  # Every role must have an agent: field pointing to a .md file
  if echo "$CONTENT" | grep -q 'roles:'; then
    ROLES_WITHOUT_AGENT=$(echo "$CONTENT" | python3 -c "
import sys, yaml
try:
    spec = yaml.safe_load(sys.stdin)
    for r in spec.get('roles', []):
        if not r.get('agent'):
            print(f'Role \"{r.get(\"id\", \"?\")}\" is missing agent: field')
except: pass
" 2>/dev/null)
    if [ -n "$ROLES_WITHOUT_AGENT" ]; then
      echo "BLOCKED: $ROLES_WITHOUT_AGENT"
      echo "Every role must have 'agent: roles/<name>.md' pointing to a role definition file."
      exit 2
    fi
  fi

  # Validate phase types
  INVALID_PHASES=$(echo "$CONTENT" | python3 -c "
import sys, yaml
VALID = {'sequential','parallel','handoff','gate','human','consensus'}
try:
    spec = yaml.safe_load(sys.stdin)
    for p in spec.get('phases', []):
        t = p.get('type','')
        if t not in VALID:
            print(f'Phase \"{p.get(\"id\",\"?\")}\" has invalid type \"{t}\". Valid: {VALID}')
except: pass
" 2>/dev/null)
  if [ -n "$INVALID_PHASES" ]; then
    echo "BLOCKED: $INVALID_PHASES"
    exit 2
  fi

  # Validate variable references ($inputs.X must match declared inputs)
  INVALID_REFS=$(echo "$CONTENT" | python3 -c "
import sys, yaml, re
try:
    spec = yaml.safe_load(sys.stdin)
    input_ids = {i['id'] for i in spec.get('inputs', [])}
    phase_ids = {p['id'] for p in spec.get('phases', [])}
    # Check all string values for \$inputs.X references
    yaml_str = yaml.dump(spec)
    for ref in re.findall(r'\\\$inputs\.(\w+)', yaml_str):
        if ref not in input_ids:
            print(f'\$inputs.{ref} referenced but not declared in inputs. Declared: {input_ids}')
    for ref in re.findall(r'\\\$phases\.(\w+)', yaml_str):
        if ref not in phase_ids:
            print(f'\$phases.{ref} referenced but phase \"{ref}\" not declared. Declared: {phase_ids}')
except: pass
" 2>/dev/null)
  if [ -n "$INVALID_REFS" ]; then
    echo "WARNING: $INVALID_REFS"
    echo "This may cause runtime errors. Fix the references or declare the missing inputs/phases."
    # Warning only — don't block (refs might be valid but complex)
  fi

  # Handoff phases must have between: and loop_until:
  HANDOFF_ERRORS=$(echo "$CONTENT" | python3 -c "
import sys, yaml
try:
    spec = yaml.safe_load(sys.stdin)
    for p in spec.get('phases', []):
        if p.get('type') == 'handoff':
            if not p.get('between'):
                print(f'Handoff phase \"{p[\"id\"]}\" missing \"between: [role-a, role-b]\"')
            if not p.get('loop_until'):
                print(f'Handoff phase \"{p[\"id\"]}\" missing \"loop_until:\" condition')
except: pass
" 2>/dev/null)
  if [ -n "$HANDOFF_ERRORS" ]; then
    echo "BLOCKED: $HANDOFF_ERRORS"
    exit 2
  fi
fi

# ─── Role .md files: must start with # heading ───
case "$FILE_PATH" in
  */roles/*.md)
    if [ -n "$CONTENT" ]; then
      FIRST_REAL=$(echo "$CONTENT" | grep -v '^---' | grep -v '^$' | head -1)
      if ! echo "$FIRST_REAL" | grep -q '^#'; then
        echo "BLOCKED: Role files must start with a # heading (after optional frontmatter)"
        exit 2
      fi
    fi
    ;;
esac

# ─── Config files must be .json ───
case "$FILE_PATH" in
  */config/*.md)
    echo "BLOCKED: Config files must be .json, not .md"
    exit 2
    ;;
esac

exit 0
