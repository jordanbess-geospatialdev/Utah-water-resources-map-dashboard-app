#!/usr/bin/env node
/**
 * WD-021 — one-command MVP qualification reproducer.
 *
 * Reproduces, from a clean checkout state, the machine-checkable evidence
 * chain for the release gate defined in
 * docs/product/baseline/04-ai-development-and-testing.md ("Verification
 * matrix" T-01..T-16). Zero dependencies: Node built-ins only. BLOCKED
 * items (environment-dependent evidence) are recorded with the exact
 * blocking reason and do NOT fail the run; every FAIL does.
 *
 * Usage (from the worktree root):
 *   node tests/qualification/run-qualification.mjs
 *
 * Exit code: 0 when no group FAILED (BLOCKED allowed), 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PATHS = {
  contracts: join(ROOT, 'packages', 'contracts'),
  policy: join(ROOT, 'packages', 'policy'),
  database: join(ROOT, 'database'),
  gateway: join(ROOT, 'services', 'geo-gateway'),
  api: join(ROOT, 'services', 'api'),
  web: join(ROOT, 'apps', 'web'),
  recorded: join(ROOT, 'infra', 'neoserver', 'qualification', 'recorded'),
  adversarial: join(ROOT, 'tests', 'qualification', 'adversarial'),
};

// ---------------------------------------------------------------------------
// Environment record
// ---------------------------------------------------------------------------

function git(args) {
  const result = spawnSync('git', args.split(' '), { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function pnpmVersion() {
  const useShell = process.platform === 'win32';
  for (const candidate of [['pnpm', ['--version']], ['corepack', ['pnpm', '--version']]]) {
    try {
      const result = spawnSync(candidate[0], candidate[1], { encoding: 'utf8', timeout: 60_000, shell: useShell });
      if (result.status === 0 && result.stdout) return `${candidate[0]} ${result.stdout.trim()}`;
    } catch {
      /* try next */
    }
  }
  return 'unavailable';
}

