#!/usr/bin/env python3
"""
Wrap an interactive command (e.g., `codex`) and after 10s:
- If a choice is required, press Enter (default).
- If "select all" is possible, send the appropriate input then Enter.

Usage:
  ./scripts/codex_auto_input.py codex          # launches interactive TUI
  ./scripts/codex_auto_input.py codex --cd .   # launches with args
"""
import os
import sys
import time
import re
import pexpect

TIMEOUT_SECS = int(os.environ.get("CODEX_AUTO_TIMEOUT", "10"))

# Patterns where "select all" is appropriate
SELECT_ALL_HINTS = [
    r"select all", r"choose all", r"pick all",
    r"\(.*all.*\)", r"comma[- ]separated.*all", r"\[.*\].*all"
]
# Patterns that look like a single-choice prompt with default shown
DEFAULT_CHOICE_HINTS = [
    r"\[Y/n\]", r"\[y/N\]", r"\(default[:=]\s*\w+\)",
    r"press Enter to accept", r"default is", r"SELECT ONE"
]

def should_select_all(text: str) -> bool:
    t = text.lower()
    return any(re.search(p, t) for p in SELECT_ALL_HINTS)

def looks_like_choice(text: str) -> bool:
    t = text.lower()
    return any(re.search(p, t) for p in DEFAULT_CHOICE_HINTS)

def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: codex_auto_input.py <command> [args...]", file=sys.stderr)
        sys.exit(2)

    child = pexpect.spawn(sys.argv[1], sys.argv[2:], encoding="utf-8", timeout=None)
    child.logfile = sys.stdout

    # Sleep once for the specified timeout
    time.sleep(TIMEOUT_SECS)

    # Try to read a screenful without blocking forever
    try:
        # read_nonblocking: pull whatever is available to inspect prompts
        text = child.read_nonblocking(size=4096, timeout=1)
    except Exception:
        text = ""

    # Decide what to send after timeout
    to_send = None
    if should_select_all(text):
        # common "select all" keys that CLIs accept
        # try 'a' (select all), fallback to '*' or 'all'
        for key in ["a", "*", "all"]:
            try:
                child.sendline(key)
                to_send = key
                break
            except Exception:
                pass

    if to_send is None and (looks_like_choice(text) or True):
        # Default: press Enter for the default
        try:
            child.sendline("")
            to_send = "Enter"
        except Exception:
            pass

    # Continue streaming until process exits
    try:
        child.interact()  # hand terminal control back; we already auto-responded
    except Exception:
        pass

    try:
        child.close()
    except Exception:
        pass

    sys.exit(child.exitstatus if child.exitstatus is not None else 0)

if __name__ == "__main__":
    main()
