#!/bin/bash
SESSION_ID="S${1:-?}"
DATE=$(date +"%Y-%m-%d %H:%M")
MSG="${2:-Session $SESSION_ID close}"

echo ""
echo "=== OPUS SESSION END: $SESSION_ID ==="
echo "Date: $DATE"
echo ""

# Commit everything
git add -A
git commit -m "[$SESSION_ID] $MSG"
git push origin main

# Log to Obsidian vault
OBSIDIAN_PATH="$HOME/RAWClaudeCodeLog/Opus Sessions"
mkdir -p "$OBSIDIAN_PATH"
cat >> "$OBSIDIAN_PATH/$SESSION_ID.md" << EOF

## Session End: $DATE

**Commit message:** $MSG
**Final git status:** $(git log --oneline -1)

EOF

echo "Session $SESSION_ID committed and logged."
echo ""