#!/bin/bash
SESSION_ID="S${1:-?}"
DATE=$(date +"%Y-%m-%d %H:%M")

echo ""
echo "=== OPUS SESSION START: $SESSION_ID ==="
echo "Date: $DATE"
echo ""

# Pull latest
git pull origin main

# Check CLAUDE.md is under 135 lines
LINES=$(wc -l < CLAUDE.md 2>/dev/null || echo 0)
if [ "$LINES" -gt 135 ]; then
  echo "WARNING: CLAUDE.md is $LINES lines. Trim before starting."
fi

# Check working directory is clean
STATUS=$(git status --porcelain)
if [ -n "$STATUS" ]; then
  echo "WARNING: Uncommitted changes present:"
  git status --short
fi

# Log to Obsidian vault (update path to your vault)
OBSIDIAN_PATH="$HOME/RAWClaudeCodeLog/Opus Sessions"
mkdir -p "$OBSIDIAN_PATH"
cat >> "$OBSIDIAN_PATH/$SESSION_ID.md" << EOF

## Session Start: $DATE

**Status at open:** $([ -z "$STATUS" ] && echo "Clean" || echo "Dirty -- see git status")

EOF

echo "Session $SESSION_ID ready. Launch Claude Code with: claude --model claude-opus-4-8"
echo ""