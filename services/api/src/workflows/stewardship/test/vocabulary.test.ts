/**
 * Governed vocabulary lifecycle tests (WD-014; FR-012; verification rows
 * T-02/T-03).
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/vocabulary.test.ts
 *
 * Covers: steward-only create/retire (delegation of the 403/401 matrix to
 * enforcement.test.ts; here the happy paths), RETIREMENT HISTORY
 * PRESERVATION against a fixture stream record referencing a retired
 * qualifier, duplicate label/id rejection (retired labels stay reserved),
 * version stamps and audit events on every change, and determinism.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVocabularyService, type VocabularyService } from '../vocabulary.ts';
import { DIEGO, NOW, buildTestWorld, readObservations } from './helpers.ts';

const world = buildTestWorld();
const clock = (): string => NOW;

function service(): VocabularyService {
  return createVocabularyService({ world, clock });
}

test('the fixture seed loads every governed kind (properties, units, qualifiers, processing levels, site types, systems)', () => {
  const svc = service();
  assert.equal(svc.allTerms('property').length, 3);
  assert.equal(svc.allTerms('unit').length, 3);
  assert.equal(svc.allTerms('qualifier').length, 2);
  assert.equal(svc.allTerms('processingLevel').length, 4);
  assert.deepEqual(svc.allTerms('siteType').map((term) => term.id).sort(), ['diagnostic', 'flume', 'natural-channel', 'weir']);
  assert.deepEqual(svc.allTerms('system').map((term) => term.id), ['sys-bear-river', 'sys-weber-river']);
  assert.equal(svc.registryVersion(), 1); // frozen fixture snapshot = version 1
});

test('steward create stamps a version and appends an audit event', () => {
  const svc = service();
  const before = svc.registryVersion();
  const created = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated', label: 'Estimated', description: 'Value estimated under a declared method.' });
  assert.ok(created.ok);
  assert.equal(created.term.status, 'active');
  assert.equal(created.term.registryVersion, before + 1);
  assert.equal(svc.registryVersion(), before + 1);
  const log = svc.changeLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.action, 'create');
  assert.equal(log[0]!.actorId, DIEGO);
  assert.equal(log[0]!.termId, 'estimated');
  assert.equal(log[0]!.at, NOW);
  assert.equal(log[0]!.registryVersion, before + 1);
});

test('duplicate ids and duplicate labels are rejected - and a RETIRED label stays reserved', () => {
  const svc = service();
  assert.ok(svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated', label: 'Estimated' }).ok);
  const duplicateId = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated', label: 'Another label' });
  assert.ok(!duplicateId.ok && 'errors' in duplicateId);
  assert.deepEqual(duplicateId.errors, ['duplicate-id']);

  const duplicateLabel = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated-2', label: '  estimated ' });
  assert.ok(!duplicateLabel.ok && 'errors' in duplicateLabel);
  assert.deepEqual(duplicateLabel.errors, ['duplicate-label']);

  // Labels are unique PER KIND: the same label in another kind is fine.
  assert.ok(svc.createTerm(DIEGO, { kind: 'siteType', id: 'estimated-site', label: 'Estimated' }).ok);

  // Retire, then try to reuse the retired label under a new id: history
  // must never become ambiguous (FR-012).
  assert.ok(svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'estimated' }).ok);
  const reuse = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated-3', label: 'estimated' });
  assert.ok(!reuse.ok && 'errors' in reuse);
  assert.deepEqual(reuse.errors, ['duplicate-label']);
  const recreate = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated', label: 'Estimated again' });
  assert.ok(!recreate.ok && 'errors' in recreate);
  assert.deepEqual(recreate.errors, ['duplicate-id']);
});

test('retirement NEVER deletes: historical records keep resolving their terms (fixture stream with a retired qualifier)', () => {
  const svc = service();
  // The fixture revision rev-corinne-2001 references qualifier ice-affected.
  const observations = readObservations();
  const revision = observations.revisions.find((candidate) => candidate.id === 'rev-corinne-2001')!;
  assert.deepEqual(revision.qualifierIds, ['ice-affected']);

  const retired = svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'ice-affected' });
  assert.ok(retired.ok);
  assert.equal(retired.term.status, 'retired');
  assert.equal(retired.term.retiredBy, DIEGO);
  assert.equal(retired.term.retiredAt, NOW);
  assert.equal(retired.term.registryVersion, 2);

  // The historical record still resolves its qualifier - label included.
  const resolved = svc.resolveTerm('qualifier', revision.qualifierIds[0]!);
  assert.notEqual(resolved, null);
  assert.equal(resolved!.label, 'Ice affected');
  assert.equal(resolved!.status, 'retired');
  assert.equal(resolved!.description.length > 0, true, 'retirement keeps the description');

  // Every OTHER revision qualifier resolves too (interpolate stays active).
  assert.equal(svc.resolveTerm('qualifier', 'interpolate')!.status, 'active');

  // Retired terms vanish from the active selection surface but stay in allTerms.
  assert.deepEqual(svc.activeTerms('qualifier').map((term) => term.id), ['interpolate']);
  assert.deepEqual(svc.allTerms('qualifier').map((term) => term.id).sort(), ['ice-affected', 'interpolate']);
  // Double retirement is refused.
  const again = svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'ice-affected' });
  assert.ok(!again.ok && 'errors' in again);
  assert.deepEqual(again.errors, ['already-retired']);
});

test('NEW usage cannot reference retired or unknown terms, while history keeps resolving them', () => {
  const svc = service();
  assert.ok(svc.retireTerm(DIEGO, { kind: 'processingLevel', id: 'provisional' }).ok);
  assert.deepEqual(svc.assertUsableTerms('processingLevel', ['raw', 'provisional']), [
    { code: 'retired-term', kind: 'processingLevel', id: 'provisional' },
  ]);
  assert.deepEqual(svc.assertUsableTerms('processingLevel', ['raw', 'nope']), [
    { code: 'unknown-term', kind: 'processingLevel', id: 'nope' },
  ]);
  assert.deepEqual(svc.assertUsableTerms('qualifier', ['interpolate']), []);
  // History still resolves the retired processing level.
  assert.equal(svc.resolveTerm('processingLevel', 'provisional')!.status, 'retired');
});

test('a new property referencing a retired or unknown canonical unit is rejected', () => {
  const svc = service();
  assert.ok(svc.retireTerm(DIEGO, { kind: 'unit', id: 'V' }).ok);
  const retiredUnit = svc.createTerm(DIEGO, { kind: 'property', id: 'signal-strength', label: 'Signal strength', canonicalUnitId: 'V' });
  assert.ok(!retiredUnit.ok && 'errors' in retiredUnit);
  assert.deepEqual(retiredUnit.errors, ['retired-canonical-unit']);
  const unknownUnit = svc.createTerm(DIEGO, { kind: 'property', id: 'signal-strength', label: 'Signal strength', canonicalUnitId: 'dBm' });
  assert.ok(!unknownUnit.ok && 'errors' in unknownUnit);
  assert.deepEqual(unknownUnit.errors, ['unknown-canonical-unit']);
  const activeUnit = svc.createTerm(DIEGO, { kind: 'property', id: 'depth', label: 'Depth', canonicalUnitId: 'ft' });
  assert.ok(activeUnit.ok);
});

test('structural validation: unknown kinds and malformed ids/labels are rejected after the gate', () => {
  const svc = service();
  const unknownKind = svc.createTerm(DIEGO, { kind: 'mood', id: 'happy', label: 'Happy' });
  assert.ok(!unknownKind.ok && 'errors' in unknownKind);
  assert.deepEqual(unknownKind.errors, ['unknown-kind']);
  const badId = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'Bad_Id', label: 'Bad' });
  assert.ok(!badId.ok && 'errors' in badId);
  assert.deepEqual(badId.errors, ['bad-id']);
  const badLabel = svc.createTerm(DIEGO, { kind: 'qualifier', id: 'ok-id', label: '   ' });
  assert.ok(!badLabel.ok && 'errors' in badLabel);
  assert.deepEqual(badLabel.errors, ['bad-label']);
  const unknownRetire = svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'ghost' });
  assert.ok(!unknownRetire.ok && 'errors' in unknownRetire);
  assert.deepEqual(unknownRetire.errors, ['unknown-term']);
});

test('every change bumps the registry version exactly once and the audit log is append-only', () => {
  const svc = service();
  assert.ok(svc.createTerm(DIEGO, { kind: 'qualifier', id: 'a1', label: 'A one' }).ok); // v2
  assert.ok(svc.createTerm(DIEGO, { kind: 'qualifier', id: 'a2', label: 'A two' }).ok); // v3
  assert.ok(svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'a1' }).ok); // v4
  assert.equal(svc.registryVersion(), 4);
  const log = svc.changeLog();
  assert.deepEqual(log.map((event) => event.action), ['create', 'create', 'retire']);
  assert.deepEqual(log.map((event) => event.registryVersion), [2, 3, 4]);
  assert.deepEqual(log.map((event) => event.termId), ['a1', 'a2', 'a1']);
});

test('determinism: identical scenario run twice serializes byte-identically', () => {
  const scenario = (): string => {
    const svc = service();
    svc.createTerm(DIEGO, { kind: 'qualifier', id: 'estimated', label: 'Estimated' });
    svc.retireTerm(DIEGO, { kind: 'qualifier', id: 'ice-affected' });
    svc.createTerm(DIEGO, { kind: 'property', id: 'depth', label: 'Depth', canonicalUnitId: 'ft' });
    svc.retireTerm(DIEGO, { kind: 'unit', id: 'V' });
    return svc.serialize();
  };
  const first = scenario();
  const second = scenario();
  assert.equal(first, second);
  assert.equal(first.includes('"registryVersion":5'), true);
});
