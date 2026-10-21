#!/usr/bin/env node
// check.mjs — zero-dependency contract and fixture validator for @utah-water/contracts (WD-002).
//
// Run by `pnpm test` (package.json test script) and directly via `node check.mjs`.
// Uses only Node built-ins (node:fs, node:path, node:crypto, node:url):
// the repository lockfile is frozen, so no npm dependency may be introduced.
//
// What it does:
//   1. JSON-parses every contract and fixture file.
//   2. Validates fixtures against the JSON schemas in ./schemas using a minimal
//      evaluator that supports exactly the keywords the schemas use:
//      type, required, enum, properties, items (type may be a string or array).
//   3. Checks referential integrity across the fixture world (stations ->
//      systems/subgroups/providers/organizations/vocabulary; observations ->
//      datastreams/vocabulary; revisions -> observations/revisions/principles/
//      vocabulary; entitlements -> principals/systems).
//   4. Asserts the deterministic fixture invariants (fixed clock/seed, DST-
//      spanning series, zero/null/negative/out-of-range values, duplicates,
//      gap, late arrival, device replacement, rating periods, public/private
//      field separation, shared display name, axis-order-detectable geometry).
//   5. Structurally validates openapi.json (3.1.0, /api/v1, full route table,
//      operationIds, Problem error model, If-Match/Idempotency-Key headers,
//      resolvable $refs, embedded schema copies identical to schemas/*.json).
//   6. Recomputes the sha256 contract hashes and compares them with
//      CONTRACTS-HASH.md (the published consumer-agreement artifact).
//
// Any failure prints a precise FAIL line and exits 1; success prints one line.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(PKG, 'schemas');
const ROOT = dirname(dirname(PKG));
const FIXTURES = join(ROOT, 'fixtures', 'contracts');
const DST_TRANSITION = '2026-03-08T09:00:00Z'; // 02:00 MST -> 03:00 MDT
const TRANSITION_MS = Date.parse(DST_TRANSITION);
const FIXED_CLOCK = '2026-03-09T07:00:00Z';
const CLOCK_MS = Date.parse(FIXED_CLOCK);
const AGREEMENT_SENTENCE =
  'Consumers must agree this hash before implementing against these contracts.';

let asserted = 0;
const failures = [];
function assert(cond, label) {
  asserted += 1;
  if (!cond) failures.push(label);
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// ---------------------------------------------------------------- JSON parse
const readJson = (rel, base) => {
  const p = join(base, rel);
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    failures.push(`cannot read ${p}: ${e.message}`);
    asserted += 1;
    return null;
  }
  asserted += 1;
  try {
    return JSON.parse(raw);
  } catch (e) {
    failures.push(`invalid JSON in ${p}: ${e.message}`);
    return null;
  }
};

const SCHEMA_NAMES = [
  'async-job.json',
  'catalog-layer.json',
  'entitlement.json',
  'error.json',
  'filter-set.json',
  'observation.json',
  'revision.json',
  'site.json',
];
const schemas = {};
for (const n of SCHEMA_NAMES) schemas[n] = readJson(n, SCHEMA_DIR);
const openapi = readJson('openapi.json', PKG);
const manifest = readJson('seed-manifest.json', FIXTURES);
const systemsFx = readJson('systems.json', FIXTURES);
const principalsFx = readJson('principals.json', FIXTURES);
const stationsFx = readJson('stations.json', FIXTURES);
const observationsFx = readJson('observations.json', FIXTURES);
const vocabularyFx = readJson('vocabulary.json', FIXTURES);
const contractsHashMd = (() => {
  try {
    return readFileSync(join(PKG, 'CONTRACTS-HASH.md'), 'utf8');
  } catch {
    failures.push('CONTRACTS-HASH.md is missing');
    return '';
  }
})();

// ------------------------------------------------- minimal schema evaluation
// Supports exactly: type (string or array; 'integer' strict), required, enum,
// properties (recursive), items (recursive). Unknown keywords are ignored.
function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'object' | 'string' | 'number' | 'boolean'
}
function typeOk(expected, value) {
  const list = Array.isArray(expected) ? expected : [expected];
  const t = jsType(value);
  return list.some((e) =>
    e === 'integer' ? t === 'number' && Number.isInteger(value) : e === t
  );
}
function evaluate(schema, data, path, issues) {
  if (schema === undefined || schema === true) return;
  if (!typeOk(schema.type ?? ['object', 'array', 'string', 'number', 'boolean', 'null'], data)) {
    issues.push(`${path}: type ${JSON.stringify(schema.type)} expected, got ${jsType(data)} (${JSON.stringify(data)})`);
    return; // deeper checks are meaningless after a type mismatch
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => v === data)) {
    issues.push(`${path}: ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]`);
  }
  if (jsType(data) === 'object' && Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (!(k in data)) issues.push(`${path}: missing required property "${k}"`);
    }
  }
  if (jsType(data) === 'object' && schema.properties !== undefined) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in data) evaluate(sub, data[k], `${path}.${k}`, issues);
    }
  }
  if (jsType(data) === 'array' && schema.items !== undefined) {
    data.forEach((v, i) => evaluate(schema.items, v, `${path}[${i}]`, issues));
  }
}
function validateFixture(label, schema, instance) {
  const issues = [];
  evaluate(schema, instance, label, issues);
  assert(issues.length === 0, `schema validation failed for ${label}:\n    ${issues.join('\n    ')}`);
}

