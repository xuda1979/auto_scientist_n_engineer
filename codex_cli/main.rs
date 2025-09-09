use clap::{Parser, Subcommand};
use std::env;
use std::process::Command;

/// A stub CLI for OpenAI Codex that wraps the official codex TUI and exec modes.
/// This version enforces a default or select-all choice after a timeout.
/// The timeout can be configured via CODEX_AUTO_TIMEOUT environment variable.
/// If unspecified, it defaults to 10 seconds.
///
/// Note: This code is a simple wrapper and does not include the proprietary logic
/// of the official codex CLI. It demonstrates how to set a timeout for user prompts.
/// See the official openai/codex repository for the full implementation.
#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
struct Cli {
    #[clap(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run codex in interactive TUI mode.
    Interactive {
        #[clap(raw = true)]
        args: Vec<String>,
    },
    /// Run codex in exec (non-interactive) mode.
    Exec {
        #[clap(raw = true)]
        args: Vec<String>,
    },
}

fn main() -> std::io::Result<()> {
    let cli = Cli::parse();

    // Set default timeout for auto-answer if not already set.
    let timeout_var = "CODEX_AUTO_TIMEOUT";
    if env::var(timeout_var).is_err() {
        // Default to 10 seconds
        env::set_var(timeout_var, "10");
    }

    match cli.command {
        Commands::Interactive { args } => {
            // Use our Python wrapper to automatically answer prompts
            // It will wait for the timeout and then choose default or select all.
            // Equivalent to: python3 scripts/codex_auto_input.py codex <args...>
            let mut cmd = Command::new("python3");
            cmd.arg("scripts/codex_auto_input.py");
            cmd.arg("codex");
            for arg in args {
                cmd.arg(arg);
            }
            cmd.status()?;
        }
        Commands::Exec { args } => {
            // Use the built-in headless mode with full auto.
            let mut cmd = Command::new("codex");
            cmd.arg("exec");
            cmd.arg("--full-auto");
            for arg in args {
                cmd.arg(arg);
            }
            cmd.status()?;
        }
    }

    Ok(())
}
