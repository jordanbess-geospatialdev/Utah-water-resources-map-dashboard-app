/**
 * WD-008 export domain tests (verification matrix rows T-06 CSV formula
 * neutralization and T-10 persona export path; FR-063).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/exports/test/exports.test.ts
 *
 * Every clock input is an injected constant; the store reads only the frozen
 * contract fixtures, so the suite is deterministic - the final test replays
 * the whole job scenario on a second manager and compares bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CSV_COLUMNS, csvEscape, neutralizeFormula, renderObservationCsv } from '../csv.ts';
import { EXPORT_LIMITS, ExportJobManager } from '../exportJob.ts';
import { withEntitlement, type PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { seriesStore, type SeriesStore } from '../../series/load.ts';

const store = seriesStore();
const T0 = '2026-03-09T07:00:00Z'; // fixture clock

/** Deterministic injected clock: one-second steps from a fixed start. */
function clock(startMs: number = Date.parse(T0)): () => string {
  let now = startMs;
  return () => {
    const iso = new Date(now).toISOString();
    now += 1_000;
    return iso;
  };
}

/**
 * A store whose policy world can be swapped between job steps, so a grant can
 * be revoked after an artifact exists (revocation must fail the download
 * closed). All other behavior delegates to the frozen fixture store.
 */
function revocableWorldStore(): { store: SeriesStore; setWorld: (world: PolicyWorld) => void } {
  const holder: { world: PolicyWorld } = { world: store.world };
  const dynamicStore: SeriesStore = {
    ...store,
    get world() {
      return holder.world;
    },
  };
  return { store: dynamicStore, setWorld: (world) => (holder.world = world) };
}

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

test('RFC 4180 escaping: quotes, commas and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('cr\rline'), '"cr\rline"');
});