// ------------------------------------------------------- schema sanity + fixtures
for (const n of SCHEMA_NAMES) {
  if (!schemas[n]) continue;
  assert(
    schemas[n].$schema === 'https://json-schema.org/draft/2020-12/schema',
    `${n}: $schema must be JSON Schema draft 2020-12`
  );
  assert(typeof schemas[n].type === 'string', `${n}: top-level type must be a string`);
}

if (stationsFx) {
  for (const s of stationsFx.stations) validateFixture(`station ${s.id}`, schemas['site.json'], s);
}
if (observationsFx) {
  for (const o of observationsFx.observations) validateFixture(`observation ${o.id}`, schemas['observation.json'], o);
  for (const r of observationsFx.revisions) validateFixture(`revision ${r.id}`, schemas['revision.json'], r);
}
if (principalsFx) {
  for (const e of principalsFx.entitlements) validateFixture(`entitlement ${e.id}`, schemas['entitlement.json'], e);
}

// ------------------------------------------------------------ fixture indexes
const systemIds = new Set((systemsFx?.systems ?? []).map((s) => s.id));
const subgroupIds = new Set((systemsFx?.subgroups ?? []).map((s) => s.id));
const providerIds = new Set((systemsFx?.providers ?? []).map((p) => p.id));
const orgIds = new Set((principalsFx?.organizations ?? []).map((o) => o.id));
const users = principalsFx?.users ?? [];
const userIds = new Set(users.map((u) => u.id));
const entitlements = principalsFx?.entitlements ?? [];
const stations = stationsFx?.stations ?? [];
const stationIds = new Set(stations.map((s) => s.id));
const streams = stations.flatMap((s) => s.datastreams ?? []);
const streamIds = new Set(streams.map((d) => d.id));
const streamById = new Map(streams.map((d) => [d.id, d]));
const observations = observationsFx?.observations ?? [];
const revisions = observationsFx?.revisions ?? [];
const gaps = observationsFx?.gaps ?? [];
const propIds = new Set((vocabularyFx?.observedProperties ?? []).map((p) => p.id));
const unitIds = new Set((vocabularyFx?.units ?? []).map((u) => u.id));
const qualifierIds = new Set((vocabularyFx?.qualifiers ?? []).map((q) => q.id));
const levelIds = new Set((vocabularyFx?.processingLevels ?? []).map((l) => l.id));

