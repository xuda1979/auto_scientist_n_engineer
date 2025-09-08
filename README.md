# auto_scientist_n_engineer

This repository provides a simple wrapper around the [OpenAI Codex CLI](https://github.com/openai/codex) that allows you to use Codex in a fully automatic way from your terminal.

Codex normally runs in an interactive TUI and asks for confirmation before making edits or running commands.  In some cases this interaction can block automation pipelines or require manual input.  To address this, the `auto_codex.sh` script waits ten seconds and then runs Codex in **full‑auto** mode which automatically approves edits and commands.  When Codex encounters a choice that requires one option to be selected it will pick the default after the delay.  When multiple selections are allowed it will select all of the options after the delay.

## Usage

1. Install the Codex CLI if you haven't already:

```bash
npm install -g @openai/codex
```

2. Run the wrapper script with your prompt.  For example:

```bash
./auto_codex.sh "Refactor the Dashboard component to use React hooks"
```

The script sleeps for ten seconds and then invokes `codex exec --full-auto` with your prompt.  The `--full-auto` flag tells Codex to automatically approve edits and commands.  The delay gives you a chance to cancel the operation if you started the script accidentally.

You can adjust the prompt to whatever task you need Codex to perform.  Codex will read your working directory, make changes, run tests and commit the result without further prompts.

## Files

- **auto_codex.sh** – Bash wrapper around Codex CLI for running tasks in full‑auto mode after a 10 second pause.