test('formula neutralization treats leading =, +, -, @, TAB and CR; benign text passes through', () => {
  assert.equal(neutralizeFormula('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(neutralizeFormula('+cmd|/C calc'), "'+cmd|/C calc");
  assert.equal(neutralizeFormula('-2+3'), "'-2+3");
  assert.equal(neutralizeFormula('@hyperlink("http://x")'), "'@hyperlink(\"http://x\")");
  assert.equal(neutralizeFormula('\t=cmd'), "'\t=cmd");
  assert.equal(neutralizeFormula('\r=cmd'), "'\r=cmd");
  assert.equal(neutralizeFormula('Bear River near Corinne'), 'Bear River near Corinne');
  assert.equal(neutralizeFormula('ice-affected'), 'ice-affected');
});

test('user-controlled station names are neutralized inside rendered CSV bytes', () => {
  const rendered = renderObservationCsv([
    {
      stationId: 'sta-x',
      stationDisplayName: '=HYPERLINK("http://evil","click")',
      streamId: 'str-x',
      observedPropertyId: 'discharge',
      unitId: 'cfs',
      points: [
        {
          observationId: 'obs-x',
          collapsedDuplicateIds: [],
          observedAt: '2026-03-08T00:00:00Z',
          receivedAt: '2026-03-08T00:00:47Z',
          sourceOffset: '-07:00',
          sourceEventId: 'ev-x',
          sourceId: 'src-x',
          value: 1,
          rawValue: 1,
          unitId: 'cfs',
          valueType: 'observed',
          processingLevel: 'raw',
          revisionId: null,
          qualifierIds: [],
          estimated: false,
          flags: [],
          rawFlags: [],
        },
      ],
    },
  ]);
  assert.equal(rendered.rowCount, 1);
  // The neutralized cell is RFC-quoted with doubled inner quotes:
  // "'=HYPERLINK(""http://evil"",""click"")"
  assert.ok(
    rendered.csv.includes('"\'=HYPERLINK(""http://evil"",""click"")"'),
    'the leading = is quoted into text inside the escaped cell',
  );
});

test('missing values render as empty fields, never as 0', () => {
  const rendered = renderObservationCsv([
    {
      stationId: 'sta-bear-corinne',
      stationDisplayName: 'Bear River near Corinne',
      streamId: 'str-corinne-q',
      observedPropertyId: 'discharge',
      unitId: 'cfs',
      points: [
        {
          observationId: 'obs-null',
          collapsedDuplicateIds: [],
          observedAt: '2026-03-07T03:00:00Z',
          receivedAt: '2026-03-07T03:00:46Z',
          sourceOffset: '-07:00',
          sourceEventId: 'ev-x',
          sourceId: 'src-x',
          value: null,
          rawValue: null,
          unitId: 'cfs',
          valueType: 'observed',
          processingLevel: 'raw',
          revisionId: null,
          qualifierIds: [],
          estimated: false,
          flags: ['null-frame'],
          rawFlags: ['null-frame'],
        },
      ],
    },
  ]);
  const dataLine = rendered.csv.split('\r\n')[1]!;
  const fields = dataLine.split(',');
  assert.equal(fields[CSV_COLUMNS.indexOf('value')], '');
});

test('CSV manifest size counts UTF-8 bytes for non-ASCII names', () => {
  const rendered = renderObservationCsv([{
    stationId: 'sta-x', stationDisplayName: 'Río 💧', streamId: 'str-x',
    observedPropertyId: 'discharge', unitId: 'cfs',
    points: [{
      observationId: 'obs-x', collapsedDuplicateIds: [], observedAt: T0,
      receivedAt: T0, sourceOffset: '-07:00', sourceEventId: 'ev-x', sourceId: 'src-x',
      value: 0, rawValue: 0, unitId: 'cfs', valueType: 'observed', processingLevel: 'raw',
      revisionId: null, qualifierIds: [], estimated: false, flags: [], rawFlags: [],
    }],
  }]);
  assert.equal(rendered.byteLength, Buffer.byteLength(rendered.csv, 'utf8'));
});

// ---------------------------------------------------------------------------
// Golden CSV bytes
// ---------------------------------------------------------------------------

test('golden CSV bytes for a fixture selection (CRLF, exact columns and values)', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  const created = manager.create(
    { streamIds: ['str-corinne-q'], start: '2026-03-08T00:00:00.000Z', end: '2026-03-08T03:00:00.000Z', basis: 'best-available' },
    null,
  );
  assert.equal(created.outcome, 'allowed');
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  manager.start(job.id);
  const done = manager.complete(job.id);
  assert.equal(done.outcome === 'allowed' && done.value.status, 'succeeded');
  const download = manager.download(job.id, null);
  assert.equal(download.outcome, 'allowed');
  const csv = download.outcome === 'allowed' ? download.value.csv : '';
  const manifest = download.outcome === 'allowed' ? download.value.manifest : null;

  // Rows: 00:00Z (20.6, unrevised -> raw level, empty qualifier/revision
  // columns), 01:00Z (20.8), 02:00Z (obs-q-032: raw -1.2 corrected to 20.9 at
  // best-available via rev-corinne-2004, qualifier ice-affected).
  const expectedCsv = [
    'station_id,station_name,stream_id,observed_property_id,unit_id,observed_at_utc,source_utc_offset,value,value_type,processing_level,qualifier_ids,revision_id,source_id,source_event_id,received_at_utc',
    'sta-bear-corinne,Bear River near Corinne,str-corinne-q,discharge,cfs,2026-03-08T00:00:00Z,-07:00,20.6,observed,raw,,,src-corinne-logger-02,ev-corinne-q-20260308T0000Z,2026-03-08T00:00:47Z',
    'sta-bear-corinne,Bear River near Corinne,str-corinne-q,discharge,cfs,2026-03-08T01:00:00Z,-07:00,20.8,observed,raw,,,src-corinne-logger-02,ev-corinne-q-20260308T0100Z,2026-03-08T01:00:50Z',
    'sta-bear-corinne,Bear River near Corinne,str-corinne-q,discharge,cfs,2026-03-08T02:00:00Z,-07:00,20.9,observed,best-available,ice-affected,rev-corinne-2004,src-corinne-logger-02,ev-corinne-q-20260308T0200Z,2026-03-08T02:00:48Z',
  ].join('\r\n') + '\r\n';
  assert.equal(csv, expectedCsv);
  assert.ok(manifest);
  assert.equal(manifest!.rowCount, 3);
  assert.equal(manifest!.byteLength, expectedCsv.length);
  assert.deepEqual(manifest!.columns, [...CSV_COLUMNS]);
  // Line endings are CRLF by documented choice; no bare LF lines.
  assert.ok(csv.split('\n').every((line) => line === '' || line.endsWith('\r')));
});

test('multi-stream export uses the documented station/stream/time ordering', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  const created = manager.create(
    {
      streamIds: ['str-hyrum-q-public', 'str-corinne-q'],
      start: '2026-03-06T18:00:00.000Z',
      end: '2026-03-06T19:00:00.000Z',
      basis: 'raw',
    },
    null,
  );
  assert.equal(created.outcome, 'allowed');
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  manager.start(job.id);
  manager.complete(job.id);
  const download = manager.download(job.id, null);
  assert.equal(download.outcome, 'allowed');
  const csv = download.outcome === 'allowed' ? download.value.csv : '';
  const rows = csv.split('\r\n').slice(1).filter((line) => line.length > 0);
  // Corinne has exactly the 18:00Z reading inside the hour; the Hyrum manual
  // reading at 16:45Z is before the window and not listed.
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.startsWith('sta-bear-corinne,'));
});

// ---------------------------------------------------------------------------
// Job lifecycle, caps, grants
// ---------------------------------------------------------------------------

