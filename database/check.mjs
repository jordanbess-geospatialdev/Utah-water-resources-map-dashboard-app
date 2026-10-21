#!/usr/bin/env node
// database/check.mjs
// Zero-dependency static gate for the WD-003 database baseline. Run by
// `pnpm test` inside database/ (package.json test script) - also wired into the
// repository CI story. Node built-ins only; no database connection is made or
// required (nothing here is a substitute for the qualification gate in
// database/qualification/queries.sql).
//
// Checks
//   (a) migration filenames match V<yyyyMMddHHmm>__WD-003_*.sql
//   (b) every CREATE TABLE declares a PRIMARY KEY (PARTITION OF children are
//       exempt: they inherit the parent's constraints)
//   (c) publication views declare explicit column lists and none of the
//       forbidden columns (gate_code, internal_note, owner_contact,
//       credential, password) appears in any view definition
//   (d) forbidden-column regex scan across all migration SQL: the restricted
//       names may exist ONLY inside the private table water.station_internal_detail;
//       any occurrence in a view or any other object is a leak into a
//       public-facing object and fails the gate
//   (e) database/load-fixtures.mjs runs against the contract fixtures and the
//       emitted per-table INSERT counts match
//       fixtures/database/expected-row-counts.json exactly (both directions),
//       every statement carries an explicit column list and ON CONFLICT DO
//       NOTHING, and a second run is byte-identical (determinism)
//
// SQL parsing limitations (acceptable for files authored in this package):
// comment stripping assumes no '--' inside string literals and no '/*' markers
// inside literals; block extraction assumes no unbalanced parentheses inside
// string literals. Both hold for every file under database/migrations.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');
const LOADER = join(HERE, 'load-fixtures.mjs');
const EXPECTED_PATH = join(HERE, '..', 'fixtures', 'database', 'expected-row-counts.json');

const FORBIDDEN_COLUMNS = ['gate_code', 'internal_note', 'owner_contact', 'credential', 'password'];
const PRIVATE_TABLES_ALLOWED_FORBIDDEN = new Set(['water.station_internal_detail', 'station_internal_detail']);

const results = [];
const fail = (rule, detail) => {
  console.error(`check FAIL [${rule}] ${detail}`);
  process.exit(1);
};
const pass = (rule, detail) => {
  results.push(rule);
  console.log(`check ok [${rule}] ${detail}`);
};

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// Extract CREATE TABLE blocks with balanced-paren scanning (handles nested
// CHECK (...) / geometry(Point,4326) definitions).
function extractCreateTables(sql) {
  const tables = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<name>[\w.]+)\s*\(/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) fail('parse', `unbalanced parentheses in CREATE TABLE ${m.groups.name}`);
    tables.push({
      name: m.groups.name,
      body: sql.slice(m.index + m[0].length, end),
      start: m.index,
      end,
    });
  }
  return tables;
}