const ENV = {
  node: process.version,
  pnpm: pnpmVersion(),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  commit: git('rev-parse HEAD'),
  branch: git('rev-parse --abbrev-ref HEAD'),
  date: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Runner plumbing
// ---------------------------------------------------------------------------

const STRIP_ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function cmd(command, cwd, timeoutMs = 300_000) {
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(STRIP_ANSI, '');
  return { ok: result.status === 0, status: result.status, output, ms: Date.now() - started };
}

/** Parse a `node --test` summary from either the spec ("ℹ pass 3") or TAP ("# pass 3") output shape. */
function parseTestSummary(output) {
  const summary = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(?:[#ℹ]\s*)?(tests|suites|pass|fail|cancelled|skipped)\s+(\d+)\s*$/);
    if (match) summary[match[1]] = Number(match[2]);
  }
  return summary;
}

const groups = [];
let currentGroup = null;

function group(id, title, fn) {
  currentGroup = { id, title, result: null, notes: [], blocked: [], evidence: [], failures: [] };
  groups.push(currentGroup);
  console.log(`\n=== ${id} — ${title} ===`);
  try {
    fn();
    if (currentGroup.failures.length > 0) {
      currentGroup.result = 'FAIL';
    } else {
      currentGroup.result = 'PASS';
    }
  } catch (error) {
    currentGroup.failures.push(String(error?.message ?? error));
    currentGroup.result = 'FAIL';
  }
  for (const note of currentGroup.notes) console.log(`  note: ${note}`);
  for (const blocked of currentGroup.blocked) console.log(`  BLOCKED: ${blocked}`);
  for (const failure of currentGroup.failures) console.log(`  FAILURE: ${failure}`);
  console.log(`  -> ${currentGroup.result}`);
}

function step(label, fn) {
  try {
    fn();
    currentGroup.evidence.push(label);
    console.log(`  ok   ${label}`);
  } catch (error) {
    currentGroup.failures.push(`${label}: ${String(error?.message ?? error)}`);
    console.log(`  FAIL ${label}: ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

function cmdStep(label, command, cwd, options = {}) {
  const run = cmd(command, cwd, options.timeoutMs);
  const summary = parseTestSummary(run.output);
  const detail = summary.tests !== undefined ? `tests=${summary.tests} pass=${summary.pass ?? 0} fail=${summary.fail ?? 0}` : `exit=${run.status} (${run.ms} ms)`;
  if (!run.ok || (summary.fail ?? 0) > 0) {
    const tail = run.output.split('\n').filter(Boolean).slice(-6).join(' | ');
    currentGroup.failures.push(`${label}: command failed (${detail}) ${tail.slice(0, 400)}`);
    console.log(`  FAIL ${label} (${detail})`);
    console.log(run.output.split('\n').filter((l) => /✖|AssertionError|not ok|FAIL/.test(l)).slice(0, 6).map((l) => `       ${l.trim().slice(0, 160)}`).join('\n'));
    return run;
  }
  currentGroup.evidence.push(`${label} [${detail}]`);
  console.log(`  ok   ${label} [${detail}]`);
  if (options.onOutput) options.onOutput(run.output);
  return run;
}

function note(text) {
  currentGroup.notes.push(text);
}

function blocked(reason) {
  currentGroup.blocked.push(reason);
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Environment header
// ---------------------------------------------------------------------------

console.log('WD-021 MVP qualification — machine-checkable evidence chain');
console.log('Environment record:');
for (const [key, value] of Object.entries(ENV)) console.log(`  ${key.padEnd(8)} ${value}`);
assert(ENV.commit, 'run inside the git worktree (commit SHA required for the evidence record)');

// ---------------------------------------------------------------------------
// T-01 Requirements and contract
// ---------------------------------------------------------------------------

group('T-01', 'Requirements and contract (contracts checker + traceability)', () => {
  cmdStep('packages/contracts checker (schemas, OpenAPI, fixtures, contract hashes)', ['node', 'check.mjs'], PATHS.contracts);

  const prd = readFileSync(join(ROOT, 'docs', 'product', 'baseline', '01-product-requirements.md'), 'utf8');
  const expectedIds = [
    ...Array.from({ length: 68 }, (_, i) => `FR-${String(i + 1).padStart(3, '0')}`),
    ...Array.from({ length: 10 }, (_, i) => `NFR-${String(i + 1).padStart(3, '0')}`),
  ];
  step(`all ${expectedIds.length} requirement ids (FR-001..FR-068, NFR-001..NFR-010) resolve in the PRD`, () => {
    const missing = expectedIds.filter((id) => !prd.includes(id));
    assert(missing.length === 0, `unresolved requirement ids: ${missing.join(', ')}`);
  });

  const backlog = readJson(join(ROOT, 'docs', 'delivery', 'specifications', 'backlog.json'));
  const registry = new Set(backlog.tasks.flatMap((task) => task.requirement_ids ?? []));
  step(`every requirement id cited by backlog tasks resolves in the PRD (${registry.size} cited)`, () => {
    const missing = [...registry].filter((id) => !prd.includes(id));
    assert(missing.length === 0, `task citations not in the PRD: ${missing.join(', ')}`);
  });
  step(`test catalog carries T-01..T-16`, () => {
    const catalog = new Set(backlog.test_catalog);
    for (let i = 1; i <= 16; i += 1) assert(catalog.has(`T-${String(i).padStart(2, '0')}`), `test catalog missing T-${String(i).padStart(2, '0')}`);
  });

  const rootTasks = readJson(join(ROOT, 'tasks.json')).tasks;
  const backlogTasks = new Map(backlog.tasks.map((task) => [task.id, task]));
  const stale = [];
  step(`root tasks.json and delivery backlog.json agree on task identity (${rootTasks.length} tasks)`, () => {
    for (const task of rootTasks) {
      const counterpart = backlogTasks.get(task.id);
      assert(counterpart, `task ${task.id} missing from delivery backlog.json`);
      if (counterpart.status !== task.status) stale.push(`${task.id}: root=${task.status} delivery-copy=${counterpart.status}`);
    }
  });
  if (stale.length > 0) {
    note(`delivery-copy status staleness (DEFECT-Q4, documentation only): ${stale.join('; ')}`);
  }

  const csv = readFileSync(join(ROOT, 'docs', 'traceability', 'requirements-traceability.csv'), 'utf8');
  const csvIds = csv
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',')[0]);
  step(`traceability CSV covers every requirement id (${csvIds.length} rows)`, () => {
    assert(csvIds.length === expectedIds.length, `CSV has ${csvIds.length} rows, expected ${expectedIds.length}`);
    const missing = expectedIds.filter((id) => !csvIds.includes(id));
    assert(missing.length === 0, `ids missing from the CSV: ${missing.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// T-02 / T-03 Policy unit + API authorization
// ---------------------------------------------------------------------------

group('T-02/T-03', 'Policy suite + adversarial authorization sweeps (engine, tokens, exhaustive denial product)', () => {
  cmdStep('packages/policy suite (matrix x engine x fixtures)', ['node', '--test', '--experimental-strip-types', 'test/policy.test.ts'], PATHS.policy);
  cmdStep('adversarial policy fuzz (640 seeded tuples vs independent oracle + exhaustive principal x restricted-object x accessor product)', ['node', '--test', 'policy-fuzz.test.mjs'], PATHS.adversarial);
  cmdStep('adversarial token scope-escalation set (issue-time, use-time, bounds, secrets)', ['node', '--test', 'token-escalation.test.mjs'], PATHS.adversarial);
  cmdStep('adversarial restricted-byte sweep (projections, exports, summaries, reports, gateway)', ['node', '--test', 'restricted-bytes.test.mjs'], PATHS.adversarial);

  const principalIds = ['principal-diego-steward', 'principal-fatima-engineer', 'principal-priya-engineer', 'principal-cody-commissioner', 'principal-ana-deputy', 'principal-sarah-researcher'];
  note(`exhaustive denial product covers ${principalIds.length + 1} principals (incl. anonymous) x 10 restricted objects x 8 accessor families x 2 world states (active + deactivated), oracle-checked`);
  note('T-03 HTTP status mapping: no HTTP transport is wired yet (services/api is the domain layer); denial status policy (401/403/404) is exercised through the domain suites, not a live server');
});

// ---------------------------------------------------------------------------
// T-04 PostgreSQL integration
// ---------------------------------------------------------------------------

group('T-04', 'Database static gate (live-SQL parts BLOCKED)', () => {
  cmdStep('database/check.mjs (migrations, forbidden columns, fixture row counts)', ['node', 'check.mjs'], PATHS.database);
  blocked('live-SQL evidence (migrations applied to a disposable PostgreSQL/PostGIS, publication-view behavior, unique ids/constraints, index query plans, transaction rollback, pool isolation): no database');
});

// ---------------------------------------------------------------------------
// T-05 Protocol and spatial
// ---------------------------------------------------------------------------

group('T-05', 'Geo-gateway suite + recorded live-capture expectations', () => {
  cmdStep('services/geo-gateway suite (87 tests: z/y/x, allowlist, TileJSON, URL trust)', ['node', '--test', '--experimental-strip-types', 'test/allowlist.test.ts', 'test/gateway.test.ts', 'test/tilejson.test.ts', 'test/url.test.ts'], PATHS.gateway);

  step('recorded T-05 capture evidence: manifest + report + expectations present', () => {
    assert(existsSync(join(PATHS.recorded, 'manifest.json')), 'manifest.json missing');
    assert(existsSync(join(PATHS.recorded, 'CAPTURE-REPORT.md')), 'CAPTURE-REPORT.md missing');
    assert(existsSync(join(PATHS.recorded, 'EXPECTATIONS.md')), 'EXPECTATIONS.md missing');
  });

  const manifest = readJson(join(PATHS.recorded, 'manifest.json'));
  step(`recorded manifest carries ${manifest.captures.length} captures (executed 2026-10-21)`, () => {
    assert(manifest.captures.length === 14, `expected 14 recorded captures, found ${manifest.captures.length}`);
  });

  step('every recorded capture artifact re-verifies against its manifest sha256', () => {
    const extensions = ['.json', '.pbf', '.png', '.xml', '.txt', '.log'];
    let verified = 0;
    for (const capture of manifest.captures) {
      const file = extensions.map((ext) => join(PATHS.recorded, capture.name + ext)).find((candidate) => existsSync(candidate));
      if (!file) continue; // probes recorded in the manifest only (console/probe logs)
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      assert(digest === capture.sha256, `sha256 mismatch for recorded artifact ${capture.name}`);
      verified += 1;
    }
    assert(verified >= 10, `only ${verified} recorded artifacts could be re-verified against manifest hashes`);
    note(`${verified} recorded artifacts re-hashed byte-identical to manifest.json`);
  });

  const report = readFileSync(join(PATHS.recorded, 'CAPTURE-REPORT.md'), 'utf8');
  step('CAPTURE-REPORT preserves the historical 14/14 capture outcome and MVT-version finding', () => {
    assert(report.includes('14/14 captures at expected statuses'), 'outcome line missing');
    assert(/MVT layer version 1/i.test(report), 'the historical MVT layer version 1 FAIL (defect D5) must stay recorded');
  });

  note('EXECUTED: original live capture on the pinned Docker stack, 2026-10-21 (13/14 original checks passed). KNOWN-SERVER-BEHAVIOR.md records the subsequent D5 v1/v2 compatibility policy and D7 deterministic-id correction; the frozen capture remains historical evidence.');
  blocked('live re-capture in THIS run: requires the pinned Docker stack (docker compose); no Docker daemon engaged for WD-021 — recorded evidence verified for integrity instead');
});

// ---------------------------------------------------------------------------
// T-06 / T-07 / T-15 Data, revisions, bulk inputs, alerts and reports
// ---------------------------------------------------------------------------

group('T-06/T-07/T-15', 'API domain suites (revisions, imports, reports, notifications, QC)', () => {
  const run = cmdStep('services/api suite', ['node', '--test', '--experimental-strip-types', 'src/**/*.test.ts'], PATHS.api, { timeoutMs: 420_000 });
  const output = run.output;
  const keywordGroups = {
    'T-06 revisions/audit': /revise|revision|tombstone|optimistic|best-available|correction/i,
    'T-07 bulk imports': /import|csv|formula|duplicate submission|row error/i,
    'T-15 notifications/reports': /notification|digest|schedule|threshold|report|determinism/i,
  };
  for (const [label, pattern] of Object.entries(keywordGroups)) {
    const lines = output.split('\n').filter((line) => pattern.test(line)).length;
    step(`${label}: matching test lines present in the api run`, () => {
      assert(lines > 0, `no output lines match ${label}`);
    });
    note(`${label}: ~${lines} matching result lines`);
  }
  cmdStep('adversarial restricted-byte sweep includes export/report surfaces', ['node', '--test', 'restricted-bytes.test.mjs'], PATHS.adversarial);
});

// ---------------------------------------------------------------------------
// T-08 Cache and privacy
// ---------------------------------------------------------------------------

group('T-08', 'Cache and privacy (gateway cache policy + attachments visibility wall + canary scan)', () => {
  cmdStep('geo-gateway cache/privacy suite (cohort private,no-store; deny-before-upstream)', ['node', '--test', '--experimental-strip-types', 'test/gateway.test.ts'], PATHS.gateway);
  cmdStep('api attachments visibility-wall suite', ['node', '--test', '--experimental-strip-types', 'src/workflows/visits/test/attachments.test.ts'], PATHS.api);
  const sweep = cmdStep('adversarial canary sweep across public surfaces (asserts zero canary bytes)', ['node', '--test', 'restricted-bytes.test.mjs'], PATHS.adversarial);
  const summary = parseTestSummary(sweep.output);
  note(`canary sweep executed ${summary.tests ?? '?'} assertions-groups; zero occurrences of gate codes / wiring notes / publication canary in any public projection`);
  blocked('live tile-cache invalidation against a warm NeoServer cache: covered by the recorded T-05 probe-cache-refresh.log evidence; re-run requires the Docker stack');
});

// ---------------------------------------------------------------------------
// T-10 / T-13 Web persona behavior + AI behavior
// ---------------------------------------------------------------------------

group('T-10/T-13', 'Web suites (persona projections, share codec) + AI filter injection corpus', () => {
  cmdStep('apps/web suite (projection, shareUrl, filters, AI proposal)', ['node', '--test', '--experimental-strip-types', 'tests/*.test.ts', 'src/features/**/*.test.ts', 'src/map/**/*.test.ts'], PATHS.web, { timeoutMs: 420_000 });
  cmdStep('api AI filter-parser suites (parser, equivalence, injection corpus)', ['node', '--test', '--experimental-strip-types', 'src/ai/filter-parser/parser.test.ts', 'src/ai/filter-parser/equivalence.test.ts', 'src/ai/filter-parser/security.test.ts'], PATHS.api);
  cmdStep('adversarial share-URL hostile corpus (60+ hostile queries, no throw, no leak, byte-stable round trips)', ['node', '--test', 'share-url-corpus.test.mjs'], PATHS.adversarial);
  const corpus = readJson(join(ROOT, 'fixtures', 'ai', 'injection-corpus.json'));
  note(`AI injection corpus: ${corpus.cases.length} curated cases replayed by the api suite against interpret()`);
  note('T-10 browser persona E2E (Playwright) and T-11 accessibility remain manual/staging items — see report');
});

// ---------------------------------------------------------------------------
// T-16 Dependency and supply chain
// ---------------------------------------------------------------------------

group('T-16', 'Dependency integrity (lockfile, frozen install, pinned map engines)', () => {
  step('pnpm-lock.yaml present; no competing lockfile', () => {
    assert(existsSync(join(ROOT, 'pnpm-lock.yaml')), 'pnpm-lock.yaml missing');
    assert(!existsSync(join(ROOT, 'package-lock.json')), 'package-lock.json must not exist');
    assert(!existsSync(join(ROOT, 'yarn.lock')), 'yarn.lock must not exist');
  });

  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  step('lockfile version is pnpm v9+', () => {
    const match = lock.match(/^lockfileVersion: ('?)([^'\n]+)\1/m);
    assert(match, 'lockfileVersion header missing');
    assert(Number(match[2]) >= 9, `unexpected lockfileVersion ${match[2]}`);
  });

  const webPackage = readJson(join(PATHS.web, 'package.json'));
  step('GeoLibre and MapLibre pinned EXACTLY (no ranges) in apps/web package.json', () => {
    const pins = ['@geolibre/core', '@geolibre/map', 'maplibre-gl', 'react', 'react-dom'];
    for (const name of pins) {
      const version = webPackage.dependencies[name];
      assert(version !== undefined, `${name} missing from dependencies`);
      assert(/^\d+\.\d+\.\d+$/.test(version), `${name} is not exactly pinned: "${version}"`);
    }
  });

  step('lockfile specifiers match package.json exactly for the pinned engines', () => {
    // pnpm v9 lockfile: under `importers:` -> `apps/web:` ->
    // `dependencies:` -> `'@geolibre/core': { specifier: 3.3.0, ... }`.
    const webStart = lock.indexOf('  apps/web:');
    assert(webStart > 0, 'apps/web importer block missing from the lockfile');
    const webEnd = lock.indexOf('\npackages:', webStart);
    const webBlock = lock.slice(webStart, webEnd > 0 ? webEnd : undefined);
    const webLines = webBlock.split('\n');
    for (const name of ['@geolibre/core', '@geolibre/map', 'maplibre-gl', 'react', 'react-dom']) {
      // Scoped names are quoted in the lockfile, bare names are not; match a
      // whole dependency-key line so 'react' never matches 'lucide-react'.
      const keyPattern = new RegExp(`^\\s*(?:'${name.replace(/[/@]/g, '\\$&')}'|${name.replace(/[/@]/g, '\\$&')}):\\s*$`);
      const keyLine = webLines.findIndex((line) => keyPattern.test(line));
      assert(keyLine > 0, `${name} missing from the apps/web importer dependencies`);
      const specifierMatch = /specifier:\s*([^\n]+)/.exec(webLines.slice(keyLine, keyLine + 3).join('\n'));
      const specifier = specifierMatch?.[1]?.trim().replace(/^'(.*)'$/, '$1');
      assert(specifier === webPackage.dependencies[name], `lockfile specifier for ${name} ("${specifier}") does not match package.json ("${webPackage.dependencies[name]}")`);
    }
  });

  const frozen = cmdStep('frozen install works (pnpm install --frozen-lockfile)', ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], ROOT, { timeoutMs: 420_000 });
  if (!frozen.ok) {
    blocked('frozen install could not be verified in this environment — see command output');
  } else {
    note(`frozen install completed in ${frozen.ms} ms (store-backed, no lockfile drift)`);
  }

  const lockDigest = createHash('sha256').update(readFileSync(join(ROOT, 'pnpm-lock.yaml'))).digest('hex');
  note(`pnpm-lock.yaml sha256 ${lockDigest}`);
  blocked('full dependency/license vulnerability scan (OSV/License audit tooling): not part of this zero-dependency qualification run; lockfile hash recorded above for the release manifest');
});

// ---------------------------------------------------------------------------
// Out-of-scope gates recorded for honesty (never silently skipped)
// ---------------------------------------------------------------------------

group('T-09/T-11/T-12/T-14/R2', 'Gates outside this machine run (recorded, not silently skipped)', () => {
  blocked('T-09 offline sync: R2 scope (offline capture/reconnect/idempotency needs the offline client + browser storage) — planned, not required for the MVP gate');
  blocked('T-11 accessibility: browser/manual keyboard, screen reader, contrast, 200% zoom evidence — planned and unimplemented in this environment (no browser automation engaged)');
  blocked('T-12 performance/load: requires the staging profile (10,000 features, 100 sessions) — planned, not executed here');
  blocked('T-14 operations drills: restart/backup/restore/single-writer drills EXECUTED 2026-10-21 and recorded in infra/neoserver/qualification/recorded/ (probe-store-drills, restart, recovered tile sha); re-run requires the Docker stack');
  blocked('R2 acceptance (WD-026) and Discovery (WD-023): explicitly out of the MVP gate — planned and unimplemented, not required for MVP');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(78));
console.log('WD-021 QUALIFICATION SUMMARY');
console.log('='.repeat(78));
const width = { id: 14, result: 9 };
console.log(`${'Group'.padEnd(width.id)}${'Result'.padEnd(width.result)}Detail`);
let failures = 0;
for (const entry of groups) {
  const marker = entry.result === 'FAIL' ? 'FAIL' : entry.result;
  const details = [
    entry.evidence.length > 0 ? `${entry.evidence.length} checks` : null,
    entry.blocked.length > 0 ? `${entry.blocked.length} BLOCKED` : null,
    entry.failures.length > 0 ? `${entry.failures.length} failures` : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.log(`${entry.id.padEnd(width.id)}${marker.padEnd(width.result)}${details}`);
  if (entry.result === 'FAIL') failures += 1;
}
console.log('-'.repeat(78));
console.log(`Environment: node ${ENV.node} | pnpm ${ENV.pnpm} | ${ENV.platform}`);
console.log(`Revision:    ${ENV.branch} @ ${ENV.commit}`);
console.log(`Executed:    ${ENV.date}`);
const verdict = failures === 0 ? 'PASS (BLOCKED items recorded above are environment gaps, not failures)' : 'FAIL';
console.log(`Verdict:     ${verdict}`);
console.log('Determinism: run this script twice; identical group results are required (adversarial corpora are seeded and internally re-run).');
process.exit(failures === 0 ? 0 : 1);