// --------------------------------------------------------- referential integrity
for (const s of stations) {
  assert(systemIds.has(s.systemId), `station ${s.id}: systemId ${s.systemId} not in systems.json`);
  assert(providerIds.has(s.providerId), `station ${s.id}: providerId ${s.providerId} not in systems.json providers`);
  if (s.ownerOrganizationId !== undefined) {
    assert(orgIds.has(s.ownerOrganizationId), `station ${s.id}: ownerOrganizationId ${s.ownerOrganizationId} not in principals.json organizations`);
  }
  for (const sg of s.subgroupIds ?? []) {
    assert(subgroupIds.has(sg), `station ${s.id}: subgroupId ${sg} not in systems.json subgroups`);
  }
  for (const d of s.datastreams ?? []) {
    assert(d.stationId === s.id, `datastream ${d.id}: stationId ${d.stationId} does not match parent station ${s.id}`);
    assert(propIds.has(d.observedPropertyId), `datastream ${d.id}: observedPropertyId ${d.observedPropertyId} not in vocabulary`);
    assert(unitIds.has(d.unitId), `datastream ${d.id}: unitId ${d.unitId} not in vocabulary`);
  }
}
const obsIds = new Set();
const eventIds = new Set();
for (const o of observations) {
  assert(!obsIds.has(o.id), `observation id ${o.id} is not unique`);
  obsIds.add(o.id);
  assert(streamIds.has(o.streamId), `observation ${o.id}: streamId ${o.streamId} is not a known datastream`);
  assert(unitIds.has(o.unitId), `observation ${o.id}: unitId ${o.unitId} not in vocabulary`);
  assert(levelIds.has(o.processingLevel), `observation ${o.id}: processingLevel ${o.processingLevel} not in vocabulary`);
  assert(
    o.logicalKey === `${o.streamId}:${o.observedAt}`,
    `observation ${o.id}: logicalKey ${o.logicalKey} does not equal streamId:observedAt`
  );
  const evKey = `${o.streamId}|${o.sourceEventId}`;
  assert(!eventIds.has(evKey), `sourceEventId ${o.sourceEventId} is not unique within stream ${o.streamId}`);
  eventIds.add(evKey);
  const rec = Date.parse(o.receivedAt);
  const obs = Date.parse(o.observedAt);
  assert(!Number.isNaN(rec) && !Number.isNaN(obs), `observation ${o.id}: unparseable timestamp`);
  assert(rec >= obs, `observation ${o.id}: receivedAt ${o.receivedAt} precedes observedAt ${o.observedAt}`);
  assert(rec <= CLOCK_MS, `observation ${o.id}: receivedAt ${o.receivedAt} is after the fixed clock ${FIXED_CLOCK}`);
  assert(obs <= CLOCK_MS, `observation ${o.id}: observedAt ${o.observedAt} is after the fixed clock ${FIXED_CLOCK}`);
}
const revIds = new Set();
for (const r of revisions) {
  assert(!revIds.has(r.id), `revision id ${r.id} is not unique`);
  revIds.add(r.id);
  assert(obsIds.has(r.targetObservationId), `revision ${r.id}: targetObservationId ${r.targetObservationId} not found`);
  assert(
    r.baseRevisionId === null || revIds.has(r.baseRevisionId),
    `revision ${r.id}: baseRevisionId ${r.baseRevisionId} not found`
  );
  assert(userIds.has(r.actorId), `revision ${r.id}: actorId ${r.actorId} not a known principal`);
  assert(unitIds.has(r.unitId), `revision ${r.id}: unitId ${r.unitId} not in vocabulary`);
  assert(levelIds.has(r.processingLevel), `revision ${r.id}: processingLevel ${r.processingLevel} not in vocabulary`);
  for (const q of r.qualifierIds) {
    assert(qualifierIds.has(q), `revision ${r.id}: qualifierId ${q} not in governed vocabulary`);
  }
  assert(Date.parse(r.recordedAt) <= CLOCK_MS, `revision ${r.id}: recordedAt ${r.recordedAt} is after the fixed clock`);
}
for (const g of gaps) {
  assert(streamIds.has(g.streamId), `gap ${g.id}: streamId ${g.streamId} is not a known datastream`);
  assert(Date.parse(g.end) > Date.parse(g.start), `gap ${g.id}: end must be after start (half-open interval)`);
}
for (const e of entitlements) {
  assert(userIds.has(e.principalId), `entitlement ${e.id}: principalId ${e.principalId} not a known principal`);
  if (e.scopeType === 'system') {
    assert(systemIds.has(e.scopeId), `entitlement ${e.id}: scopeId ${e.scopeId} not a known system`);
  }
  if (e.role === 'deputy') {
    assert(e.delegation !== null, `entitlement ${e.id}: deputy grant must carry an explicit delegation`);
    assert(e.delegation && typeof e.delegation.effectiveAt === 'string', `entitlement ${e.id}: delegation.effectiveAt required`);
    assert(e.delegation && typeof e.delegation.expiresAt === 'string', `entitlement ${e.id}: delegation.expiresAt required`);
    assert(typeof e.expiresAt === 'string', `entitlement ${e.id}: deputy grant itself must expire`);
  }
}
for (const u of users) {
  if (u.assignedSystemId !== undefined) {
    assert(systemIds.has(u.assignedSystemId), `user ${u.id}: assignedSystemId ${u.assignedSystemId} not a known system`);
  }
}

// ---------------------------------------------------------------- invariants
// D.1 seed, fixed clock, time zone
assert(manifest?.seed === 'utah-water-fixture-v1', 'seed-manifest: seed must be "utah-water-fixture-v1"');
assert(manifest?.fixed_clock === FIXED_CLOCK, `seed-manifest: fixed_clock must be ${FIXED_CLOCK}`);
assert(manifest?.time_zone === 'America/Denver', 'seed-manifest: time_zone must be "America/Denver"');
assert(systemsFx?.seed === 'utah-water-fixture-v1', 'systems.json: seed mismatch');
assert(principalsFx?.seed === 'utah-water-fixture-v1', 'principals.json: seed mismatch');
assert(stationsFx?.seed === 'utah-water-fixture-v1', 'stations.json: seed mismatch');
assert(observationsFx?.seed === 'utah-water-fixture-v1', 'observations.json: seed mismatch');
assert(vocabularyFx?.seed === 'utah-water-fixture-v1', 'vocabulary.json: seed mismatch');

// D.2 systems: exactly 2 distribution systems + 1 subgroup
assert(systemsFx?.systems?.length === 2, `systems.json: expected exactly 2 distribution systems, got ${systemsFx?.systems?.length}`);
assert(systemsFx?.subgroups?.length === 1, `systems.json: expected exactly 1 subgroup, got ${systemsFx?.subgroups?.length}`);
assert(new Set(systemIds).size === 2, 'systems.json: system ids must be unique');

