#!/usr/bin/env bash
# Wrapper to run Codex CLI automatically after 10 seconds.
# Usage: ./auto_codex.sh "<your codex prompt>"
# Wait for 10 seconds; if no argument given, exit with usage.

prompt="$*"

if [ -z "$prompt" ]; then
  echo "Usage: $0 \"Prompt for Codex\""
  exit 1
fi

echo "Waiting 10 seconds before running Codex..."
sleep 10

# Run codex in non-interactive full-auto mode to automatically approve actions.
codex exec --full-auto "$prompt"
