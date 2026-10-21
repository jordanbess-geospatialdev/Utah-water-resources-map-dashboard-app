/**
 * Engineering diagnostics and threshold flag tests (WD-013; FR-036, FR-034;
 * verification rows T-06/T-15): the engineer-only view of discharge, level
 * and voltage streams (denied states for non-engineers, anonymous callers
 * and out-of-scope engineers), the byte-swept public projection, and the
 * labelled capacity indicators (symbol + text, never color alone) driven by
 * versioned, scoped threshold sets.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/diagnostics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyThresholds,
  createThresholdService,
  defaultThresholdSets,
  engineerDiagnostics,
  publicDiagnosticsProjection,
  type ThresholdSetVersion,
} from '../diagnostics.ts';
import { CODY, DIEGO, FATIMA, NINA, NOW, advancingClock, buildTestWorld, diagnosticStreams, fixtureSeries } from './helpers.ts';

const SYSTEM_BEAR = 'sys-bear-river';

/** The promoted default threshold sets (reviewed defaults, FR-034). */
function promotedDefaults(): readonly ThresholdSetVersion[] {
  return defaultThresholdSets(DIEGO, NOW).map((set) => ({ ...set, status: 'promoted' as const, promotedBy: DIEGO, promotedAt: NOW }));
}

test('FR-036: the Bear engineer view is granted and exposes discharge, level AND the internal voltage stream', () => {
  const clock = advancingClock();
  const view = engineerDiagnostics({ world: buildTestWorld(), clock: clock.clock }, FATIMA, { streams: diagnosticStreams(), thresholdSets: promotedDefaults() });
  assert.equal(view.access, 'granted');
  // All six BEAR fixture streams: the four with observations plus the
  // voltage stream and the empty public stream on the inactive station (read
  // actions allow inactive). The proposed Ogden Valley stream belongs to the
  // WEBER system, so it stays outside Fatima's Bear scope.
  assert.deepEqual(
    view.streams.map((stream) => `${stream.streamId}:${stream.visibility}`).sort(),
    [
      'str-corinne-q:public',
      'str-corinne-stage:public',
      'str-diag-voltage:internal',
      'str-hyrum-q-owner:restricted',
      'str-hyrum-q-public:public',
      'str-summit-q:public',
    ],
  );
  const voltage = view.streams.find((stream) => stream.streamId === 'str-diag-voltage')!;
  assert.equal(voltage.latest!.value, 11.1);
  assert.equal(voltage.latest!.observedAt, '2026-03-09T06:00:00Z');
  // The out-of-range voltage reading carries the labelled low-battery flag
  // (text + symbol, never color alone).
  assert.equal(voltage.indicators.length, 1);
  assert.equal(voltage.indicators[0]!.flagId, 'voltage-low');
  assert.equal(voltage.indicators[0]!.symbol, '▼');
  assert.match(voltage.indicators[0]!.text, /▼ Battery voltage at or below minimum: 11\.1 V \(at or below 11\.5 V\)/);
});

