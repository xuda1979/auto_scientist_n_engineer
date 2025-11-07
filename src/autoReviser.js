import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_RESULT_FILENAME = 'TEST_RESULTS.md';
const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MiB safety threshold for snapshot collection

function isBinaryBuffer(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function collectRepositorySnapshot(projectRoot) {
  const files = await listTrackedFiles(projectRoot);
  const snapshot = [];
  for (const relativePath of files) {
    const absolutePath = path.join(projectRoot, relativePath);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (error) {
      // File might have been removed between listing and reading; skip it.
      continue; // eslint-disable-line no-continue
    }
    if (!stat.isFile()) {
      continue; // eslint-disable-line no-continue
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      continue; // eslint-disable-line no-continue
    }
    let buffer;
    try {
      buffer = await fs.readFile(absolutePath);
    } catch (error) {
      continue; // eslint-disable-line no-continue
    }
    if (isBinaryBuffer(buffer)) {
      continue; // eslint-disable-line no-continue
    }
    snapshot.push({
      path: relativePath,
      content: buffer.toString('utf8'),
    });
  }
  return snapshot;
}

async function listTrackedFiles(projectRoot) {
  const { stdout } = await runProcess('git', ['ls-files'], { cwd: projectRoot });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function applyGitDiff(diff, projectRoot) {
  if (!diff || !diff.trim()) {
    throw new Error('LLM response did not include a git diff to apply.');
  }
  const child = spawn('git', ['apply', '--whitespace=nowarn'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
  }
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(
          `git apply exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        );
        reject(error);
      }
    });
  });
  child.stdin?.end(diff);
  await completion;
}

async function removeFileIfExists(filePath) {
  await fs.rm(filePath, { force: true });
}

async function runShellCommand(command, projectRoot) {
  if (!command || !command.trim()) {
    throw new Error('No test command provided by the LLM response.');
  }
  const child = spawn(command, {
    cwd: projectRoot,
    shell: true,
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
  return { stdout, stderr, exitCode };
}

function formatTestResults(command, { stdout, stderr, exitCode }, executionDate = new Date()) {
  const normalizedStdout = stdout ? stdout.replace(/\r\n/g, '\n') : '';
  const normalizedStderr = stderr ? stderr.replace(/\r\n/g, '\n') : '';
  const lines = [
    '# Test Results',
    '',
    `- Command: \`${command}\``,
    `- Exit Code: ${exitCode}`,
    `- Status: ${exitCode === 0 ? 'Passed' : 'Failed'}`,
    '',
    '## Stdout',
    '```',
    normalizedStdout.trimEnd(),
    '```',
    '',
    '## Stderr',
    '```',
    normalizedStderr.trimEnd(),
    '```',
    '',
    `Test executed on ${executionDate.toISOString()}.`,
  ];
  return lines.join('\n');
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
  if (exitCode !== 0) {
    const error = new Error(
      `${command} ${args.join(' ')} exited with code ${exitCode}${
        stderr ? `: ${stderr.trim()}` : ''
      }`,
    );
    error.exitCode = exitCode;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return { stdout, stderr, exitCode };
}

function normalizeObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim()) {
    throw new Error('Objective must be a non-empty string.');
  }
  return objective.trim();
}

function ensureProjectRoot(projectRoot) {
  if (!projectRoot) {
    throw new Error('projectRoot is required.');
  }
  return path.resolve(projectRoot);
}

async function runAutoRevision({
  objective,
  projectRoot,
  llmClient,
  resultFilePath,
  maxIterations = DEFAULT_MAX_ITERATIONS,
}) {
  const normalizedObjective = normalizeObjective(objective);
  const normalizedRoot = ensureProjectRoot(projectRoot);
  if (!llmClient || typeof llmClient.reviewIteration !== 'function') {
    throw new Error('llmClient with a reviewIteration method is required.');
  }
  const resolvedResultFile = resultFilePath
    ? path.resolve(resultFilePath)
    : path.join(normalizedRoot, DEFAULT_RESULT_FILENAME);
  let lastTestSummary = null;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const codeSnapshot = await collectRepositorySnapshot(normalizedRoot);
    const payload = {
      objective: normalizedObjective,
      iteration,
      codeSnapshot,
      lastTestSummary,
    };
    // eslint-disable-next-line no-await-in-loop
    const response = await llmClient.reviewIteration(payload);
    if (!response) {
      throw new Error('LLM response was empty or undefined.');
    }
    if (response.satisfied) {
      return {
        status: 'satisfied',
        iterations: iteration,
        lastTestSummary,
      };
    }
    const { diff, testCommand } = response;
    // eslint-disable-next-line no-await-in-loop
    await applyGitDiff(diff, normalizedRoot);
    // eslint-disable-next-line no-await-in-loop
    await removeFileIfExists(resolvedResultFile);
    // eslint-disable-next-line no-await-in-loop
    const testExecution = await runShellCommand(testCommand, normalizedRoot);
    const report = formatTestResults(testCommand, testExecution);
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(resolvedResultFile, report, 'utf8');
    lastTestSummary = {
      command: testCommand,
      exitCode: testExecution.exitCode,
      stdout: testExecution.stdout,
      stderr: testExecution.stderr,
      reportPath: resolvedResultFile,
      report,
    };
  }
  throw new Error(`Maximum iterations (${maxIterations}) reached without satisfying objective.`);
}

export {
  applyGitDiff,
  collectRepositorySnapshot,
  formatTestResults,
  runAutoRevision,
  runShellCommand,
};