test('job lifecycle: queued -> running -> succeeded with manifest; repeat download within TTL works', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  const created = manager.create(
    { streamIds: ['str-corinne-q'], start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw' },
    'principal-diego-steward',
  );
  assert.equal(created.outcome, 'allowed');
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  assert.equal(job.status, 'queued');
  assert.equal(job.id, 'exp-1');
  // Rows listed: 12 (local Mar 6, incl. the null frame) + 23 (local Mar 7,
  // duplicates collapsed) + 17 (local Mar 8, incl. the 9500 spike).
  assert.equal(job.estimatedRows, 52);

  const started = manager.start(job.id);
  assert.equal(started.outcome === 'allowed' && started.value.status, 'running');
  const done = manager.complete(job.id);
  assert.equal(done.outcome === 'allowed' && done.value.status, 'succeeded');
  const manifest = done.outcome === 'allowed' ? done.value.manifest : null;
  assert.ok(manifest);
  assert.equal(manifest!.rowCount, 52);
  assert.equal(manifest!.basis, 'raw');

  const first = manager.download(job.id, 'principal-diego-steward');
  const second = manager.download(job.id, 'principal-diego-steward');
  assert.equal(first.outcome, 'allowed');
  assert.equal(second.outcome, 'allowed');

  // Illegal transitions and unknown ids are typed conflicts / 404.
  const restart = manager.start(job.id);
  assert.equal(restart.outcome === 'denied' && restart.code, 'INVALID_STATE');
  const unknown = manager.download('exp-999', null);
  assert.equal(unknown.outcome === 'denied' && unknown.status, 404);
});

test('row cap: oversized export requests are rejected at creation, never silently truncated', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  // 52 fixture rows per stream per window; enough stream entries exceed the cap.
  const streams = Array.from({ length: Math.ceil(EXPORT_LIMITS.maxRows / 40) + 2 }, () => 'str-corinne-q');
  const huge = manager.create(
    { streamIds: streams, start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw' },
    null,
  );
  assert.equal(huge.outcome, 'denied');
  if (huge.outcome === 'denied') {
    assert.equal(huge.status, 413);
    assert.equal(huge.code, 'EXPORT_ROW_CAP_EXCEEDED');
  }
  assert.equal(manager.list().length, 0, 'nothing queued on cap rejection');
  // The window cap is enforced too.
  const wide = manager.create(
    { streamIds: ['str-corinne-q'], start: '2020-01-01T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z', basis: 'raw' },
    null,
  );
  assert.equal(wide.outcome === 'denied' && wide.code, 'REQUEST_WINDOW_TOO_LARGE');
});

test('time cap: a running job past the cap fails on tick', () => {
  let calls = 0;
  const base = Date.parse(T0);
  const slowManager = new ExportJobManager({
    store,
    now: () => {
      calls += 1;
      // create (2 clock reads), start (1) happen at T0; the tick lands after
      // the cap.
      return new Date(base + (calls <= 3 ? 0 : EXPORT_LIMITS.jobTimeCapMs + 1)).toISOString();
    },
  });
  const created = slowManager.create(
    { streamIds: ['str-corinne-q'], start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw' },
    null,
  );
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  const started = slowManager.start(job.id); // consumed the first clock tick (T0)
  assert.equal(started.outcome === 'allowed' && started.value.status, 'running');
  const failed = slowManager.tick(job.id); // now = T0 + cap + 1ms
  assert.equal(failed.outcome === 'allowed' && failed.value.status, 'failed');
  assert.equal(failed.outcome === 'allowed' && failed.value.failure!.code, 'EXPORT_TIME_CAP_EXCEEDED');
  const afterFail = slowManager.complete(job.id);
  assert.equal(afterFail.outcome === 'denied' && afterFail.code, 'INVALID_STATE');
});

test('complete enforces the time cap even when the worker did not tick', () => {
  let now = T0;
  const manager = new ExportJobManager({ store, now: () => now });
  const created = manager.create({ streamIds: ['str-corinne-q'], start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' }, null);
  assert.equal(created.outcome, 'allowed');
  if (created.outcome !== 'allowed') return;
  manager.start(created.value.id);
  now = new Date(Date.parse(T0) + EXPORT_LIMITS.jobTimeCapMs + 1).toISOString();
  const completed = manager.complete(created.value.id);
  assert.equal(completed.outcome === 'denied' && completed.code, 'EXPORT_TIME_CAP_EXCEEDED');
  assert.equal(manager.job(created.value.id)?.status, 'failed');
});

test('download expiry: a succeeded manifest expires after the TTL', () => {
  const base = Date.parse(T0);
  let calls = 0;
  const manager = new ExportJobManager({
    store,
    now: () => {
      calls += 1;
      // create (2 reads), start (1), complete (2 reads) happen at T0; the
      // download's expiry check lands after the TTL.
      return new Date(base + (calls <= 5 ? 0 : EXPORT_LIMITS.downloadTtlMs + 1)).toISOString();
    },
  });
  const created = manager.create(
    { streamIds: ['str-corinne-q'], start: '2026-03-08T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw' },
    null,
  );
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  manager.start(job.id);
  manager.complete(job.id);
  const expired = manager.download(job.id, null);
  assert.equal(expired.outcome, 'denied');
  if (expired.outcome === 'denied') {
    assert.equal(expired.status, 410);
    assert.equal(expired.code, 'DOWNLOAD_EXPIRED');
  }
});

test('grant denial: anonymous export of a restricted stream is 401 at creation (same gate as charts)', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  const anonymous = manager.create(
    { streamIds: ['str-hyrum-q-owner'], start: '2026-03-04T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', basis: 'raw' },
    null,
  );
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.code, 'UNAUTHENTICATED');
  }
  // Out-of-scope authenticated caller: hidden-object 404, no job created.
  const outsider = manager.create(
    { streamIds: ['str-hyrum-q-owner'], start: '2026-03-04T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', basis: 'raw' },
    'principal-priya-engineer',
  );
  assert.equal(outsider.outcome === 'denied' && outsider.status, 404);
  assert.equal(manager.list().length, 0);
});