// D.3 principals: 2 owner orgs, 2 engineers on different systems, 1 commissioner,
//     1 delegated deputy, 1 steward, 1 researcher
const orgs = principalsFx?.organizations ?? [];
assert(orgs.length === 2, `principals.json: expected 2 organizations, got ${orgs.length}`);
assert(orgs.every((o) => o.kind === 'water-owner'), 'principals.json: both organizations must be water-owner kind');
const engineers = users.filter((u) => u.roles.includes('engineer'));
assert(engineers.length === 2, `principals.json: expected exactly 2 engineers, got ${engineers.length}`);
const engineerSystems = new Set(engineers.map((u) => u.assignedSystemId));
assert(engineerSystems.size === 2, 'principals.json: the two engineers must be assigned to DIFFERENT systems');
const commissioners = users.filter((u) => u.roles.includes('commissioner'));
assert(commissioners.length === 1, `principals.json: expected exactly 1 commissioner, got ${commissioners.length}`);
const deputies = users.filter((u) => u.roles.includes('deputy'));
assert(deputies.length === 1, `principals.json: expected exactly 1 deputy, got ${deputies.length}`);
assert(users.filter((u) => u.roles.includes('steward')).length === 1, 'principals.json: expected exactly 1 steward');
assert(users.filter((u) => u.roles.includes('researcher')).length === 1, 'principals.json: expected exactly 1 researcher');
const deputyEnt = entitlements.find((e) => e.role === 'deputy');
assert(deputyEnt?.status === 'active', 'principals.json: deputy entitlement must exist and be active');
assert(
  deputyEnt && Date.parse(deputyEnt.effectiveAt) < Date.parse(deputyEnt.expiresAt),
  'principals.json: deputy delegation effective date must precede expiry date'
);
assert(entitlements.length === 6, `principals.json: expected 6 entitlements, got ${entitlements.length}`);

// D.4 stations: 6 with the required classes
assert(stations.length === 6, `stations.json: expected 6 stations, got ${stations.length}`);
const byClass = {
  'public telemetry': stations.find((s) => s.visibility === 'public' && s.telemetry === 'telemetered' && s.status === 'active'),
  'public manual': stations.find((s) => s.visibility === 'public' && s.telemetry === 'manual' && s.status === 'active'),
  'restricted-owner': stations.find((s) => s.visibility === 'restricted' && s.ownerOrganizationId !== undefined),
  'internal diagnostic': stations.find((s) => s.visibility === 'internal'),
  inactive: stations.find((s) => s.status === 'inactive'),
  proposed: stations.find((s) => s.status === 'proposed'),
};
for (const [cls, st] of Object.entries(byClass)) {
  assert(st !== undefined, `stations.json: missing required station class "${cls}"`);
}
const nameCounts = new Map();
for (const s of stations) nameCounts.set(s.displayName, (nameCounts.get(s.displayName) ?? 0) + 1);
const sharedNames = [...nameCounts.entries()].filter(([, n]) => n > 1);
assert(sharedNames.length === 1, `stations.json: expected exactly one shared display name, got ${sharedNames.length}`);
if (sharedNames.length === 1) {
  const [sharedName, count] = sharedNames[0];
  assert(count === 2, `stations.json: shared display name must be used by exactly 2 stations, got ${count}`);
  const pair = stations.filter((s) => s.displayName === sharedName);
  const vis = new Set(pair.map((s) => s.visibility));
  assert(
    vis.has('public') && vis.has('restricted'),
    `stations.json: the shared-display-name pair must be one public and one restricted station`
  );
  assert(sharedName === manifest?.scenario_index?.shared_display_name, 'stations.json: shared display name must match seed-manifest scenario_index');
  assert(new Set(pair.map((s) => s.id)).size === 2, 'stations.json: shared display name must not mean shared identifier');
}
// D.5 restricted field on a public station (row visibility alone is insufficient)
const publicWithSecret = stations.filter((s) => s.visibility === 'public' && s.internal && typeof s.internal.gateCode === 'string' && s.internal.gateCode.length > 0);
assert(publicWithSecret.length === 1, `stations.json: expected exactly one public station carrying a restricted internal field (gate code), got ${publicWithSecret.length}`);
for (const st of stations) {
  if (st.internal) {
    assert(st.internal.visibility === 'internal', `station ${st.id}: internal block must be marked visibility "internal"`);
  }
}
// D.6 Utah-realistic geometry with axis-order-detectable spread
for (const s of stations) {
  assert(s.latitude >= 41 && s.latitude <= 42, `station ${s.id}: latitude ${s.latitude} outside Utah fixture band 41-42 N`);
  assert(s.longitude <= -111 && s.longitude >= -113, `station ${s.id}: longitude ${s.longitude} outside Utah fixture band -113..-111 W`);
}
const lats = stations.map((s) => s.latitude);
assert(Math.max(...lats) - Math.min(...lats) >= 0.5, 'stations.json: latitude spread must be >= 0.5 degrees so an axis-order swap is detectable');