// Extract CREATE [OR REPLACE] VIEW blocks: name, explicit column list, body.
function extractViews(sql) {
  const views = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?<name>[\w.]+)\s*(?:\((?<cols>[^)]*)\))?\s*AS\s*(?<body>[\s\S]*?);/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    views.push({
      name: m.groups.name,
      cols: (m.groups.cols ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      hasExplicitColumns: Boolean(m.groups.cols && m.groups.cols.trim()),
      body: m.groups.body,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return views;
}

const forbiddenRe = (name, flags = 'i') => new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, flags);

// ---------------------------------------------------------------------------
// Load migrations
// ---------------------------------------------------------------------------
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
if (migrationFiles.length === 0) fail('migrations/filenames', 'no migration SQL files found');
const migrations = migrationFiles.map((f) => ({
  file: f,
  sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8'),
  clean: stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')),
}));

// ---------------------------------------------------------------------------
// (a) migration filenames
// ---------------------------------------------------------------------------
{
  const pattern = /^V\d{8}(0[0-9]|1[0-2])([0-5]\d)__WD-003_[A-Za-z0-9_]+\.sql$/;
  const bad = migrationFiles.filter((f) => !pattern.test(f));
  if (bad.length) fail('migrations/filenames', `must match V<yyyyMMddHHmm>__WD-003_*.sql:\n  ${bad.join('\n  ')}`);
  pass('migrations/filenames', `${migrationFiles.length} migrations match V<yyyyMMddHHmm>__WD-003_*.sql`);
}

// ---------------------------------------------------------------------------
// (b) every CREATE TABLE declares a PRIMARY KEY
// ---------------------------------------------------------------------------
{
  let tables = 0;
  const offenders = [];
  for (const mig of migrations) {
    for (const t of extractCreateTables(mig.clean)) {
      // PARTITION OF children inherit the partitioned parent's constraints.
      const isPartitionChild = /CREATE\s+TABLE\s+[\w.]+\s+PARTITION\s+OF/i.test(
        mig.clean.slice(t.start, t.start + 200)
      );
      if (isPartitionChild) continue;
      tables++;
      if (!/PRIMARY\s+KEY/i.test(t.body)) offenders.push(`${mig.file}: ${t.name}`);
    }
  }
  if (offenders.length) fail('tables/primary-key', `CREATE TABLE without PRIMARY KEY:\n  ${offenders.join('\n  ')}`);
  pass('tables/primary-key', `${tables} CREATE TABLE statements all declare a PRIMARY KEY (partition children exempt)`);
}

// ---------------------------------------------------------------------------
// (c) publication views: explicit column lists, no forbidden columns
// ---------------------------------------------------------------------------
{
  const offenders = [];
  let views = 0;
  for (const mig of migrations) {
    for (const v of extractViews(mig.clean)) {
      views++;
      if (!v.hasExplicitColumns) offenders.push(`${mig.file}: ${v.name} lacks an explicit column list`);
      const haystack = [...v.cols, v.body].join('\n');
      for (const col of FORBIDDEN_COLUMNS) {
        if (forbiddenRe(col).test(haystack)) offenders.push(`${mig.file}: ${v.name} references forbidden column "${col}"`);
      }
    }
  }
  if (views === 0) fail('views/forbidden-columns', 'no views defined by migrations');
  if (offenders.length) fail('views/forbidden-columns', offenders.join('\n  '));
  pass('views/forbidden-columns', `${views} views declare explicit column lists; none of [${FORBIDDEN_COLUMNS.join(', ')}] appears in any view`);
}

// ---------------------------------------------------------------------------
// (d) forbidden-column scan across all migration SQL
//     Allowed ONLY inside the private table water.station_internal_detail.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const mig of migrations) {
    const tables = extractCreateTables(mig.clean);
    const views = extractViews(mig.clean);
    for (const col of FORBIDDEN_COLUMNS) {
      const re = forbiddenRe(col, 'gi');
      let m;
      while ((m = re.exec(mig.clean)) !== null) {
        const pos = m.index;
        const host = tables.find((t) => pos >= t.start && pos <= t.end);
        const hostView = views.find((v) => pos >= v.start && pos <= v.end);
        if (hostView) {
          offenders.push(`${mig.file}: "${col}" inside view ${hostView.name} (public-facing object)`);
        } else if (host) {
          if (!PRIVATE_TABLES_ALLOWED_FORBIDDEN.has(host.name.toLowerCase())) {
            offenders.push(`${mig.file}: "${col}" inside table ${host.name} (not a sanctioned private table)`);
          }
        } else {
          offenders.push(`${mig.file}: "${col}" outside any CREATE TABLE block`);
        }
      }
    }
  }
  if (offenders.length) fail('forbidden-column-leak', offenders.join('\n  '));
  pass('forbidden-column-leak', `restricted names confined to ${[...PRIVATE_TABLES_ALLOWED_FORBIDDEN][0]} across ${migrations.length} migration files`);
}

