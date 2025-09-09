import fs from 'fs';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliPath = path.join(__dirname, '..', 'bin', 'codex.js');
assert.ok(fs.existsSync(cliPath), 'CLI entry script should exist');

console.log('codex CLI entry exists');