// D.7 observations: compact, full scientific coverage
assert(observations.length < 120, `observations.json: fixture must stay compact (<120 points), got ${observations.length}`);
assert(observations.some((o) => o.value === 0), 'observations.json: must contain a zero value');
assert(observations.some((o) => o.value === null), 'observations.json: must contain a null (reported no-value) value');
assert(observations.some((o) => typeof o.value === 'number' && o.value < 0), 'observations.json: must contain a negative value');
const outOfRange = observations.filter((o) => {
  const d = streamById.get(o.streamId);
  return (
    typeof o.value === 'number' &&
    d &&
    ((d.validRangeMin !== undefined && o.value < d.validRangeMin) ||
      (d.validRangeMax !== undefined && o.value > d.validRangeMax))
  );
});
assert(outOfRange.length >= 2, `observations.json: must contain out-of-range values (one high flow spike, one low voltage); got ${outOfRange.length}`);
assert(observations.some((o) => o.valueType === 'estimated'), 'observations.json: must contain an estimated value');
assert(observations.some((o) => o.valueType === 'observed'), 'observations.json: must contain observed values');
// duplicates: same stream+instant, two distinct ids and source events
const dupKeys = new Map();
for (const o of observations) dupKeys.set(o.logicalKey, (dupKeys.get(o.logicalKey) ?? 0) + 1);
const dupList = [...dupKeys.entries()].filter(([, n]) => n > 1);
assert(dupList.length === 1, `observations.json: expected exactly one duplicated timestamp key, got ${dupList.length}`);
// DST: one stream spans the transition with both offsets on the correct sides
const dstStream = observations.filter((o) => o.streamId === 'str-corinne-q');
assert(dstStream.some((o) => o.sourceOffset === '-07:00' && Date.parse(o.observedAt) < TRANSITION_MS), 'observations.json: DST series must have -07:00 (MST) instants before 2026-03-08T09:00:00Z');
assert(dstStream.some((o) => o.sourceOffset === '-06:00' && Date.parse(o.observedAt) >= TRANSITION_MS), 'observations.json: DST series must have -06:00 (MDT) instants from 2026-03-08T09:00:00Z');
assert(!dstStream.some((o) => o.sourceOffset === '-07:00' && Date.parse(o.observedAt) >= TRANSITION_MS), 'observations.json: no -07:00 instants may exist at/after the 2026-03-08T09:00:00Z transition');
assert(!dstStream.some((o) => o.sourceOffset === '-06:00' && Date.parse(o.observedAt) < TRANSITION_MS), 'observations.json: no -06:00 instants may exist before the 2026-03-08T09:00:00Z transition');
assert(dstStream.some((o) => Date.parse(o.observedAt) < TRANSITION_MS) && dstStream.some((o) => Date.parse(o.observedAt) > TRANSITION_MS), 'observations.json: series must span both sides of the DST transition');
// gap: declared, empty, and a source outage
assert(gaps.length === 1, `observations.json: expected exactly 1 declared gap, got ${gaps.length}`);
for (const g of gaps) {
  const inside = observations.filter(
    (o) => o.streamId === g.streamId && Date.parse(o.observedAt) >= Date.parse(g.start) && Date.parse(o.observedAt) < Date.parse(g.end)
  );
  assert(inside.length === 0, `gap ${g.id}: interval must contain no observations (missing is not zero and is not back-filled)`);
  const d = streamById.get(g.streamId);
  const expected = Math.round((Date.parse(g.end) - Date.parse(g.start)) / 60000 / (d?.cadenceMinutes || 60));
  assert(g.missingCount === expected, `gap ${g.id}: missingCount ${g.missingCount} != cadence-implied ${expected}`);
}
assert(gaps.some((g) => g.reason === 'source-outage'), 'observations.json: must contain one source outage (declared gap with reason source-outage)');
// late arrival
const late = observations.filter((o) => Date.parse(o.receivedAt) - Date.parse(o.observedAt) > 6 * 3600 * 1000);
assert(late.length === 1, `observations.json: expected exactly one late arrival (>6h ingestion latency), got ${late.length}`);
// irregular intervals: a cadence-60 stream with at least 2 missing-but-undeclared hours
const qTimes = dstStream.map((o) => Date.parse(o.observedAt)).sort((a, b) => a - b);
let irregular = 0;
for (let i = 1; i < qTimes.length; i += 1) if (qTimes[i] - qTimes[i - 1] !== 3600000) irregular += 1;
assert(irregular >= 2, `observations.json: telemetry series must show irregular intervals (>=2 non-hourly steps), got ${irregular}`);