// The final definition of each public view must enforce the same lifecycle
// as packages/policy isCurrentlyPublished; older migrations remain immutable.
{
  const latestViews = new Map();
  for (const migration of migrations) {
    for (const view of extractViews(migration.clean)) latestViews.set(view.name, view);
  }
  for (const name of ['water.v_public_stations', 'water.v_public_station_summary']) {
    const view = latestViews.get(name);
    if (!view || !/WHERE\s+s\.visibility\s*=\s*'public'\s+AND\s+s\.status\s+IN\s*\(\s*'active'\s*,\s*'inactive'\s*\)/i.test(view.body)) {
      fail('views/publication-lifecycle', `${name} must publish only public active/inactive stations`);
    }
  }
  pass('views/publication-lifecycle', 'final public views exclude proposed and retired stations');
}

// ---------------------------------------------------------------------------
// (e) fixture loader output matches expected row counts exactly
// ---------------------------------------------------------------------------
{
  const run = () =>
    spawnSync(process.execPath, [LOADER], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const first = run();
  if (first.status !== 0) fail('fixtures/loader', `load-fixtures.mjs exited ${first.status}: ${first.stderr}`);
  const second = run();
  if (second.status !== 0) fail('fixtures/loader', `second run exited ${second.status}: ${second.stderr}`);
  if (first.stdout !== second.stdout) fail('fixtures/loader', 'two runs produced different SQL (non-deterministic)');

  const counts = new Map();
  for (const line of first.stdout.split('\n')) {
    if (!line.startsWith('INSERT INTO ')) continue;
    const m = line.match(/^INSERT INTO water\.(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(/);
    if (!m) fail('fixtures/loader', `statement is not an explicit-column idempotent INSERT:\n  ${line.slice(0, 160)}`);
    if (!line.endsWith(' ON CONFLICT DO NOTHING;')) {
      fail('fixtures/loader', `statement missing ON CONFLICT DO NOTHING:\n  ${line.slice(0, 160)}`);
    }
    const [, table, cols] = m;
    const columns = cols.split(',').map((c) => c.trim()).filter(Boolean);
    if (columns.length === 0) fail('fixtures/loader', `empty column list for water.${table}`);
    if (/VALUES\s*\(NULL(?:,|\))/.test(line)) {
      fail('fixtures/loader', `fixture row has a NULL leading identifier in water.${table}`);
    }
    if (/ARRAY\[\](?!::text\[\])/.test(line)) {
      fail('fixtures/loader', `empty array lacks an explicit text[] type in water.${table}`);
    }
    counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  if (counts.size === 0) fail('fixtures/loader', 'loader emitted no INSERT statements');

  const expectedDoc = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
  const expected = expectedDoc.tables;
  const emittedMissing = [...Object.keys(expected)].filter((t) => !counts.has(t) && expected[t] !== 0);
  const unexpected = [...counts.keys()].filter((t) => !(t in expected));
  const mismatched = [...counts.keys()].filter((t) => t in expected && counts.get(t) !== expected[t]);
  const problems = [
    ...emittedMissing.map((t) => `table ${t} expected ${expected[t]} rows but loader emits nothing`),
    ...unexpected.map((t) => `table ${t} emitted by loader but absent from expected-row-counts.json`),
    ...mismatched.map((t) => `table ${t}: expected ${expected[t]} rows, loader emits ${counts.get(t)}`),
  ];
  if (problems.length) fail('fixtures/row-counts', problems.join('\n  '));

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const seedOk = expectedDoc.seed === JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'contracts', 'seed-manifest.json'), 'utf8')).seed;
  if (!seedOk) fail('fixtures/row-counts', 'expected-row-counts.json seed does not match seed-manifest.json');
  pass('fixtures/row-counts', `${total} INSERTs across ${counts.size} tables match expected-row-counts.json exactly (deterministic double-run, seed ${expectedDoc.seed})`);
}

console.log(`OK database/check.mjs: ${results.length}/${results.length} checks passed (migrations=${migrationFiles.length}, forbidden=[${FORBIDDEN_COLUMNS.join(', ')}])`);
