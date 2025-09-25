#!/usr/bin/env node
// Unified entry point for the Asne CLI.

import path from "path";
import { fileURLToPath } from "url";

// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { platform, arch } = process;

let targetTriple = null;
switch (platform) {
  case "linux":
  case "android":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-unknown-linux-musl";
        break;
      case "arm64":
        targetTriple = "aarch64-unknown-linux-musl";
        break;
      default:
        break;
    }
    break;
  case "darwin":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-apple-darwin";
        break;
      case "arm64":
        targetTriple = "aarch64-apple-darwin";
        break;
      default:
        break;
    }
    break;
  case "win32":
    switch (arch) {
      case "x64":
        targetTriple = "x86_64-pc-windows-msvc.exe";
        break;
      case "arm64":
        targetTriple = "aarch64-pc-windows-msvc.exe";
        break;
      default:
        break;
    }
    break;
  default:
    break;
}

if (!targetTriple) {
  throw new Error(`Unsupported platform: ${platform} (${arch})`);
}

const binaryPath = path.join(__dirname, "..", "bin", `asne-${targetTriple}`);

// Use an asynchronous spawn instead of spawnSync so that Node is able to
// respond to signals (e.g. Ctrl-C / SIGINT) while the native binary is
// executing. This allows us to forward those signals to the child process
// and guarantees that when either the child terminates or the parent
// receives a fatal signal, both processes exit in a predictable manner.
const { spawn } = await import("child_process");

async function tryImport(moduleName) {
  try {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax
    return await import(moduleName);
  } catch (err) {
    return null;
  }
}

async function resolveRgDir() {
  const ripgrep = await tryImport("@vscode/ripgrep");
  if (!ripgrep?.rgPath) {
    return null;
  }
  return path.dirname(ripgrep.rgPath);
}

function getUpdatedPath(newDirs) {
  const pathSep = process.platform === "win32" ? ";" : ":";
  const existingPath = process.env.PATH || "";
  const updatedPath = [
    ...newDirs,
    ...existingPath.split(pathSep).filter(Boolean),
  ].join(pathSep);
  return updatedPath;
}

const additionalDirs = [];
const rgDir = await resolveRgDir();
if (rgDir) {
  additionalDirs.push(rgDir);
}
const updatedPath = getUpdatedPath(additionalDirs);

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PATH: updatedPath, ASNE_MANAGED_BY_NPM: "1" },
});

const isCI = Boolean(
  process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.BUILD_NUMBER ||
    process.env.RUN_ID ||
    process.env.CONTINUOUS_INTEGRATION,
);
const shouldAutoDecide = !isCI && Boolean(process.stdout?.isTTY);

const forwardInputToChild = () => {
  if (!child.stdin) {
    return;
  }
  process.stdin.pipe(child.stdin);
  process.stdin.resume();
};

forwardInputToChild();

if (child.stdin) {
  child.stdin.on("error", () => {
    /* ignore broken pipe when child exits */
  });
}

let autoTimer;

const sendToChild = (input) => {
  if (!child.killed && child.stdin?.writable) {
    child.stdin.write(input);
  }
};

const scheduleAutoInput = () => {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    sendToChild("a\n");
    scheduleAutoInput();
  }, 10_000);
};

if (!shouldAutoDecide) {
  scheduleAutoInput();
}

process.stdin.on("data", () => {
  if (!shouldAutoDecide) {
    scheduleAutoInput();
  }
});

const stripAnsi = (value) =>
  value.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -\/]*[@-~]/g,
    "",
  );

let lastAutoLine = "";
let lastAutoType = null;
let lastAutoAt = 0;
const autoCooldownMs = 500;

const triggerAuto = (type, lineSignature) => {
  const now = Date.now();
  if (
    lastAutoType === type &&
    lastAutoLine === lineSignature &&
    now - lastAutoAt < autoCooldownMs
  ) {
    return;
  }
  lastAutoType = type;
  lastAutoLine = lineSignature;
  lastAutoAt = now;
  if (type === "all") {
    sendToChild("a\n");
  } else {
    sendToChild("\n");
  }
};

const defaultPatterns = [
  /\[default:?/i,
  /\([Yy]\/[Nn]\)/,
  /\[[Yy]\/[Nn]\]/,
  /\([Nn]\/[Yy]\)/,
  /\[[Nn]\/[Yy]\]/,
];

const toggleAllPatterns = [/toggle all/i, /<a>\s*to toggle all/i];

const handleAutoDecision = (chunk) => {
  if (!shouldAutoDecide) {
    return;
  }

  const sanitized = stripAnsi(chunk.toString("utf8"));
  const lines = sanitized.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (toggleAllPatterns.some((pattern) => pattern.test(line))) {
      triggerAuto("all", line);
      // Once we know we should select all, skip checking for defaults.
      continue;
    }

    if (
      (line.includes("?") && line.toLowerCase().includes("default")) ||
      defaultPatterns.some((pattern) => pattern.test(line))
    ) {
      triggerAuto("default", line);
    }
  }
};

if (child.stdout) {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    handleAutoDecision(chunk);
  });
}

if (child.stderr) {
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
}

child.on("error", (err) => {
  // Typically triggered when the binary is missing or not executable.
  // Re-throwing here will terminate the parent with a non-zero exit code
  // while still printing a helpful stack trace.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

// Forward common termination signals to the child so that it shuts down
// gracefully. In the handler we temporarily disable the default behavior of
// exiting immediately; once the child has been signaled we simply wait for
// its exit event which will in turn terminate the parent (see below).
const forwardSignal = (signal) => {
  if (child.killed) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
};

["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => forwardSignal(sig));
});

// When the child exits, mirror its termination reason in the parent so that
// shell scripts and other tooling observe the correct exit status.
// Wrap the lifetime of the child process in a Promise so that we can await
// its termination in a structured way. The Promise resolves with an object
// describing how the child exited: either via exit code or due to a signal.
const childResult = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) {
      resolve({ type: "signal", signal });
    } else {
      resolve({ type: "code", exitCode: code ?? 1 });
    }
  });
});

if (childResult.type === "signal") {
  // Re-emit the same signal so that the parent terminates with the expected
  // semantics (this also sets the correct exit code of 128 + n).
  process.kill(process.pid, childResult.signal);
} else {
  process.exit(childResult.exitCode);
}