// D.8 revisions: raw originals + provisional/best-available versions; two corrections
assert(observations.every((o) => o.processingLevel === 'raw'), 'observations.json: originals must all be processing level raw (immutable)');
const revLevels = new Set(revisions.map((r) => r.processingLevel));
assert(revLevels.has('provisional'), 'revisions: must include a provisional version');
assert(revLevels.has('best-available'), 'revisions: must include a best-available version');
assert(revLevels.has('reviewed'), 'revisions: must include a reviewed version');
const corrections = revisions.filter((r) => r.type === 'correction');
assert(corrections.length === 2, `revisions: expected exactly 2 corrections, got ${corrections.length}`);
if (corrections.length === 2) {
  assert(corrections[0].reason !== corrections[1].reason, 'revisions: the two corrections must have different reasons');
  assert(!eq(corrections[0].qualifierIds, corrections[1].qualifierIds), 'revisions: the two corrections must carry distinct qualifiers');
  assert(corrections[0].targetObservationId !== corrections[1].targetObservationId, 'revisions: the two corrections must target different observations');
}
// one logical point with raw -> provisional -> best-available chain
const chained = revisions.filter((r) => r.baseRevisionId !== null && revisions.some((b) => b.id === r.baseRevisionId && b.targetObservationId === r.targetObservationId));
assert(chained.length >= 1, 'revisions: at least one observation must show a chained raw -> provisional -> best-available history');

// D.9 device replacement and two rating-curve periods (test-plan fixture requirements)
const replaced = streams.filter((d) => (d.deviceDeployments ?? []).length >= 2);
assert(replaced.length >= 1, 'stations.json: expected at least one device replacement (>=2 effective-dated deployments)');
for (const d of replaced) {
  const dep = [...d.deviceDeployments].sort((a, b) => Date.parse(a.installedAt) - Date.parse(b.installedAt));
  assert(dep[0].removedAt !== null && Date.parse(dep[0].removedAt) <= Date.parse(dep[1].installedAt), `datastream ${d.id}: earlier deployment must be closed before the replacement is installed`);
}
const rated = streams.filter((d) => (d.ratingCurvePeriods ?? []).length >= 2);
assert(rated.length >= 1, 'stations.json: expected at least one datastream with two rating-curve periods');
for (const d of rated) {
  const rc = [...d.ratingCurvePeriods].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
  assert(rc[0].validTo !== null && Date.parse(rc[0].validTo) <= Date.parse(rc[1].validFrom), `datastream ${d.id}: rating curve periods must not overlap`);
}

// D.10 seed-manifest counts match the actual fixture world
const counts = manifest?.counts ?? {};
const actualCounts = {
  systems: (systemsFx?.systems ?? []).length,
  subgroups: (systemsFx?.subgroups ?? []).length,
  organizations: orgs.length,
  users: users.length,
  entitlements: entitlements.length,
  stations: stations.length,
  datastreams: streams.length,
  observations: observations.length,
  revisions: revisions.length,
  gaps: gaps.length,
};
for (const [k, v] of Object.entries(actualCounts)) {
  assert(counts[k] === v, `seed-manifest counts.${k} (${counts[k]}) must match actual fixture count (${v})`);
}

// ------------------------------------------------------------- vocabulary
assert(eq([...propIds].sort(), ['discharge', 'stage', 'voltage']), 'vocabulary.json: observed properties must be discharge/stage/voltage');
assert(eq([...unitIds].sort(), ['V', 'cfs', 'ft']), 'vocabulary.json: units must be cfs, ft, V');
assert(eq([...qualifierIds].sort(), ['ice-affected', 'interpolate']), 'vocabulary.json: qualifiers must be ice-affected, interpolate');
assert(eq([...levelIds], ['raw', 'provisional', 'reviewed', 'best-available']), 'vocabulary.json: processing levels must be raw, provisional, reviewed, best-available');

