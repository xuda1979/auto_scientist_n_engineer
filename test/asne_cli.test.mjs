import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliPath = path.join(__dirname, '..', 'bin', 'asne.js');

test('CLI entry script should exist', () => {
  assert.ok(fs.existsSync(cliPath), 'CLI entry script should exist');
});

