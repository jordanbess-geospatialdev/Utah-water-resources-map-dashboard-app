#!/usr/bin/env node
// Scan added lines only. Git failures must fail CI, and credential bytes must
// never appear in diagnostics. This is a narrow pattern gate, not a full audit.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.BASE_REF || 'integration';
const credential = /AKIA[0-9A-Z]{16}|BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY|xox[baprs]-[0-9A-Za-z]{10,}|AIza[0-9A-Za-z_-]{35}|uwdat_[0-9A-Za-z]{32}/;
let patch;
try {
  patch = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', `${base}...HEAD`, '--'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  console.error('secret scan failed: unable to read the base diff; fetch full history before retrying');
  process.exit(1);
}
let inHunk = false;
let findings = 0;
for (const line of patch.split('\n')) {
  if (line.startsWith('diff --git ')) inHunk = false;
  else if (line.startsWith('@@ ')) inHunk = true;
  else if (inHunk && line.startsWith('+') && credential.test(line.slice(1))) findings += 1;
}
if (findings) {
  console.error(`secret scan failed: ${findings} added line(s) contain credential-like patterns (values redacted)`);
  process.exit(1);
}
console.log('secret scan clean: no credential-like patterns in added lines');