// ---------------------------------------------------------------- OpenAPI
if (openapi) {
  assert(openapi.openapi === '3.1.0', 'openapi.json: must declare OpenAPI 3.1.0');
  assert(openapi.info?.version === '0.1.0', 'openapi.json: info.version must be 0.1.0');
  assert(Array.isArray(openapi.servers) && openapi.servers.some((s) => s.url === '/api/v1'), 'openapi.json: servers must include "/api/v1"');
  assert(openapi.components?.securitySchemes?.sessionCookie !== undefined, 'openapi.json: sessionCookie security scheme missing');
  assert(openapi.components?.securitySchemes?.scopedToken !== undefined, 'openapi.json: scopedToken security scheme missing');

  // the full route table from the technical specification
  const expected = [
    ['get', '/session', 'getSession'],
    ['get', '/catalog', 'getCatalog'],
    ['get', '/sites', 'listSites'],
    ['get', '/sites/{id}', 'getSite'],
    ['patch', '/sites/{id}', 'patchSite'],
    ['get', '/streams/{id}/observations', 'listStreamObservations'],
    ['post', '/streams/{id}/observations', 'createManualObservation'],
    ['get', '/observations/{key}/history', 'getObservationHistory'],
    ['post', '/observations/{key}/revisions', 'createRevision'],
    ['post', '/imports', 'createImport'],
    ['post', '/imports/{id}/validate', 'validateImport'],
    ['post', '/imports/{id}/commit', 'commitImport'],
    ['put', '/me/favorites/{siteId}', 'putFavorite'],
    ['put', '/me/notification-subscriptions/{id}', 'putNotificationSubscription'],
    ['post', '/exports', 'createExport'],
    ['get', '/exports/{id}', 'getExport'],
    ['post', '/me/api-tokens', 'issueApiToken'],
    ['delete', '/me/api-tokens/{id}', 'revokeApiToken'],
    ['post', '/sites/{id}/visits', 'createVisit'],
    ['get', '/admin/connections', 'listAdminConnections'],
    ['put', '/admin/assignments/{id}', 'putAssignment'],
    ['post', '/search/interpret', 'interpretSearch'],
  ];
  const ops = [];
  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[method]) ops.push([method, path, item[method]]);
    }
  }
  assert(ops.length === expected.length, `openapi.json: expected ${expected.length} operations, found ${ops.length}`);
  for (const [method, path, opId] of expected) {
    const found = ops.find(([m, p, o]) => m === method && p === path);
    assert(found !== undefined, `openapi.json: missing route ${method.toUpperCase()} ${path}`);
    if (found) assert(found[2].operationId === opId, `openapi.json: ${method.toUpperCase()} ${path} operationId must be ${opId}, found ${found[2].operationId}`);
  }
  const opIds = ops.map(([, , o]) => o.operationId);
  assert(new Set(opIds).size === opIds.length, 'openapi.json: operationIds must be unique');
  const errorStatuses = ['400', '401', '403', '404', '409', '412', '422', '429', '503'];
  for (const [method, path, op] of ops) {
    assert(typeof op.operationId === 'string' && op.operationId.length > 0, `openapi.json: ${method} ${path} needs an operationId`);
    assert(typeof op.summary === 'string' && op.summary.length > 0, `openapi.json: ${op.operationId} needs a one-line summary`);
    assert(Array.isArray(op.security), `openapi.json: ${op.operationId} must declare security (empty object {} = anonymous allowed)`);
    const schemeNames = new Set(Object.keys(openapi.components.securitySchemes ?? {}));
    for (const alts of op.security) {
      for (const scheme of Object.keys(alts)) {
        assert(schemeNames.has(scheme), `openapi.json: ${op.operationId} references unknown security scheme ${scheme}`);
      }
    }
    const responses = Object.entries(op.responses ?? {});
    const hasProblem = responses.some(([code, r]) => {
      if (!errorStatuses.includes(code)) return false;
      let node = r;
      if (node && typeof node === 'object' && '$ref' in node) {
        const resolved = resolveRef(openapi, node.$ref);
        node = resolved;
      }
      if (!node || typeof node !== 'object') return false;
      const schema = node.content?.['application/json']?.schema;
      if (!schema) return false;
      if ('$ref' in schema) {
        if (schema.$ref === '#/components/schemas/Problem') return true;
        const target = resolveRef(openapi, schema.$ref);
        return target === openapi.components?.schemas?.Problem;
      }
      return false;
    });
    assert(hasProblem, `openapi.json: ${op.operationId} must declare a typed error response using the Problem model`);
  }
  const headerNames = (op) =>
    (op.parameters ?? []).map((p) => (typeof p === 'object' && '$ref' in p ? null : `${p.in}:${p.name}:${p.required ? 'required' : 'optional'}`)).filter(Boolean);
  const revOp = openapi.paths?.['/observations/{key}/revisions']?.post;
  if (revOp) {
    const h = headerNames(revOp);
    assert(h.includes('header:If-Match:required'), 'openapi.json: POST /observations/{key}/revisions must require the If-Match header');
    assert(h.includes('header:Idempotency-Key:required'), 'openapi.json: POST /observations/{key}/revisions must require the Idempotency-Key header');
    const bodySchema = revOp.requestBody?.content?.['application/json']?.schema;
    assert(bodySchema?.$ref === '#/components/schemas/RevisionCreate', 'openapi.json: revisions request body must reference RevisionCreate');
  }
  const entryOp = openapi.paths?.['/streams/{id}/observations']?.post;
  if (entryOp) {
    assert(headerNames(entryOp).includes('header:Idempotency-Key:required'), 'openapi.json: POST /streams/{id}/observations must require the Idempotency-Key header');
  }
  const patchOp = openapi.paths?.['/sites/{id}']?.patch;
  if (patchOp) {
    assert(headerNames(patchOp).includes('header:If-Match:required'), 'openapi.json: PATCH /sites/{id} must require the If-Match header (version conflict check)');
  }
  for (const opId of ['listSites', 'listStreamObservations', 'getObservationHistory']) {
    const op = ops.find(([, , o]) => o.operationId === opId);
    if (!op) continue;
    const paramRefs = (op[2].parameters ?? []).map((p) => (typeof p === 'object' && '$ref' in p ? p.$ref : null)).filter(Boolean);
    assert(paramRefs.includes('#/components/parameters/CursorParam'), `openapi.json: ${opId} must support cursor pagination`);
    assert(paramRefs.includes('#/components/parameters/LimitParam'), `openapi.json: ${opId} must support a limit parameter`);
  }
  // every internal $ref resolves
  const missingRefs = [];
  (function walk(node, trail) {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        if (resolveRef(openapi, node.$ref) === undefined) missingRefs.push(`${trail}: unresolved $ref ${node.$ref}`);
      }
      for (const [k, v] of Object.entries(node)) if (k !== '$ref') walk(v, `${trail}.${k}`);
    }
  })(openapi, '$');
  assert(missingRefs.length === 0, `openapi.json: unresolved $refs:\n    ${missingRefs.join('\n    ')}`);
  // embedded schema copies are identical to schemas/*.json (properties + required)
  const embeddedPairs = [
    ['error.json', 'Problem'],
    ['filter-set.json', 'FilterSet'],
    ['site.json', 'Site'],
    ['observation.json', 'Observation'],
    ['revision.json', 'Revision'],
    ['catalog-layer.json', 'CatalogLayer'],
    ['entitlement.json', 'Entitlement'],
    ['async-job.json', 'AsyncJob'],
  ];
  for (const [file, name] of embeddedPairs) {
    const local = schemas[file];
    const emb = openapi.components?.schemas?.[name];
    if (!local || !emb) {
      assert(false, `openapi.json: embedded schema ${name} (mirroring ${file}) is missing`);
      continue;
    }
    assert(
      deepEqual(local.properties, emb.properties),
      `openapi.json: components.schemas.${name}.properties must be identical to schemas/${file} properties`
    );
    assert(
      eq(local.required ?? null, emb.required ?? null),
      `openapi.json: components.schemas.${name}.required must match schemas/${file}`
    );
  }
  // processing level enums agree with the governed vocabulary
  const levelEnum = [...levelIds];
  for (const name of ['Observation', 'Revision', 'FilterSet']) {
    const props = openapi.components?.schemas?.[name]?.properties ?? {};
    const holder = name === 'FilterSet' ? props.processingLevels : props.processingLevel;
    const enumVal = holder?.enum ?? holder?.items?.enum;
    assert(eq(enumVal, levelEnum), `openapi.json: ${name} processing level enum must equal the governed vocabulary [${levelEnum.join(', ')}]`);
  }
}

