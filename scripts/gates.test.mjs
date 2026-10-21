import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
function repo(t) {
  const prefix = join(tmpdir(), 'utah-gates-');
  const root = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(prefix)), 'cleanup stays in this test temporary directory');
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (message = 'fixture change') => { git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', message); };
  git('init', '-b', 'integration');
  git('config', 'user.name', 'Gate regression fixture');
  git('config', 'user.email', 'gate-test@example.invalid');
  git('config', 'core.hooksPath', join(root, 'no-hooks'));
  write('tasks.json', JSON.stringify({ tasks: [{ id: 'WD-001', write_scopes: ['allowed/**', 'database/**', 'pnpm-lock.yaml'] }] }));
  write('database/migrations/001.sql', 'SELECT 1;\n');
  write('pnpm-lock.yaml', 'fixture lockfile\n');
  mkdirSync(join(root, 'scripts'));
  for (const name of ['gate.mjs', 'scan-secrets.mjs', 'verify-release-tag.mjs']) copyFileSync(join(scripts, name), join(root, 'scripts', name));
  commit('fixture base');
  git('update-ref', 'refs/remotes/origin/integration', 'HEAD');
  git('switch', '-c', 'feat/WD-001-review');
  const run = (script, args = [], env = {}) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BASE_REF: 'integration', GITHUB_HEAD_REF: '', PR_HEAD_SHA: '', RELEASE_TAG: '', ...env },
  });
  return { root, git, write, commit, run };
}

test('scope accepts allowed changes and rejects out-of-scope paths', (t) => {
  const r = repo(t);
  r.write('allowed/file.txt', 'allowed'); r.commit();
  assert.equal(r.run('gate.mjs', ['scope', 'WD-001']).status, 0);
  r.write('other/file.txt', 'out of scope'); r.commit();
  assert.equal(r.run('gate.mjs', ['scope', 'WD-001']).status, 1);
});

