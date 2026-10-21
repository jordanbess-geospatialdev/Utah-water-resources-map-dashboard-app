#!/usr/bin/env node
// database/load-fixtures.mjs
// Zero-dependency deterministic fixture loader (Node built-ins only).
//
// Reads the WD-002 contract fixtures from ../../fixtures/contracts/*.json and
// emits idempotent INSERT statements to stdout for seeding a DISPOSABLE
// database (migrations first, then pipe this output into psql):
//
//   node database/load-fixtures.mjs | psql "<disposable-db>" -v ON_ERROR_STOP=1 -f -
//
// Determinism contract:
//   * Row order: fixture ids/keys in ascending code-point order; tables in
//     foreign-key dependency order.
//   * Column order: fixed explicit lists below (never SELECT *).
//   * Idempotency: every statement ends in ON CONFLICT DO NOTHING.
//   * Primary keys are UUIDv5 values derived from a fixed namespace and the
//     fixture key ("station:sta-bear-corinne", ...), so re-running against the
//     same fixture set converges instead of duplicating.
//   * source_payload_hash is sha256 over the canonical JSON of the fixture
//     record (recursively key-sorted, no whitespace).
//
// Field-mapping decisions worth knowing:
//   * Geometry: fixtures state latitude then longitude; PostGIS stores
//     (longitude, latitude). The loader passes (longitude, latitude) to
//     ST_MakePoint - an axis swap here displaces Utah points by ~70 degrees.
//   * The restricted internal block (gate code, wiring notes) is loaded into
//     water.station_internal_detail, never into station or any view.
//   * rating_curve.approval_state is seeded 'approved': the fixture world
//     treats historical effective curves as approved; version numbers are the
//     per-stream ordering of validFrom.
//   * revision_version is the per-observation ordering of (recordedAt, id) and
//     is cross-checked against the base-revision chain.
//   * Fixture "note"/"description" prose about the fixture world itself is
//     commentary, not domain data; only observation/gap notes and
//     vocabulary/system descriptions are loaded.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Contract fixtures live at the repository root: <root>/fixtures/contracts
// (one level above database/, i.e. ../../fixtures/contracts only when invoked
// from inside database/qualification-style subpaths).
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'contracts');

// Fixed UUIDv5 namespace for the fixture world. Any fixed value works; changing
// it re-keys every derived identifier. Documented in database/README.md.
const NAMESPACE_UUID = '9d1c0a44-6f7b-4a9e-8b2d-3c5f0e7a1b68';

