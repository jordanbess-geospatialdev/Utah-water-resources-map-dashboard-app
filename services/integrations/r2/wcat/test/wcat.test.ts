/**
 * FR-051 WCAT adapter seam tests (WD-023-R2, T-06).
 *
 * Covers the ratified adapter-seam-only contract in
 * docs/extensions/r2/R2-EXTENSIONS-SCOPE.md against the fixture fake:
 *  - provenance preservation: every accepted artifact's provenance block
 *    is echoed on the receipt UNCHANGED (source, observedOrModeled,
 *    ownerSystem, correlationId);
 *  - provenance enforcement: incomplete provenance, correlation mismatch
 *    and duplicate artifact ids are rejected whole, nothing applied;
 *  - observed / calculated / modeled NEVER mix: a mixed exchange is
 *    rejected; single-class exchanges of each kind are accepted;
 *  - changed-input reporting: added, value-changed and removed inputs are
 *    reported with previous/new digests and stable counts;
 *  - dry-run leaves NO state (a following sync still reports everything
 *    as added) and NO history (replay returns null);
 *  - replay determinism: the recorded receipt returns byte-identically,
 *    even after later exchanges changed the adapter state;
 *  - the manual-fallback documentation pointer resolves to the real
 *    document shipped with this slice.
 *
 * Run:
 *   node --test --experimental-strip-types services/integrations/r2/wcat/test/wcat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WcatArtifact, WcatSyncRequest } from '../types.ts';
import { WCAT_MANUAL_FALLBACK_DOC, artifactDigest, createFixtureFakeWcatAdapter, serializeWcatResult } from '../adapter.ts';

const WORKTREE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..'); // wcat/test -> <worktree>

function artifact(overrides: Partial<WcatArtifact> & Pick<WcatArtifact, 'id' | 'identifier'>, provenance?: Partial<WcatArtifact['provenance']>): WcatArtifact {
  return {
    id: overrides.id,
    kind: overrides.kind ?? 'stream-input',
    identifier: overrides.identifier,
    streamId: overrides.streamId ?? null,
    payload: overrides.payload ?? {},
    provenance: {
      source: provenance?.source ?? 'utah-water-dashboard',
      observedOrModeled: provenance?.observedOrModeled ?? 'observed',
      ownerSystem: provenance?.ownerSystem ?? 'utah-water-dashboard',
      correlationId: provenance?.correlationId ?? 'corr-1',
    },
  };
}

function request(artifacts: readonly WcatArtifact[], correlationId = 'corr-1'): WcatSyncRequest {
  return { correlationId, requestedAt: '2026-03-10T10:00:00Z', artifacts };
}

const CORRINE_OBSERVED = artifact({ id: 'art-1', identifier: 'WR-51-1234', streamId: 'str-corinne-q', payload: { cfs: 20.9 } });
const CORRINE_MODELED = artifact({ id: 'art-2', identifier: 'WR-51-5678', payload: { node: 'N-7' } }, { observedOrModeled: 'modeled' });

test('provenance preservation: accepted artifacts echo their provenance verbatim on the receipt', () => {
  const adapter = createFixtureFakeWcatAdapter();
  // One exchange, ONE class (classes never mix), but distinct per-artifact
  // provenance: different source systems and authoritative owners.
  const exchanged = [
    CORRINE_OBSERVED,
    artifact(
      { id: 'art-4', identifier: 'WR-51-2000', kind: 'model-input', payload: { cfs: 19.8 } },
      { source: 'bear-river-model-run-42', ownerSystem: 'wcat-models' },
    ),
  ];
  const result = adapter.sync(request(exchanged));
  assert.equal(result.outcome, 'accepted');
  if (result.outcome !== 'accepted') throw new Error('unreachable');
  assert.deepEqual(
    result.acceptedProvenance.map((entry) => entry.provenance),
    exchanged.map((art) => art.provenance),
    'provenance {source, observedOrModeled, ownerSystem, correlationId} is preserved unchanged',
  );
  assert.deepEqual(
    result.acceptedProvenance.map((entry) => entry.artifactId),
    ['art-1', 'art-4'],
  );
  // Replay preserves it too.
  const replayed = adapter.replay('corr-1');
  assert.deepEqual(replayed?.outcome === 'accepted' ? replayed.acceptedProvenance.map((entry) => entry.provenance) : [], exchanged.map((art) => art.provenance));
});

test('changed-input reporting: added, value-changed and removed inputs with digests and counts', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const first = adapter.sync(request([CORRINE_OBSERVED]));
  assert.equal(first.outcome, 'accepted');
  if (first.outcome !== 'accepted') throw new Error('unreachable');
  assert.deepEqual(
    first.changedInputReport.changes.map((change) => change.change),
    ['added'],
  );
  assert.equal(first.changedInputReport.changedCount, 1);
  assert.equal(first.changedInputReport.unchangedCount, 0);

  // Same identifier, changed payload -> value-changed with both digests.
  const changed = adapter.sync(request([artifact({ id: 'art-1', identifier: 'WR-51-1234', payload: { cfs: 21.4 } })]));
  assert.equal(changed.outcome, 'accepted');
  if (changed.outcome !== 'accepted') throw new Error('unreachable');
  assert.equal(changed.changedInputReport.changes[0]?.change, 'value-changed');
  assert.equal(changed.changedInputReport.changes[0]?.previousDigest, artifactDigest(CORRINE_OBSERVED));
  assert.equal(changed.changedInputReport.changes[0]?.newDigest, artifactDigest(artifact({ id: 'art-1', identifier: 'WR-51-1234', payload: { cfs: 21.4 } })));

  // Identifier absent from the (full-snapshot) request -> removed. Exchanges
  // carry at least one artifact, so the snapshot replaces WR-51-1234 with a
  // different identifier under a fresh correlation id.
  const removed = adapter.sync(request([artifact({ id: 'art-9', identifier: 'WR-51-9999' }, { correlationId: 'corr-2' })], 'corr-2'));
  assert.equal(removed.outcome, 'accepted');
  if (removed.outcome !== 'accepted') throw new Error('unreachable');
  assert.deepEqual(
    removed.changedInputReport.changes.map((change) => change.change).sort(),
    ['added', 'removed'],
  );
  const removal = removed.changedInputReport.changes.find((change) => change.change === 'removed');
  assert.equal(removal?.identifier, 'WR-51-1234');
  assert.equal(removal?.newDigest, null);
  assert.equal(removal?.previousDigest, artifactDigest(artifact({ id: 'art-1', identifier: 'WR-51-1234', payload: { cfs: 21.4 } })));
});

test('observed/calculated/modeled never mix: a mixed exchange is rejected whole', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const mixed = adapter.sync(request([CORRINE_OBSERVED, CORRINE_MODELED]));
  assert.equal(mixed.outcome, 'rejected');
  if (mixed.outcome !== 'rejected') throw new Error('unreachable');
  assert.equal(mixed.code, 'CLASSES_MIXED');
  assert.equal(mixed.artifactIds.length, 2);
  // Nothing was applied: the same identifiers are still unknown state.
  const after = adapter.sync(request([CORRINE_OBSERVED]));
  assert.ok(after.outcome === 'accepted');
  if (after.outcome === 'accepted') {
    assert.deepEqual(after.changedInputReport.changes.map((change) => change.change), ['added'], 'the rejected exchange left no state');
  }
  // Each single class exchanges cleanly.
  const singleObserved = createFixtureFakeWcatAdapter().sync(request([CORRINE_OBSERVED]));
  assert.equal(singleObserved.outcome, 'accepted');
  const singleModeled = createFixtureFakeWcatAdapter().sync(request([CORRINE_MODELED]));
  assert.equal(singleModeled.outcome, 'accepted');
  const singleCalculated = createFixtureFakeWcatAdapter().sync(request([artifact({ id: 'art-3', identifier: 'WR-51-9999' }, { observedOrModeled: 'calculated' })]));
  assert.equal(singleCalculated.outcome, 'accepted');
});

test('provenance enforcement: incomplete provenance, correlation mismatch and duplicates are rejected', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const incomplete = adapter.sync(
    request([artifact({ id: 'art-bad', identifier: 'WR-51-0000' }, { source: '' })]),
  );
  assert.equal(incomplete.outcome, 'rejected');
  if (incomplete.outcome === 'rejected') assert.equal(incomplete.code, 'PROVENANCE_INCOMPLETE');

  const mismatch = adapter.sync(request([artifact({ id: 'art-mm', identifier: 'WR-51-0001' }, { correlationId: 'corr-other' })]));
  assert.equal(mismatch.outcome, 'rejected');
  if (mismatch.outcome === 'rejected') assert.equal(mismatch.code, 'CORRELATION_MISMATCH');

  const duplicate = adapter.sync(request([CORRINE_OBSERVED, artifact({ id: 'art-1', identifier: 'WR-51-1235' })]));
  assert.equal(duplicate.outcome, 'rejected');
  if (duplicate.outcome === 'rejected') assert.equal(duplicate.code, 'DUPLICATE_ARTIFACT');

  const empty = adapter.sync(request([]));
  assert.equal(empty.outcome, 'rejected');
  if (empty.outcome === 'rejected') assert.equal(empty.code, 'VALIDATION_FAILED');
});

test('dry-run leaves NO state and NO history', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const dry = adapter.dryRun(request([CORRINE_OBSERVED]));
  assert.equal(dry.outcome, 'accepted');
  if (dry.outcome !== 'accepted') throw new Error('unreachable');
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(dry.changedInputReport.changes.map((change) => change.change), ['added'], 'the dry run still reports what WOULD change');

  // No history: replay has nothing.
  assert.equal(adapter.replay('corr-1'), null);
  // No state: the following real sync still sees everything as added.
  const applied = adapter.sync(request([CORRINE_OBSERVED]));
  assert.ok(applied.outcome === 'accepted');
  if (applied.outcome === 'accepted') {
    assert.deepEqual(applied.changedInputReport.changes.map((change) => change.change), ['added']);
  }
});

test('replay determinism: the recorded receipt returns byte-identically after later exchanges', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const first = adapter.sync(request([CORRINE_OBSERVED]));
  assert.equal(first.outcome, 'accepted');
  const firstBytes = serializeWcatResult(first);
  assert.equal(serializeWcatResult(adapter.replay('corr-1')), firstBytes, 'immediate replay is byte-identical');

  // Later exchange (fresh correlation id) changes state under the same identifiers.
  adapter.sync(request([artifact({ id: 'art-1', identifier: 'WR-51-1234', payload: { cfs: 25 } })], 'corr-2'));
  assert.equal(serializeWcatResult(adapter.replay('corr-1')), firstBytes, 'replay of the earlier sync is unchanged by the later one');
  assert.equal(adapter.replay('corr-unknown'), null);
});

test('manual fallback: every operation has a documented path and the document ships', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const fallback = adapter.manualFallback();
  assert.deepEqual(
    fallback.operations.map((operation) => operation.operation).sort(),
    ['dry-run', 'replay', 'sync'],
  );
  const docPath = join(WORKTREE_ROOT, ...fallback.docPath.split('/'));
  assert.ok(existsSync(docPath), `manual fallback document must ship at ${fallback.docPath}`);
  const doc = readFileSync(docPath, 'utf8');
  assert.ok(doc.includes('## sync') && doc.includes('## dry-run') && doc.includes('## replay'), 'the document carries a procedure per operation');
  const applied = adapter.sync(request([CORRINE_OBSERVED]));
  if (applied.outcome === 'accepted') {
    assert.equal(applied.manualFallbackDoc, WCAT_MANUAL_FALLBACK_DOC, 'receipts point at the manual path too');
  } else {
    assert.fail('expected acceptance');
  }
});
