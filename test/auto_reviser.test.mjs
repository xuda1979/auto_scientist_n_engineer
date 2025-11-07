import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

import {
  applyGitDiff,
  collectRepositorySnapshot,
  formatTestResults,
  runAutoRevision,
  runShellCommand,
} from '../src/autoReviser.js';

async function withTempRepo(t, setup) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-reviser-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  execSync('git init', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.name Test', { cwd: tempDir, stdio: 'ignore' });
  await setup(tempDir);
  return tempDir;
}

function createStubClient(responses) {
  const calls = [];
  return {
    calls,
    async reviewIteration(payload) {
      calls.push(payload);
      if (responses.length === 0) {
        throw new Error('No more stub responses defined.');
      }
      const response = responses.shift();
      if (typeof response === 'function') {
        return response(payload);
      }
      return response;
    },
  };
}

async function generateDiff(tempDir, filePath, nextContent) {
  const absolutePath = path.join(tempDir, filePath);
  const originalContent = await fs.readFile(absolutePath, 'utf8');
  await fs.writeFile(absolutePath, nextContent, 'utf8');
  const diffBuffer = execSync('git diff HEAD', { cwd: tempDir });
  const diff = diffBuffer.toString();
  await fs.writeFile(absolutePath, originalContent, 'utf8');
  execSync(`git checkout -- ${filePath}`, { cwd: tempDir, stdio: 'ignore' });
  return diff;
}