function resolveRef(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let node = doc;
  for (const seg of ref.slice(2).split('/')) {
    node = node?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
    if (node === undefined) return undefined;
  }
  return node;
}

// ------------------------------------------------------------------ hashes
const hashFiles = [
  'openapi.json',
  ...SCHEMA_NAMES.map((n) => `schemas/${n}`),
];
const mdHashes = new Map();
for (const line of contractsHashMd.split(/\r?\n/)) {
  const m = line.match(/^\s*[|`\s]*([A-Za-z0-9._/-]+\.json)[|`\s:]+([0-9a-f]{64})/);
  if (m) mdHashes.set(m[1].replace(/^schemas\//, 'schemas/'), m[2]);
}
assert(contractsHashMd.includes('v0.1.0'), 'CONTRACTS-HASH.md: must be labeled version v0.1.0');
assert(contractsHashMd.includes('2026-10-21'), 'CONTRACTS-HASH.md: must carry the publication date 2026-10-21');
assert(contractsHashMd.includes(AGREEMENT_SENTENCE), 'CONTRACTS-HASH.md: must contain the exact consumer-agreement sentence');
for (const rel of hashFiles) {
  const digest = createHash('sha256').update(readFileSync(join(PKG, rel), 'utf8'), 'utf8').digest('hex');
  const key = rel === 'openapi.json' ? 'openapi.json' : rel;
  const published = mdHashes.get(key) ?? mdHashes.get(key.replace('schemas/', ''));
  assert(published !== undefined, `CONTRACTS-HASH.md: missing sha256 entry for ${key}`);
  if (published !== undefined) {
    assert(published === digest, `CONTRACTS-HASH.md: sha256 mismatch for ${key}: published ${published}, actual ${digest}`);
  }
}

// ------------------------------------------------------------------- verdict
if (failures.length > 0) {
  console.error(`FAIL @utah-water/contracts: ${failures.length} problem(s) after ${asserted} assertions`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
const opCount = Object.values(openapi?.paths ?? {}).reduce(
  (n, p) => n + ['get', 'post', 'put', 'patch', 'delete'].filter((m) => p[m]).length,
  0
);
console.log(
  `OK @utah-water/contracts v0.1.0: ${opCount} operations, ` +
    `${SCHEMA_NAMES.length} schemas, 6 fixtures, ${observations.length} observations, ${revisions.length} revisions, ` +
    `${asserted} assertions passed, ${hashFiles.length} sha256 contract hashes verified (seed utah-water-fixture-v1)`
);
