#!/usr/bin/env node
// gate.mjs — local mirror of the PR merge gates defined in the development
// plan ("Repository topology, branches, and worktrees") and run by ci.yml.
//
// usage:
//   node scripts/gate.mjs scope <WD-ID>      changed paths must fall in the task's write_scopes
//   node scripts/gate.mjs trailers           every branch commit carries Task:/Agent: trailers
//   node scripts/gate.mjs migrations         merged migration files are append-only
//   node scripts/gate.mjs lockfile           pnpm-lock.yaml changes only on chore/deps branches
//   node scripts/gate.mjs all <WD-ID>
//
// BASE_REF defaults to "integration" locally; CI sets origin/<base>.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execSync(`git ${args}`, { encoding: 'utf8', cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const base = process.env.BASE_REF || 'integration';
const branch = git('rev-parse --abbrev-ref HEAD');

let mergeBase = null;
try { mergeBase = git(`merge-base ${base} HEAD`); } catch { /* branch without base history */ }

const changed = mergeBase
  ? git(`diff --name-only ${mergeBase} HEAD`).split('\n').filter(Boolean)
  : [];

const fail = (rule, detail) => { console.error(`GATE FAIL [${rule}] ${detail}`); process.exit(1); };
const pass = (rule, detail) => console.log(`gate ok [${rule}] ${detail}`);

function taskScopes(id) {
  const tasks = JSON.parse(readFileSync(join(ROOT, 'tasks.json'), 'utf8')).tasks;
  const task = tasks.find((t) => t.id === id);
  if (!task) fail('scope', `unknown task id "${id}" in tasks.json`);
  return task.write_scopes;
}

const matches = (path, scope) =>
  scope.endsWith('/**') ? path.startsWith(scope.slice(0, -2)) : path === scope;

function checkScope(id) {
  if (!id) fail('scope', 'no task id derivable from branch name');
  const scopes = taskScopes(id);
  const offenders = changed.filter((p) => !scopes.some((s) => matches(p, s)));
  if (offenders.length) {
    fail('scope', `paths outside write_scopes of ${id}:\n  ${offenders.join('\n  ')}`);
  }
  pass('scope', `${changed.length} changed paths within ${id} scopes`);
}

function checkTrailers() {
  if (!mergeBase) return pass('trailers', 'no common base with integration (bootstrap commit)');
  const commits = git(`log --format=%H%x00%B%x1E ${mergeBase}..HEAD`)
    .split('\x1E').map((c) => c.trim()).filter(Boolean);
  const enforced = /^(feat|fix|test|contract)\//.test(branch);
  if (!enforced) return pass('trailers', `branch "${branch}" not trailer-enforced`);
  for (const raw of commits) {
    const [hash, ...body] = raw.split('\x00');
    const message = body.join('\n');
    if (!/^Agent: \S+/m.test(message)) fail('trailers', `${hash.slice(0, 9)} missing "Agent: <role>" trailer`);
    if (/^(feat|fix|contract)\//.test(branch) && !/^Task: \S+/m.test(message)) {
      fail('trailers', `${hash.slice(0, 9)} missing "Task: <WD-ID>" trailer`);
    }
    if (/^test\//.test(branch) && !/^Tests: \S+/m.test(message)) {
      fail('trailers', `${hash.slice(0, 9)} missing "Tests: <T-ID>" trailer`);
    }
  }
  pass('trailers', `${commits.length} commits carry required trailers`);
}

function checkMigrations() {
  if (!mergeBase) return pass('migrations', 'no common base');
  const touched = changed.filter((p) => p.startsWith('database/migrations/'));
  const edited = touched.filter((p) => {
    try { git(`cat-file -e ${base}:${p}`); return true; } catch { return false; }
  });
  if (edited.length) {
    fail('migrations', `files already on ${base} were modified (append-only):\n  ${edited.join('\n  ')}`);
  }
  pass('migrations', touched.length ? `${touched.length} migration additions, no edits` : 'no migrations touched');
}

function checkLockfile() {
  if (changed.includes('pnpm-lock.yaml') && !/^chore\/deps-/.test(branch)) {
    fail('lockfile', `pnpm-lock.yaml changed on "${branch}"; only chore/deps-<date> branches may change it`);
  }
  pass('lockfile', 'no unauthorized lockfile change');
}

const [command, idArg] = process.argv.slice(2);
switch (command) {
  case 'scope': checkScope(idArg); break;
  case 'trailers': checkTrailers(); break;
  case 'migrations': checkMigrations(); break;
  case 'lockfile': checkLockfile(); break;
  case 'all': checkScope(idArg); checkTrailers(); checkMigrations(); checkLockfile();
    console.log(`gate ok [all] branch "${branch}" vs ${base}`); break;
  default:
    console.error('usage: gate.mjs <scope|trailers|migrations|lockfile|all> [WD-ID]');
    process.exit(2);
}