test('runAutoRevision iterates until satisfied and writes results', async (t) => {
  const repoRoot = await withTempRepo(t, async (tempDir) => {
    const samplePath = path.join(tempDir, 'sample.js');
    await fs.writeFile(samplePath, 'console.log("v1");\n');
    execSync('git add sample.js', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', {
      cwd: tempDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  });

  const diff = await generateDiff(repoRoot, 'sample.js', 'console.log("v2");\n');

  const responses = [
    {
      satisfied: false,
      diff,
      testCommand: "node -e \"console.log('ok');\"",
    },
    {
      satisfied: true,
    },
  ];
  const stubClient = createStubClient(responses);

  const resultFile = path.join(repoRoot, 'RESULTS.md');

  const outcome = await runAutoRevision({
    objective: 'Update sample.js output',
    projectRoot: repoRoot,
    llmClient: stubClient,
    resultFilePath: resultFile,
    maxIterations: 5,
  });

  assert.strictEqual(outcome.status, 'satisfied');
  assert.strictEqual(outcome.iterations, 2);
  assert.ok(outcome.lastTestSummary);
  assert.strictEqual(outcome.lastTestSummary.command, "node -e \"console.log('ok');\"");

  const updatedContent = await fs.readFile(path.join(repoRoot, 'sample.js'), 'utf8');
  assert.match(updatedContent, /v2/);

  const report = await fs.readFile(resultFile, 'utf8');
  assert.ok(report.includes('Test executed on'));
  assert.ok(report.includes('ok'));

  assert.strictEqual(stubClient.calls.length, 2);
  assert.strictEqual(stubClient.calls[0].objective, 'Update sample.js output');
  assert.ok(Array.isArray(stubClient.calls[0].codeSnapshot));
  const snapshotPaths = stubClient.calls[0].codeSnapshot.map((entry) => entry.path);
  assert.ok(snapshotPaths.includes('sample.js'));
  assert.strictEqual(stubClient.calls[1].lastTestSummary.command, "node -e \"console.log('ok');\"");
});


test('runAutoRevision throws when maximum iterations reached', async (t) => {
  const repoRoot = await withTempRepo(t, async (tempDir) => {
    const samplePath = path.join(tempDir, 'sample.js');
    await fs.writeFile(samplePath, 'console.log("v1");\n');
    execSync('git add sample.js', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', {
      cwd: tempDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  });

  const diff = await generateDiff(repoRoot, 'sample.js', 'console.log("v3");\n');

  const responses = [
    {
      satisfied: false,
      diff,
      testCommand: "node -e \"console.log('still failing'); process.exit(1);\"",
    },
  ];
  const stubClient = createStubClient(responses);

  await assert.rejects(
    runAutoRevision({
      objective: 'Update sample.js repeatedly',
      projectRoot: repoRoot,
      llmClient: stubClient,
      maxIterations: 1,
    }),
    /Maximum iterations/,
  );

  const reportContent = await fs.readFile(path.join(repoRoot, 'TEST_RESULTS.md'), 'utf8');
  assert.ok(reportContent.includes('still failing'));
});

test('collectRepositorySnapshot excludes binary and oversized tracked files', async (t) => {
  const repoRoot = await withTempRepo(t, async (tempDir) => {
    const textPath = path.join(tempDir, 'text.txt');
    const binaryPath = path.join(tempDir, 'binary.bin');
    const largePath = path.join(tempDir, 'large.txt');
    const ignoredPath = path.join(tempDir, 'ignored.txt');

    await fs.writeFile(textPath, 'hello world\n', 'utf8');
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(largePath, 'a'.repeat(1_048_577), 'utf8');
    await fs.writeFile(ignoredPath, 'should be ignored\n', 'utf8');

    execSync('git add text.txt binary.bin large.txt', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "snapshot files"', {
      cwd: tempDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  });

  const snapshot = await collectRepositorySnapshot(repoRoot);
  const snapshotPaths = snapshot.map((entry) => entry.path);

  assert.deepStrictEqual(snapshotPaths, ['text.txt']);
  assert.strictEqual(snapshot[0].content, 'hello world\n');
});

test('runShellCommand captures stdout, stderr, and exit code', async () => {
  const command = "node -e \"console.log('out'); console.error('err'); process.exit(2);\"";
  const { stdout, stderr, exitCode } = await runShellCommand(command, process.cwd());

  assert.strictEqual(exitCode, 2);
  assert.ok(stdout.includes('out'));
  assert.ok(stderr.includes('err'));
});

test('formatTestResults normalizes output and reports failure status', () => {
  const executionDate = new Date('2024-01-02T03:04:05.000Z');
  const report = formatTestResults(
    'echo test',
    {
      stdout: 'line1\r\nline2\r\n',
      stderr: 'whoops\r\n',
      exitCode: 1,
    },
    executionDate,
  );

  assert.ok(report.includes('- Status: Failed'));
  assert.ok(report.includes('line1\nline2'));
  assert.ok(!report.includes('\r'));
  assert.ok(report.includes('Test executed on 2024-01-02T03:04:05.000Z'));
});

test('runAutoRevision validates objective and provided test command', async (t) => {
  await assert.rejects(
    runAutoRevision({
      objective: '   ',
      projectRoot: process.cwd(),
      llmClient: { reviewIteration() {} },
    }),
    /Objective must be a non-empty string/,
  );

  const repoRoot = await withTempRepo(t, async (tempDir) => {
    const samplePath = path.join(tempDir, 'sample.js');
    await fs.writeFile(samplePath, 'console.log("initial");\n');
    execSync('git add sample.js', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', {
      cwd: tempDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  });

  const diff = await generateDiff(repoRoot, 'sample.js', 'console.log("updated");\n');
  const stubClient = createStubClient([
    {
      satisfied: false,
      diff,
      testCommand: '   ',
    },
  ]);

  await assert.rejects(
    runAutoRevision({
      objective: 'Require valid command',
      projectRoot: repoRoot,
      llmClient: stubClient,
    }),
    /No test command provided by the LLM response/,
  );
});

test('applyGitDiff validates diff input before applying', async (t) => {
  const repoRoot = await withTempRepo(t, async (tempDir) => {
    const samplePath = path.join(tempDir, 'sample.js');
    await fs.writeFile(samplePath, 'console.log("v1");\n');
    execSync('git add sample.js', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', {
      cwd: tempDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  });

  await assert.rejects(applyGitDiff('', repoRoot), /did not include a git diff/);

  await assert.rejects(applyGitDiff('not a diff', repoRoot), /git apply exited with code/);
});