function uuidV5(name) {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE_UUID.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(String(name), 'utf8'))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = hash.toString('hex', 0, 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const idOf = (type, key) => uuidV5(`${type}:${key}`);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (msg) => {
  console.error(`load-fixtures: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// SQL literal formatting
// ---------------------------------------------------------------------------
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqlNumber = (n) => (Number.isFinite(n) ? String(n) : fail(`non-finite number ${n}`));
const raw = (sql) => ({ __raw: sql });

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v && typeof v === 'object' && v.__raw !== undefined) return v.__raw;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return sqlNumber(v);
  if (typeof v === 'string') return sqlString(v);
  if (typeof v === 'object') return sqlString(canonicalJson(v)); // jsonb
  return fail(`unformattable value ${JSON.stringify(v)}`);
}

function textArray(values) {
  return raw(`ARRAY[${values.map(sqlString).join(',')}]`);
}

const inserts = [];
const emitted = new Map();

function emit(table, columns, rows) {
  for (const row of rows) {
    const values = columns.map((c) => sqlValue(row[c])).join(', ');
    inserts.push(`INSERT INTO water.${table} (${columns.join(', ')}) VALUES (${values}) ON CONFLICT DO NOTHING;`);
  }
  emitted.set(table, (emitted.get(table) ?? 0) + rows.length);
}

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------
const readJson = (name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
const systemsFx = readJson('systems.json');
const stationsFx = readJson('stations.json');
const observationsFx = readJson('observations.json');
const vocabularyFx = readJson('vocabulary.json');
const principalsFx = readJson('principals.json');
const manifestFx = readJson('seed-manifest.json');

// Independent anchor: the seed manifest counts are owned by WD-002; refuse to
// load anything that disagrees with them.
{
  const actual = {
    systems: systemsFx.systems.length,
    subgroups: systemsFx.subgroups.length,
    organizations: principalsFx.organizations.length,
    users: principalsFx.users.length,
    entitlements: principalsFx.entitlements.length,
    stations: stationsFx.stations.length,
    datastreams: stationsFx.stations.reduce((n, s) => n + s.datastreams.length, 0),
    observations: observationsFx.observations.length,
    revisions: observationsFx.revisions.length,
    gaps: observationsFx.gaps.length,
  };
  for (const [k, expected] of Object.entries(manifestFx.counts)) {
    if (actual[k] !== expected) {
      fail(`fixture count mismatch for "${k}": manifest says ${expected}, files say ${actual[k]}`);
    }
  }
  if (manifestFx.seed !== systemsFx.seed || manifestFx.seed !== stationsFx.seed) {
    fail('seed differs across fixture files');
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
const PROCESSING_LEVEL_RANK = { raw: 1, provisional: 2, reviewed: 3, 'best-available': 4 };

emit('vocab_unit', ['unit_id', 'name', 'dimension', 'description'],
  [...vocabularyFx.units].sort((a, b) => byKey(a.id, b.id)));

emit('vocab_observed_property', ['observed_property_id', 'name', 'dimension', 'canonical_unit_id', 'description'],
  [...vocabularyFx.observedProperties].sort((a, b) => byKey(a.id, b.id)));

emit('vocab_qualifier', ['qualifier_id', 'name', 'description'],
  [...vocabularyFx.qualifiers].sort((a, b) => byKey(a.id, b.id)));

emit('vocab_processing_level', ['processing_level_id', 'name', 'description', 'rank'],
  [...vocabularyFx.processingLevels]
    .sort((a, b) => byKey(a.id, b.id))
    .map((l) => ({ ...l, rank: PROCESSING_LEVEL_RANK[l.id] ?? fail(`unknown processing level ${l.id}`) })));

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------
emit('organization', ['organization_id', 'organization_key', 'name', 'kind'],
  [...principalsFx.organizations]
    .sort((a, b) => byKey(a.id, b.id))
    .map((o) => ({ organization_id: idOf('organization', o.id), organization_key: o.id, name: o.name, kind: o.kind })));

emit('principal', ['principal_id', 'principal_key', 'display_name', 'account_kind', 'active'],
  [...principalsFx.users]
    .sort((a, b) => byKey(a.id, b.id))
    .map((u) => ({ principal_id: idOf('principal', u.id), principal_key: u.id, display_name: u.displayName, account_kind: 'user', active: Boolean(u.active) })));

// ---------------------------------------------------------------------------
// Distribution systems (+ subgroups), providers
// ---------------------------------------------------------------------------
const systemNodes = [
  ...systemsFx.systems.map((s) => ({ ...s, kind: 'system', parent: null })),
  ...systemsFx.subgroups.map((g) => ({ ...g, kind: 'subgroup', parent: g.systemId })),
];
const systemIdByKey = new Map(systemNodes.map((n) => [n.id, idOf('system', n.id)]));

emit('distribution_system',
  ['system_id', 'system_key', 'kind', 'parent_system_id', 'name', 'state_codes', 'description'],
  [...systemNodes]
    .sort((a, b) => byKey(a.id, b.id))
    .map((n) => ({
      system_id: systemIdByKey.get(n.id),
      system_key: n.id,
      kind: n.kind,
      parent_system_id: n.parent ? systemIdByKey.get(n.parent) : null,
      name: n.name,
      state_codes: textArray(n.stateCodes ?? []),
      description: n.description ?? null,
    })));

emit('provider', ['provider_id', 'provider_key', 'name', 'kind'],
  [...systemsFx.providers]
    .sort((a, b) => byKey(a.id, b.id))
    .map((p) => ({ provider_id: idOf('provider', p.id), provider_key: p.id, name: p.name, kind: p.kind })));

// ---------------------------------------------------------------------------
// Stations, external IDs, internal block, memberships
// ---------------------------------------------------------------------------
const stationIdByKey = new Map(stationsFx.stations.map((s) => [s.id, idOf('station', s.id)]));

emit('station',
  ['station_id', 'station_key', 'display_name', 'system_id', 'provider_id', 'site_type_id',
   'water_source_type_id', 'status', 'visibility', 'telemetry', 'state_code', 'geom',
   'elevation_ft', 'owner_organization_id', 'version'],
  [...stationsFx.stations]
    .sort((a, b) => byKey(a.id, b.id))
    .map((s) => ({
      station_id: stationIdByKey.get(s.id),
      station_key: s.id,
      display_name: s.displayName,
      system_id: systemIdByKey.get(s.systemId),
      provider_id: idOf('provider', s.providerId),
      site_type_id: s.siteTypeId,
      water_source_type_id: s.waterSourceTypeId ?? null,
      status: s.status,
      visibility: s.visibility,
      telemetry: s.telemetry,
      state_code: s.stateCode,
      // Fixtures are (latitude, longitude); PostGIS geometry is (longitude, latitude).
      geom: raw(`public.ST_SetSRID(public.ST_MakePoint(${sqlNumber(s.longitude)}, ${sqlNumber(s.latitude)}), 4326)`),
      elevation_ft: s.elevationFt ?? null,
      owner_organization_id: s.ownerOrganizationId ? idOf('organization', s.ownerOrganizationId) : null,
      version: s.version,
    })));

emit('station_external_id', ['station_external_id', 'station_id', 'provider_id', 'external_id'],
  [...stationsFx.stations]
    .filter((s) => s.externalId !== undefined)
    .sort((a, b) => byKey(a.id, b.id))
    .map((s) => ({
      station_external_id: idOf('station-external', `${s.providerId}:${s.externalId}`),
      station_id: stationIdByKey.get(s.id),
      provider_id: idOf('provider', s.providerId),
      external_id: s.externalId,
    })));

emit('station_internal_detail', ['station_id', 'gate_code', 'wiring_notes', 'visibility'],
  [...stationsFx.stations]
    .filter((s) => s.internal)
    .sort((a, b) => byKey(a.id, b.id))
    .map((s) => ({
      station_id: stationIdByKey.get(s.id),
      gate_code: s.internal.gateCode,
      wiring_notes: s.internal.wiringNotes ?? null,
      visibility: 'internal',
    })));

const membershipRows = [];
for (const s of stationsFx.stations) {
  for (const g of s.subgroupIds ?? []) membershipRows.push({ station: s.id, group: g });
}
emit('station_group_membership',
  ['station_group_membership_id', 'station_id', 'group_id', 'effective_from', 'effective_to'],
  membershipRows
    .sort((a, b) => byKey(a.station, b.station) || byKey(a.group, b.group))
    .map((m) => ({
      station_group_membership_id: idOf('membership', `${m.station}:${m.group}`),
      station_id: stationIdByKey.get(m.station),
      group_id: systemIdByKey.get(m.group),
      effective_from: null, // v0.1.0 fixtures carry the current snapshot only
      effective_to: null,
    })));

// ---------------------------------------------------------------------------
// Datastreams, device deployments, rating curves
// ---------------------------------------------------------------------------
const streams = stationsFx.stations.flatMap((s) => s.datastreams.map((d) => ({ ...d, station: s.id })));
const streamIdByKey = new Map(streams.map((d) => [d.id, idOf('datastream', d.id)]));

emit('datastream',
  ['datastream_id', 'datastream_key', 'station_id', 'observed_property_id', 'unit_id', 'method_type_id',
   'time_zone', 'cadence_minutes', 'valid_range_min', 'valid_range_max', 'visibility'],
  [...streams]
    .sort((a, b) => byKey(a.id, b.id))
    .map((d) => ({
      datastream_id: streamIdByKey.get(d.id),
      datastream_key: d.id,
      station_id: stationIdByKey.get(d.station),
      observed_property_id: d.observedPropertyId,
      unit_id: d.unitId,
      method_type_id: d.methodTypeId ?? null,
      time_zone: d.timeZone,
      cadence_minutes: d.cadenceMinutes,
      valid_range_min: d.validRangeMin ?? null,
      valid_range_max: d.validRangeMax ?? null,
      visibility: d.visibility,
    })));

const deploymentRows = streams.flatMap((d) =>
  (d.deviceDeployments ?? []).map((dep) => ({ ...dep, stream: d.id, station: d.station }))
);
emit('device_deployment',
  ['device_deployment_id', 'device_key', 'serial', 'model', 'station_id', 'datastream_id', 'installed_at', 'removed_at'],
  deploymentRows
    .sort((a, b) => byKey(a.deviceId, b.deviceId) || byKey(a.installedAt, b.installedAt))
    .map((dep) => ({
      device_deployment_id: idOf('deployment', `${dep.stream}:${dep.deviceId}:${dep.installedAt}`),
      device_key: dep.deviceId,
      serial: dep.serial ?? null,
      model: dep.model ?? null,
      station_id: stationIdByKey.get(dep.station),
      datastream_id: streamIdByKey.get(dep.stream),
      installed_at: dep.installedAt,
      removed_at: dep.removedAt ?? null,
    })));

const ratingRows = [];
for (const d of streams) {
  const ordered = [...(d.ratingCurvePeriods ?? [])].sort((a, b) => byKey(a.validFrom, b.validFrom));
  ordered.forEach((rc, i) => ratingRows.push({ ...rc, stream: d.id, unit: d.unitId, version: i + 1 }));
}
emit('rating_curve',
  ['rating_curve_id', 'rating_curve_key', 'datastream_id', 'device_deployment_id', 'version', 'method',
   'coefficients', 'unit_id', 'valid_from', 'valid_to', 'approval_state'],
  ratingRows
    .sort((a, b) => byKey(a.id, b.id))
    .map((rc) => ({
      rating_curve_id: idOf('rating-curve', rc.id),
      rating_curve_key: rc.id,
      datastream_id: streamIdByKey.get(rc.stream),
      device_deployment_id: null,
      version: rc.version,
      method: rc.method,
      coefficients: null,
      unit_id: rc.unit,
      valid_from: rc.validFrom,
      valid_to: rc.validTo ?? null,
      approval_state: 'approved', // fixture world: historical effective curves are approved
    })));

// ---------------------------------------------------------------------------
// Original observations (immutable, partitioned)
// ---------------------------------------------------------------------------
const observationRows = observationsFx.observations.map((o) => {
  if (o.processingLevel !== 'raw') fail(`original ${o.id} must enter at processing level raw, got ${o.processingLevel}`);
  return {
    observation_id: idOf('observation', o.id),
    stream_id: streamIdByKey.get(o.streamId) ?? fail(`observation ${o.id} references unknown stream ${o.streamId}`),
    observed_time: o.observedAt,
    source_event_id: o.sourceEventId,
    source_value: o.value ?? null,
    source_unit_id: o.unitId,
    value_type: o.valueType,
    processing_level: o.processingLevel,
    method_type_id: o.methodTypeId ?? null,
    source_id: o.sourceId,
    source_offset: o.sourceOffset,
    received_at: o.receivedAt,
    note: o.note ?? null,
    source_payload_hash: sha256Hex(canonicalJson(o)),
  };
});
emit('observation_original',
  ['observation_id', 'stream_id', 'observed_time', 'source_event_id', 'source_value', 'source_unit_id',
   'value_type', 'processing_level', 'method_type_id', 'source_id', 'source_offset', 'received_at',
   'note', 'source_payload_hash'],
  observationRows.sort((a, b) => byKey(a.observation_id, b.observation_id)));

// ---------------------------------------------------------------------------
// Revisions (append-only; optimistic per-observation version)
// ---------------------------------------------------------------------------
const observationById = new Map(observationsFx.observations.map((o) => [o.id, o]));
const perObservation = new Map();
for (const r of observationsFx.revisions) {
  if (!perObservation.has(r.targetObservationId)) perObservation.set(r.targetObservationId, []);
  perObservation.get(r.targetObservationId).push(r);
}
const revisionVersionById = new Map();
for (const [obsId, group] of perObservation) {
  [...group]
    .sort((a, b) => byKey(a.recordedAt, b.recordedAt) || byKey(a.id, b.id))
    .forEach((r, i) => revisionVersionById.set(r.id, i + 1));
}

const revisionRows = observationsFx.revisions.map((r) => {
  const target = observationById.get(r.targetObservationId) ?? fail(`revision ${r.id} targets unknown observation ${r.targetObservationId}`);
  const version = revisionVersionById.get(r.id);
  if (r.baseRevisionId !== null && r.baseRevisionId !== undefined) {
    const baseVersion = revisionVersionById.get(r.baseRevisionId);
    if (baseVersion !== version - 1) {
      fail(`revision ${r.id} (v${version}) builds on ${r.baseRevisionId} (v${baseVersion}); base chain must be the immediate predecessor`);
    }
  }
  return {
    revision_id: idOf('revision', r.id),
    revision_key: r.id,
    observation_id: idOf('observation', r.targetObservationId),
    observed_time: target.observedAt,
    base_revision_id: r.baseRevisionId ? idOf('revision', r.baseRevisionId) : null,
    revision_type: r.type,
    value: r.value ?? null,
    unit_id: r.unitId ?? null,
    excluded: r.type === 'exclusion',
    processing_level: r.processingLevel,
    reason: r.reason,
    actor_principal_id: idOf('principal', r.actorId),
    recorded_at: r.recordedAt,
    revision_version: version,
    idempotency_key: r.idempotencyKey ?? null,
  };
});
emit('observation_revision',
  ['revision_id', 'revision_key', 'observation_id', 'observed_time', 'base_revision_id', 'revision_type',
   'value', 'unit_id', 'excluded', 'processing_level', 'reason', 'actor_principal_id', 'recorded_at',
   'revision_version', 'idempotency_key'],
  revisionRows.sort((a, b) => byKey(a.revision_key, b.revision_key)));

emit('revision_qualifier', ['revision_id', 'qualifier_id'],
  observationsFx.revisions
    .flatMap((r) => [...(r.qualifierIds ?? [])].sort(byKey).map((q) => ({ revision: r.id, qualifier: q })))
    .sort((a, b) => byKey(a.revision, b.revision) || byKey(a.qualifier, b.qualifier))
    .map((rq) => ({ revision_id: idOf('revision', rq.revision), qualifier_id: rq.qualifier })));

// ---------------------------------------------------------------------------
// Declared gaps
// ---------------------------------------------------------------------------
emit('declared_gap',
  ['gap_id', 'gap_key', 'stream_id', 'start_time', 'end_time', 'reason', 'declared_at',
   'expected_cadence_minutes', 'missing_count', 'note'],
  [...observationsFx.gaps]
    .sort((a, b) => byKey(a.id, b.id))
    .map((g) => ({
      gap_id: idOf('gap', g.id),
      gap_key: g.id,
      stream_id: streamIdByKey.get(g.streamId) ?? fail(`gap ${g.id} references unknown stream ${g.streamId}`),
      start_time: g.start,
      end_time: g.end,
      reason: g.reason,
      declared_at: g.declaredAt,
      expected_cadence_minutes: g.expectedCadenceMinutes,
      missing_count: g.missingCount,
      note: g.note ?? null,
    })));

// ---------------------------------------------------------------------------
// Assignments (entitlements)
// ---------------------------------------------------------------------------
const assignmentIdByKey = new Map(principalsFx.entitlements.map((e) => [e.id, idOf('assignment', e.id)]));
const principalKeys = new Set(principalsFx.users.map((u) => u.id));
const orgKeys = new Set(principalsFx.organizations.map((o) => o.id));

emit('assignment',
  ['assignment_id', 'assignment_key', 'principal_id', 'role', 'scope_type', 'scope_system_id',
   'scope_organization_id', 'scope_station_id', 'scope_dataset_id', 'effective_at', 'expires_at',
   'status', 'delegation', 'granted_by_principal_id', 'grant_version'],
  [...principalsFx.entitlements]
    .sort((a, b) => byKey(a.id, b.id))
    .map((e) => {
      if (!principalKeys.has(e.principalId) || !principalKeys.has(e.grantedBy)) {
        fail(`assignment ${e.id} references an unknown principal`);
      }
      return {
        assignment_id: assignmentIdByKey.get(e.id),
        assignment_key: e.id,
        principal_id: idOf('principal', e.principalId),
        role: e.role,
        scope_type: e.scopeType,
        scope_system_id: e.scopeType === 'system' ? (systemIdByKey.get(e.scopeId) ?? fail(`assignment ${e.id} references unknown system ${e.scopeId}`)) : null,
        scope_organization_id: e.scopeType === 'organization' ? (orgKeys.has(e.scopeId) ? idOf('organization', e.scopeId) : fail(`assignment ${e.id} references unknown organization ${e.scopeId}`)) : null,
        scope_station_id: e.scopeType === 'site' ? (stationIdByKey.get(e.scopeId) ?? fail(`assignment ${e.id} references unknown station ${e.scopeId}`)) : null,
        scope_dataset_id: e.scopeType === 'dataset' ? e.scopeId : null,
        effective_at: e.effectiveAt,
        expires_at: e.expiresAt ?? null,
        status: e.status,
        delegation: e.delegation ?? null,
        granted_by_principal_id: idOf('principal', e.grantedBy),
        grant_version: e.grantVersion,
      };
    }));

emit('assignment_capability', ['assignment_id', 'capability'],
  principalsFx.entitlements
    .flatMap((e) => [...(e.capabilities ?? [])].sort(byKey).map((c) => ({ assignment: e.id, capability: c })))
    .sort((a, b) => byKey(a.assignment, b.assignment) || byKey(a.capability, b.capability))
    .map((ac) => ({ assignment_id: assignmentIdByKey.get(ac.assignment), capability: ac.capability })));

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const out = process.stdout;
out.write(`-- Generated by database/load-fixtures.mjs - DO NOT EDIT.\n`);
out.write(`-- Seed: ${manifestFx.seed} | contract_version: ${manifestFx.contract_version} | fixed_clock: ${manifestFx.fixed_clock} | time_zone: ${manifestFx.time_zone}\n`);
out.write(`-- Deterministic: FK-ordered tables, code-point-sorted rows, explicit columns, ON CONFLICT DO NOTHING.\n`);
out.write(`-- Seed a DISPOSABLE database only (migrations first). No live database is accessed by this script.\n`);
out.write('BEGIN;\n');
for (const line of inserts) out.write(`${line}\n`);
out.write('COMMIT;\n');
out.write(`-- Emitted ${inserts.length} INSERT statements across ${emitted.size} tables.\n`);
for (const [table, count] of [...emitted].sort((a, b) => byKey(a[0], b[0]))) {
  out.write(`--   water.${table}: ${count}\n`);
}