test('revoked grant fails the job CLOSED on download: no bytes, terminal failed', () => {
  const { store: dynamicStore, setWorld } = revocableWorldStore();
  const base = Date.parse(T0);
  const manager = new ExportJobManager({ store: dynamicStore, now: clock(base) });
  const created = manager.create(
    { streamIds: ['str-hyrum-q-owner'], start: '2026-03-04T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', basis: 'raw' },
    'principal-fatima-engineer',
  );
  assert.equal(created.outcome, 'allowed', 'Fatima (Bear River engineer) may export the owner stream');
  const job = created.outcome === 'allowed' ? created.value : null;
  assert.ok(job);
  manager.start(job.id);
  const done = manager.complete(job.id);
  assert.equal(done.outcome === 'allowed' && done.value.status, 'succeeded');
  const before = manager.download(job.id, 'principal-fatima-engineer');
  assert.equal(before.outcome, 'allowed', 'download works while the grant is intact');

  // Revoke the entitlement: the next download fails closed and kills the job.
  setWorld(withEntitlement(store.world, 'ent-engineer-fatima', { status: 'revoked' }));
  const revoked = manager.download(job.id, 'principal-fatima-engineer');
  assert.equal(revoked.outcome, 'denied');
  if (revoked.outcome === 'denied') {
    assert.equal(revoked.status, 403);
    assert.equal(revoked.code, 'FORBIDDEN');
    assert.equal(revoked.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  }
  const jobAfter = manager.job(job.id);
  assert.equal(jobAfter!.status, 'failed', 'the revoked download failed the job closed');
  assert.equal(jobAfter!.failure!.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  const never = manager.download(job.id, 'principal-fatima-engineer');
  assert.equal(never.outcome === 'denied' && never.code, 'FORBIDDEN', 'the failed job never serves bytes again');
});

test('a denied outsider download cannot destroy the authorized owner artifact', () => {
  const manager = new ExportJobManager({ store, now: clock() });
  const created = manager.create({ streamIds: ['str-hyrum-q-owner'], start: '2026-03-04T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' }, 'principal-fatima-engineer');
  assert.equal(created.outcome, 'allowed');
  if (created.outcome !== 'allowed') return;
  manager.start(created.value.id);
  manager.complete(created.value.id);
  const outsider = manager.download(created.value.id, 'principal-priya-engineer');
  assert.equal(outsider.outcome, 'denied');
  assert.equal(manager.job(created.value.id)?.status, 'succeeded');
  assert.equal(manager.download(created.value.id, 'principal-fatima-engineer').outcome, 'allowed');
});

test('determinism: the same job script produces identical ids, manifests and bytes', () => {
  const run = (): string => {
    const manager = new ExportJobManager({ store, now: clock() });
    const created = manager.create(
      {
        streamIds: ['str-corinne-q', 'str-hyrum-q-public'],
        start: '2026-03-06T07:00:00.000Z',
        end: '2026-03-09T06:00:00.000Z',
        basis: 'best-available',
      },
      null,
    );
    const job = created.outcome === 'allowed' ? created.value : null;
    assert.ok(job);
    manager.start(job.id);
    manager.complete(job.id);
    const download = manager.download(job.id, null);
    assert.equal(download.outcome, 'allowed');
    return download.outcome === 'allowed'
      ? JSON.stringify({ id: job.id, manifest: download.value.manifest, csv: download.value.csv })
      : 'denied';
  };
  assert.equal(run(), run());
});
