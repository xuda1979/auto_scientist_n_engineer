#!/usr/bin/env bash
# Launch the interactive TUI (`codex`) but still honor your 10s auto default/ all rule.
# If you're in CI or want zero TUI, prefer: codex exec --full-auto "<prompt>"

set -euo pipefail

# Optional: CD into a working directory provided by the user
WORKDIR="${CODEX_WORKDIR:-.}"
cd "$WORKDIR"

# If you want Codex to use headless non-interactive mode by default, use exec:
# codex exec --full-auto "$@"

# Otherwise run the TUI but wrap in pexpect so 10s later we auto-accept defaults.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$SCRIPT_DIR/codex_auto_input.py"

# Ensure pexpect is available
python3 - <<'PY'
try:
    import pexpect  # noqa: F401
except Exception:
    import sys, subprocess
    print("Installing pexpect into user site...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "pexpect"])
PY

# Run the interactive client but enforce your rule:
CODEX_AUTO_TIMEOUT="${CODEX_AUTO_TIMEOUT:-10}" \
exec python3 "$PY" codex "$@"
