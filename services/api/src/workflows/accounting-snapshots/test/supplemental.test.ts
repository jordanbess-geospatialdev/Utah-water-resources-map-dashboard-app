/**
 * Supplemental-context tests (WD-025-R2; FR-030): supplemental use is
 * compared ONLY against approved inputs, and every output is labelled
 * advisory until accounting semantics are approved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURE_SUPPLEMENTAL_INPUTS,
  assertAdvisoryLabeled,
  buildSupplementalContext,
  isAdvisoryLabeled,
  isFullyAdvisoryLabeled,
  supplementalRowText,
} from '../supplemental.ts';
import type { DecisionCategoryTotal } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z';

function measuredTotal(category: DecisionCategoryTotal['category'], volume: number): DecisionCategoryTotal {
  return {
    category,
    label: `Measured ${category}`,
    streamIds: ['str-demo'],
    volumeAcreFeet: volume,
    volumeUnit: 'acre-feet',
    coveredSeconds: 100_000,
    durationSeconds: 200_000,
    coverageFraction: 0.5,
    estimatedSeconds: 0,
    estimatedProportion: 0,
  };
}

const MEASURED: readonly DecisionCategoryTotal[] = [
  measuredTotal('natural-channel-flow', 10299 / 121),
  measuredTotal('canal-delivery', 267947 / 484),
  measuredTotal('reservoir-release', 26978 / 121),
];

function buildOrThrow() {
  const result = buildSupplementalContext({ measured: MEASURED, supplementalInputs: FIXTURE_SUPPLEMENTAL_INPUTS, comparedBy: 'principal-cody-commissioner', now: NOW });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

test('approved inputs only: the pending declaration never reaches a number', () => {
  const context = buildOrThrow();
  const release = context.rows.find((row) => row.category === 'reservoir-release');
  assert.ok(release);
  assert.equal(release?.supplementalVolumeAcreFeet, 0); // supp-bear-release-2026 is PENDING
  assert.ok(closeEnough(release?.measuredVolumeAcreFeet ?? 0, 26978 / 121));

  const canal = context.rows.find((row) => row.category === 'canal-delivery');
  assert.ok(canal);
  assert.equal(canal?.supplementalVolumeAcreFeet, 560.25); // the APPROVED declaration
  assert.ok(closeEnough(canal?.differenceAcreFeet ?? 0, 267947 / 484 - 560.25));

  assert.deepEqual(
    context.excludedPendingInputs.map((input) => input.id),
    ['supp-bear-release-2026'],
  );
});

test('the advisory label is mandatory on the context and EVERY row', () => {
  const context = buildOrThrow();
  assert.equal(context.advisory, true);
  assert.ok(context.advisoryLabel.length > 0);
  for (const row of context.rows) {
    assert.equal(row.advisory, true);
    assert.equal(typeof row.advisoryLabel, 'string');
    assert.ok(row.advisoryLabel.length > 0);
  }
  assert.ok(isAdvisoryLabeled(context));
  assert.ok(isFullyAdvisoryLabeled(context));
  for (const row of context.rows) assert.ok(isAdvisoryLabeled(row));
});

test('assertAdvisoryLabeled throws when the label is lost (enforcement point)', () => {
  const context = buildOrThrow();
  assert.doesNotThrow(() => assertAdvisoryLabeled(context));

  const unlabeledContext = { ...context, advisoryLabel: '' };
  assert.throws(() => assertAdvisoryLabeled(unlabeledContext), /advisory label/);

  const unlabeledFlag = { ...context, advisory: false };
  assert.throws(() => assertAdvisoryLabeled(unlabeledFlag), /advisory label/);

  const rowLost = { ...context, rows: [...context.rows.slice(0, 1), { ...context.rows[1]!, advisoryLabel: '' }] };
  assert.throws(() => assertAdvisoryLabeled(rowLost), /advisory label/);
  assert.equal(isFullyAdvisoryLabeled(rowLost), false);

  assert.equal(isAdvisoryLabeled(null), false);
  assert.equal(isAdvisoryLabeled('text'), false);
});

test('rendered row text always carries the advisory label', () => {
  const context = buildOrThrow();
  for (const row of context.rows) {
    const text = supplementalRowText(row);
    assert.ok(text.startsWith(row.category));
    assert.ok(text.includes('Advisory only'), text);
    assert.ok(text.includes('acre-feet'));
  }
});

test('a category present only in supplemental inputs still produces an advisory row (measured 0)', () => {
  const result = buildSupplementalContext({
    measured: [measuredTotal('natural-channel-flow', 85.1)],
    supplementalInputs: [
      ...FIXTURE_SUPPLEMENTAL_INPUTS,
      { id: 'supp-extra', category: 'canal-delivery', label: 'extra approved declaration', volumeAcreFeet: 12.5, status: 'approved', approvedBy: 'principal-diego-steward', approvedAt: NOW },
    ],
    comparedBy: 'principal-diego-steward',
    now: NOW,
  });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') {
    const canal = result.value.rows.find((row) => row.category === 'canal-delivery');
    assert.ok(canal);
    assert.equal(canal?.measuredVolumeAcreFeet, 0);
    assert.equal(canal?.coverageFraction, null);
    assert.equal(canal?.advisory, true);
  }
});

test('empty measured totals are rejected 422', () => {
  const result = buildSupplementalContext({ measured: [], supplementalInputs: FIXTURE_SUPPLEMENTAL_INPUTS, comparedBy: 'principal-cody-commissioner', now: NOW });
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.code, 'NO_MEASURED_TOTALS');
});

test('deterministic: identical inputs and clock produce identical bytes', () => {
  const first = buildOrThrow();
  const second = buildOrThrow();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.abs(b) * 1e-9;
}