test('FR-036: non-engineers, anonymous callers and out-of-scope engineers get the DENIED state', () => {
  const clock = advancingClock();
  const deps = { world: buildTestWorld(), clock: clock.clock };
  const input = { streams: diagnosticStreams(), thresholdSets: promotedDefaults() };
  // Commissioner (review-data, Bear) lacks view-internal-diagnostics: 403 capability.
  const cody = engineerDiagnostics(deps, CODY, input);
  assert.equal(cody.access, 'denied');
  assert.equal(cody.status, 403);
  assert.equal(cody.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.deepEqual(cody.streams, []);
  // Anonymous: 401.
  const anon = engineerDiagnostics(deps, null, input);
  assert.equal(anon.access, 'denied');
  assert.equal(anon.status, 401);
  assert.equal(anon.reason, 'DENY_ANONYMOUS');
  // Weber engineer WITH the capability but outside the Bear scope: 403 scope.
  const nina = engineerDiagnostics(deps, NINA, input);
  assert.equal(nina.access, 'denied');
  assert.equal(nina.status, 403);
  assert.equal(nina.reason, 'DENY_OUT_OF_SCOPE', 'internal diagnostics never cross systems');
});

test('FR-036 visibility sweep: the public projection contains NO internal diagnostics bytes', () => {
  const projection = publicDiagnosticsProjection({ streams: diagnosticStreams(), thresholdSets: promotedDefaults() });
  assert.deepEqual(
    projection.streams.map((stream) => stream.streamId).sort(),
    ['str-corinne-q', 'str-corinne-stage', 'str-hyrum-q-public', 'str-summit-q'],
  );
  const serialized = JSON.stringify(projection);
  const forbidden = [
    'str-diag-voltage',          // the internal stream id
    'sta-bear-lake-diagnostic',  // the internal station
    'voltage',                   // the internal observed property
    '11.1',                      // the out-of-range internal reading
    'Garden City',               // the internal station name
    '2208-QQZ',                  // internal station gate code
    'wiringNotes',               // internal station block
    'str-hyrum-q-owner',         // the restricted owner stream
    'voltage-low',               // the internal-only threshold flag
    '▼',                         // the internal-only flag symbol
  ];
  for (const bytes of forbidden) {
    assert.ok(!serialized.includes(bytes), `public projection must not contain "${bytes}"`);
  }
  // The PUBLIC capacity indicators ARE in the public projection (FR-034 map flags).
  assert.ok(serialized.includes('capacity-warn'));
  assert.ok(serialized.includes('▲'));
});

test('FR-034: out-of-range fixture values trigger labelled indicators - the 9500 spike is CRITICAL, ten readings warn', () => {
  const corinne = {
    streamId: 'str-corinne-q',
    systemId: SYSTEM_BEAR,
    observedPropertyId: 'discharge',
    unitId: 'cfs',
  };
  const series = fixtureSeries().find((candidate) => candidate.streamId === 'str-corinne-q')!;
  const points = series.points.map((point) => ({ observedAt: point.observedAt, value: point.value }));
  const indicators = applyThresholds(corinne, points, promotedDefaults());
  assert.equal(indicators.length, 11);
  assert.equal(indicators.filter((indicator) => indicator.flagId === 'capacity-warn').length, 10);
  const spike = indicators.find((indicator) => indicator.observedAt === '2026-03-08T20:00:00Z')!;
  assert.equal(spike.flagId, 'capacity-spike');
  assert.equal(spike.severity, 'critical', 'highest severity wins: the spike is not also a warn');
  assert.equal(spike.symbol, '‼');
  assert.match(spike.text, /‼ Spike far above rated capacity: 9500 cfs \(at or above 1000 cfs\)/);
  // Every indicator carries BOTH a symbol and a text label (never color alone).
  for (const indicator of indicators) {
    assert.ok(indicator.symbol.length > 0);
    assert.ok(indicator.label.length > 0);
    assert.ok(indicator.text.includes(indicator.symbol));
    assert.ok(indicator.text.includes(indicator.label));
  }
});

test('FR-034: threshold sets are scoped and versioned; the system-scoped reviewer manages Bear sets, the engineer cannot', () => {
  const clock = advancingClock();
  const svc = createThresholdService({ world: buildTestWorld(), clock: clock.clock });
  const levels = [{ id: 'stage-high', property: 'stage', op: '>=', value: 2.55, label: 'Stage above flood watch', symbol: '▲', severity: 'warn' }];
  const codySet = svc.createThresholdSet(CODY, { id: 'th-stage-watch', scope: { kind: 'stream', streamId: 'str-corinne-stage' }, levels });
  assert.ok(codySet.ok, JSON.stringify(codySet));
  assert.equal(codySet.set.status, 'draft');
  assert.equal(codySet.set.author, CODY);
  // Engineer denied: enter-readings never satisfies review-data.
  const fatimaSet = svc.createThresholdSet(FATIMA, { id: 'th-engineer-x', scope: { kind: 'stream', streamId: 'str-corinne-q' }, levels });
  assert.ok(!fatimaSet.ok && 'status' in fatimaSet);
  assert.equal(fatimaSet.status, 403);
  assert.equal(fatimaSet.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  // Cody's Bear grant does not cover a Weber-system set: cross-system denial.
  const crossSystem = svc.createThresholdSet(CODY, { id: 'th-weber-x', scope: { kind: 'system', systemId: 'sys-weber-river' }, levels });
  assert.ok(!crossSystem.ok && 'status' in crossSystem);
  assert.equal(crossSystem.status, 403);
  assert.equal(crossSystem.reason, 'DENY_OUT_OF_SCOPE');
  // Versioning: revise appends v2; only promoted latest versions are effective.
  clock.advanceMinutes(10);
  const revised = svc.reviseThresholdSet(CODY, 'th-stage-watch', [
    { id: 'stage-high', property: 'stage', op: '>=', value: 2.5, label: 'Stage above flood watch', symbol: '▲', severity: 'warn' },
  ]);
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.equal(revised.set.version, 2);
  assert.deepEqual(svc.sets().filter((set) => set.id === 'th-stage-watch').map((set) => set.version), [1, 2]);
  assert.deepEqual(svc.effectiveSets(), [], 'nothing promoted yet');
  const promoted = svc.promoteThresholdSet(CODY, 'th-stage-watch');
  assert.ok(promoted.ok);
  assert.equal(promoted.set.status, 'promoted');
  assert.equal(promoted.set.promotedBy, CODY);
  assert.deepEqual(svc.effectiveSets().map((set) => `${set.id} v${set.version}`), ['th-stage-watch v2']);
  // Bad inputs: bad id, unknown scope object, empty levels.
  const bad = svc.createThresholdSet(DIEGO, { id: 'Nope', scope: { kind: 'stream', streamId: 'str-ghost' }, levels: [] });
  assert.ok(!bad.ok && 'errors' in bad);
  assert.deepEqual(bad.errors, ['bad-threshold-id', 'invalid-scope', 'bad-levels']);
});