test('missing comparison history fails closed instead of reporting zero changed files', (t) => {
  const r = repo(t);
  const result = r.run('gate.mjs', ['all', 'WD-001'], { BASE_REF: 'missing-branch' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GATE FAIL \[base\]/);
});

test('detached PR checkout enforces source-branch trailers', (t) => {
  const r = repo(t);
  r.write('allowed/file.txt', 'changed'); r.commit(); r.git('checkout', '--detach');
  assert.equal(r.run('gate.mjs', ['trailers'], { GITHUB_HEAD_REF: 'feat/WD-001-review' }).status, 1);
  r.git('-c', 'commit.gpgsign=false', 'commit', '--amend', '-m', 'fixed trailers\n\nTask: WD-001\nAgent: review');
  assert.equal(r.run('gate.mjs', ['trailers'], { GITHUB_HEAD_REF: 'feat/WD-001-review' }).status, 0);
});

test('detached PR checkout allows lockfile changes only on the dependency branch', (t) => {
  const r = repo(t);
  r.write('pnpm-lock.yaml', 'changed fixture'); r.commit(); r.git('checkout', '--detach');
  assert.equal(r.run('gate.mjs', ['lockfile'], { GITHUB_HEAD_REF: 'feat/WD-001-review' }).status, 1);
  assert.equal(r.run('gate.mjs', ['lockfile'], { GITHUB_HEAD_REF: 'chore/deps-test' }).status, 0);
});

test('PR source SHA excludes the hosting provider generated merge commit from trailers', (t) => {
  const r = repo(t);
  r.write('allowed/file.txt', 'changed'); r.commit('valid source commit\n\nTask: WD-001\nAgent: review');
  const source = r.git('rev-parse', 'HEAD');
  r.git('switch', '-c', 'pr-merge', 'integration');
  r.git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feat/WD-001-review', '-m', 'Synthetic PR merge');
  r.git('checkout', '--detach');
  assert.equal(r.run('gate.mjs', ['trailers'], { GITHUB_HEAD_REF: 'feat/WD-001-review' }).status, 1);
  assert.equal(r.run('gate.mjs', ['all', 'WD-001'], { GITHUB_HEAD_REF: 'feat/WD-001-review', PR_HEAD_SHA: source }).status, 0);
});

test('dependency branches pass without a WD id but cannot change production source', (t) => {
  const r = repo(t);
  const env = { GITHUB_HEAD_REF: 'chore/deps-test' };
  r.write('pnpm-lock.yaml', 'changed fixture'); r.commit();
  assert.equal(r.run('gate.mjs', ['all'], env).status, 0);
  r.write('services/api/src/production.ts', 'export const value = 1;'); r.commit();
  assert.equal(r.run('gate.mjs', ['all'], env).status, 1);
});

test('append-only migration gate rejects renames of an existing migration', (t) => {
  const r = repo(t);
  r.git('mv', 'database/migrations/001.sql', 'database/migrations/002.sql'); r.commit();
  assert.equal(r.run('gate.mjs', ['migrations']).status, 1);
});

test('secret scan fails on added credentials without printing their bytes', (t) => {
  const r = repo(t);
  const secret = 'AKIA' + 'Z'.repeat(16);
  r.write('added.txt', secret); r.commit();
  const result = r.run('scan-secrets.mjs');
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('secret scan detects full dashboard tokens but permits documentation placeholders', (t) => {
  const r = repo(t);
  r.write('example.txt', 'uwdat_<token>'); r.commit();
  assert.equal(r.run('scan-secrets.mjs').status, 0);
  r.write('example.txt', 'uwdat_' + 'a'.repeat(32)); r.commit();
  assert.equal(r.run('scan-secrets.mjs').status, 1);
});

test('secret scan permits removing a credential and rejects an unreadable diff', (t) => {
  const r = repo(t);
  r.write('old.txt', 'AKIA' + 'Z'.repeat(16)); r.commit();
  r.git('branch', '-f', 'integration', 'HEAD');
  r.write('old.txt', 'removed'); r.commit();
  assert.equal(r.run('scan-secrets.mjs').status, 0);
  assert.equal(r.run('scan-secrets.mjs', [], { BASE_REF: 'missing-branch' }).status, 1);
});

test('release preflight rejects lightweight and unsigned annotated tags', (t) => {
  const r = repo(t);
  r.git('-c', 'tag.gpgsign=false', 'tag', 'v1.0.0');
  assert.equal(r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.0' }).status, 1);
  r.git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.0.1', '-m', 'unsigned fixture');
  assert.equal(r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.1' }).status, 1);
});

test('release preflight rejects nonmatching commits and validates tag input without a shell', (t) => {
  const r = repo(t);
  r.write('allowed/file.txt', 'changed'); r.commit();
  r.git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.0.0', '-m', 'wrong commit fixture');
  const mismatch = r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.0' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match/);
  const invalid = r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.0; echo unsafe' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /semver/);
});

test('release preflight accepts a matching signed tag only with an approved signing key', (t) => {
  const available = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('ssh-keygen unavailable for positive signature integration test');
  const r = repo(t);
  // All keys are ephemeral test material under this temporary repo's .git.
  const key = join(r.root, '.git', 'test-signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: ['ignore', 'pipe', 'pipe'] });
  const signers = join(r.root, '.git', 'allowed-signers');
  writeFileSync(signers, `gate-test@example.invalid ${readFileSync(key + '.pub', 'utf8')}`);
  r.git('config', 'gpg.format', 'ssh');
  r.git('config', 'user.signingKey', key);
  r.git('config', 'gpg.ssh.allowedSignersFile', signers);
  r.git('tag', '-s', 'v1.0.0', '-m', 'signed fixture');
  assert.equal(r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.0' }).status, 0);
  writeFileSync(signers, '');
  assert.equal(r.run('verify-release-tag.mjs', [], { RELEASE_TAG: 'v1.0.0' }).status, 1);
});
