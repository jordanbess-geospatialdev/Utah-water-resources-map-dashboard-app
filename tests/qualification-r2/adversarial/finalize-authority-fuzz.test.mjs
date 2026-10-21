/**
 * WD-026 adversarial fuzz (b): finalize-authority — no unauthorized actor
 * can finalize or reopen (supersede) accounting records, and no denied
 * attempt may leave ANY trace in the ledger.
 *
 * Written by the independent R2 qualification agent (qa_accessibility).
 * The product of the attack: every unauthorized actor known to the fixture
 * and supplier worlds (anonymous, capability-less engineers/researchers,
 * out-of-scope engineers, unknown principal ids, supplier actors, Water Use
 * reviewers, deputies OUTSIDE their delegation window, deactivated
 * principals) x both mutation paths (finalize, finalizeSuperseding) x a
 * seeded corpus of request shapes (period kinds, hidden/unknown systems,
 * stale/absent optimistic guards, empty and hostile reasons).
 *
 * Oracle: an attempt is legal ONLY for the documented authority set (the
 * statewide steward via statewide-administration; an explicitly granted
 * reviewer via review-data inside her window). Every other combination
 * must DENY (401/403/404/422) or return the typed FINALIZE_CONFLICT, and
 * a denied attempt must never append a record, mutate the ledger state,
 * or write an audit event.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/finalize-authority-fuzz.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, pick } from '../../qualification/adversarial/canaries.mjs';

const { FinalizedLedger, checkFinalizeAuthority, finalizedContentFromReport, FINALIZE_AUTHORITY_RULE } = await import(
  '../../../services/api/src/workflows/accounting-snapshots/finalize.ts'
);
const { generateReport, fixtureReportDeps } = await import('../../../services/api/src/workflows/distribution-report/generate.ts');
const { DEFAULT_INCLUDE } = await import('../../../services/api/src/workflows/distribution-report/types.ts');
const { reportWorld } = await import('../../../services/api/src/workflows/distribution-report/world.ts');
const { standardSupplierWorld } = await import('../../../services/api/src/workflows/supplier-report/world.ts');

const WORLD = reportWorld().policyWorld;
const SUPPLIER_WORLD = standardSupplierWorld();
const BEAR = 'sys-bear-river';
const WEBER = 'sys-weber-river';
const NOW = '2026-03-09T07:00:00Z'; // inside Ana's delegation window
const AFTER_DELEGATION = '2026-07-01T00:00:00Z'; // ent-deputy-ana expired 2026-06-30T23:59:59Z

const DIEGO = 'principal-diego-steward';
const CODY = 'principal-cody-commissioner';
const ANA = 'principal-ana-deputy';

/** The documented authority set for BEAR at NOW (the only legal finalizers). */
const AUTHORIZED = new Set([DIEGO, CODY, ANA]);

/**
 * Unauthorized actors, each with the reason it must be refused. Drawn from
 * BOTH fixture worlds so an R2-side grant (supplier-reporting, Water Use
 * reviewer) can never satisfy the finalize gate.
 */
const UNAUTHORIZED = [
  ['anonymous', null],
  ['engineer-in-scope-but-capability-less', 'principal-fatima-engineer'],
  ['researcher', 'principal-sarah-researcher'],
  ['engineer-out-of-scope-for-bear', 'principal-priya-engineer'],
  ['cohort-member-wiley-a', 'wiley-a'],
  ['supplier-water-user-wiley', 'principal-wiley-water-user'],
  ['supplier-water-user-morgan', 'principal-morgan-water-user'],
  ['water-use-reviewer-cache', 'principal-wum-reviewer-cache'],
  ['water-use-reviewer-bear', 'principal-wum-reviewer-bear'],
  ['unknown-principal', 'principal-ghost-unknown'],
  ['empty-string-actor', ''],
];

const PERIODS = [
  { kind: 'calendar-year', year: 2026 },
  { kind: 'water-year', year: 2026 },
  { kind: 'irrigation-year', year: 2026 },
  { kind: 'custom', from: '2026-03-07T19:00:00Z', to: '2026-03-08T19:00:00Z' },
];

const SYSTEMS = [BEAR, WEBER, 'sys-does-not-exist'];

// Content variants: distinct category arithmetic, so identical-content
// replay can never mask an authorization difference.
function contentOf(scale, note) {
  return {
    methodVersion: 'rectangle-right@1',
    policyVersion: 'policy@fixture',
    roundingPolicy: 'full precision; presentation rounds volumes to 3 decimals',
    noDoubleCountPolicy: 'Totals are reported per accounting category and are never summed across categories.',
    categories: [
      {
        category: 'natural-channel-flow',
        label: 'Natural channel flow (mainstem gauges)',
        streamIds: ['str-corinne-q'],
        volumeAcreFeet: (10299 / 121) * scale,
        volumeUnit: 'acre-feet',
        coveredSeconds: 180_000,
        durationSeconds: 31_536_000,
        coverageFraction: 180_000 / 31_536_000,
        estimatedSeconds: 3_600,
        estimatedProportion: 3_600 / 180_000,
      },
    ],
    sourceReportId: null,
    sourceContentHash: null,
    notes: [note],
  };
}

// ---------------------------------------------------------------------------
// Exhaustive deterministic product: every unauthorized actor x op x shape
// ---------------------------------------------------------------------------

test('no unauthorized actor can finalize; every denied attempt leaves the ledger untouched', () => {
  let attempts = 0;
  let denials = 0;
  for (const [label, actorId] of UNAUTHORIZED) {
    for (const [index, period] of PERIODS.entries()) {
      for (const systemId of SYSTEMS) {
        for (const guard of [null, 'fin-000000000000']) {
          attempts += 1;
          const ledger = new FinalizedLedger();
          const before = { list: ledger.list().length, events: ledger.events.length };

          const finalize = ledger.finalize(WORLD, {
            systemId, period, decisionId: null, content: contentOf(1 + index, `attack by ${label}`), actorId, expectedCurrentId: guard, now: NOW,
          });
          assert.notEqual(finalize.outcome, 'finalized', `${label} finalized ${systemId} ${period.kind}`);

          const supersede = ledger.finalizeSuperseding(WORLD, {
            systemId, period, decisionId: null, content: contentOf(2 + index, `supersede attack by ${label}`), actorId, expectedCurrentId: guard, now: NOW,
            reason: 'unauthorized correction attempt',
          });
          assert.notEqual(supersede.outcome, 'finalized', `${label} superseded ${systemId} ${period.kind}`);

          // No trace: nothing appended, nothing audited.
          assert.equal(ledger.list().length, before.list, `${label} left records behind`);
          assert.equal(ledger.events.length, before.events, `${label} left audit events behind`);
          denials += 1;
        }
      }
    }
  }
  assert.ok(attempts >= 11 * 4 * 3 * 2, `expected the full product, ran ${attempts} attempt pairs`);
});

test('the denial vocabulary is the documented hidden-object/identity mapping', () => {
  const expectations = [
    // priya holds NO review-data capability anywhere: the engine answers
    // DENY_CAPABILITY_NOT_GRANTED (403), not the hidden-object 404 — the
    // hidden-object mapping fires for capability-holders probing outside
    // their scope (CODY on Weber, below).
    ['anonymous', null, 401, 'DENY_ANONYMOUS'],
    ['fatima (in scope, no capability)', 'principal-fatima-engineer', 403, 'DENY_CAPABILITY_NOT_GRANTED'],
    ['sarah', 'principal-sarah-researcher', 403, 'DENY_CAPABILITY_NOT_GRANTED'],
    ['priya (engineer, no review-data)', 'principal-priya-engineer', 403, 'DENY_CAPABILITY_NOT_GRANTED'],
    ['capability-holder out of scope (Cody on Weber)', 'principal-cody-commissioner', 404, 'DENY_OUT_OF_SCOPE'],
    ['unknown system', CODY, 404, 'DENY_UNKNOWN_OBJECT'],
    ['unknown principal', 'principal-ghost-unknown', 401, null],
  ];
  for (const [label, actorId, status, policyReason] of expectations) {
    const systemId = label === 'capability-holder out of scope (Cody on Weber)' ? WEBER : label === 'unknown system' ? 'sys-does-not-exist' : BEAR;
    const result = checkFinalizeAuthority(WORLD, actorId, systemId, NOW);
    assert.equal(result.outcome, 'denied', label);
    if (result.outcome === 'denied') {
      assert.equal(result.status, status, `${label}: status`);
      if (policyReason !== null) assert.equal(result.policyReason, policyReason, `${label}: policy reason`);
    }
  }
});

test('the deputy OUTSIDE her delegation window is refused exactly like a stranger', () => {
  const late = checkFinalizeAuthority(WORLD, ANA, BEAR, AFTER_DELEGATION);
  assert.equal(late.outcome, 'denied');
  if (late.outcome === 'denied') {
    assert.equal(late.status, 403);
    assert.equal(late.policyReason, 'DENY_DELEGATION_EXPIRED');
  }
  const ledger = new FinalizedLedger();
  const attack = ledger.finalize(WORLD, {
    systemId: BEAR, period: PERIODS[0], decisionId: null, content: contentOf(1, 'expired deputy attack'), actorId: ANA, expectedCurrentId: null, now: AFTER_DELEGATION,
  });
  assert.equal(attack.outcome, 'denied');
  assert.equal(ledger.list().length, 0);
});

test('supplier-world grants (supplier-reporting / Water Use reviewer) never satisfy finalize', () => {
  // Probed against the supplier world itself: even there, where these actors
  // ARE entitled to supplier-reporting, finalize authority denies.
  for (const actorId of ['principal-wiley-water-user', 'principal-wum-reviewer-cache']) {
    const result = checkFinalizeAuthority(SUPPLIER_WORLD, actorId, BEAR, NOW);
    assert.equal(result.outcome, 'denied', actorId);
  }
  // And the R2-frozen content path: a report generated by the distribution
  // workflow cannot be finalized by a supplier actor either.
  const report = generateReport(
    fixtureReportDeps(NOW),
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    'principal-cody-commissioner',
  );
  assert.equal(report.outcome, 'allowed');
  const ledger = new FinalizedLedger();
  const attack = ledger.finalize(SUPPLIER_WORLD, {
    systemId: BEAR, period: PERIODS[0], decisionId: null,
    content: finalizedContentFromReport(report.value),
    actorId: 'principal-wiley-water-user', expectedCurrentId: null, now: NOW,
  });
  assert.equal(attack.outcome, 'denied');
  assert.equal(ledger.list().length, 0, 'the supplier attack left records behind');
});

// ---------------------------------------------------------------------------
// Seeded fuzz: random request shapes against random unauthorized actors
// ---------------------------------------------------------------------------

test('seeded fuzz: 400 randomized unauthorized attempts never finalize and never leave state', () => {
  const random = mulberry32(0x46555a5a); // "FUZZ"
  const actors = UNAUTHORIZED.map(([label, id]) => id);
  let finalized = 0;
  for (let i = 0; i < 400; i += 1) {
    const actorId = pick(random, actors);
    const period = pick(random, PERIODS);
    const systemId = pick(random, SYSTEMS);
    const now = pick(random, [NOW, AFTER_DELEGATION, '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z']);
    const guard = pick(random, [null, 'fin-deadbeef0000', `fin-${String(i)}`]);
    const ledger = new FinalizedLedger();
    const op = random() < 0.5
      ? ledger.finalize(WORLD, { systemId, period, decisionId: null, content: contentOf(1 + (i % 97), `fuzz ${i}`), actorId, expectedCurrentId: guard, now })
      : ledger.finalizeSuperseding(WORLD, { systemId, period, decisionId: null, content: contentOf(1 + (i % 89), `fuzz supersede ${i}`), actorId, expectedCurrentId: guard, now, reason: pick(random, ['x', '  ', 'urgent correction', '']) });
    if (op.outcome === 'finalized') finalized += 1;
    // Even when the answer is a CONFLICT (guard mismatch on an empty slot),
    // the ledger must stay empty: no record, no event.
    assert.equal(ledger.list().length, 0, `fuzz ${i}: state leaked after ${op.outcome}`);
    assert.equal(ledger.events.length, 0, `fuzz ${i}: audit leaked after ${op.outcome}`);
  }
  assert.equal(finalized, 0, 'no randomized unauthorized attempt may finalize');
});

// ---------------------------------------------------------------------------
// Positive control: the documented authority set succeeds (the fuzz is not
// vacuously denying everything)
// ---------------------------------------------------------------------------

test('positive control: exactly the documented authority set finalizes Bear River', () => {
  const worldPrincipals = WORLD.principals;
  const candidates = Object.keys(worldPrincipals).filter((id) => worldPrincipals[id] !== undefined);
  const legal = [];
  for (const id of candidates) {
    const result = checkFinalizeAuthority(WORLD, id, BEAR, NOW);
    if (result.outcome === 'authorized') legal.push(id);
  }
  for (const id of legal) assert.ok(AUTHORIZED.has(id), `unexpected finalizer discovered: ${id}`);
  for (const id of AUTHORIZED) assert.ok(legal.includes(id), `expected finalizer ${id} refused`);
  // Every authorized record carries the owner-ratification-pending rule.
  const ledger = new FinalizedLedger();
  const result = ledger.finalize(WORLD, { systemId: BEAR, period: PERIODS[0], decisionId: null, content: contentOf(1, 'positive control'), actorId: CODY, expectedCurrentId: null, now: NOW });
  assert.equal(result.outcome, 'finalized');
  if (result.outcome === 'finalized') {
    assert.ok(result.record.authority.rule === FINALIZE_AUTHORITY_RULE);
    assert.equal(ledger.list().length, 1);
  }
});

test('authorized records never appear for any unauthorized world principal (whole-world sweep)', () => {
  // Every principal in BOTH worlds, one probe each: only the documented set
  // passes. This catches a new fixture grant silently opening finalize.
  for (const [label, world] of [['report-world', WORLD], ['supplier-world', SUPPLIER_WORLD]]) {
    const legal = Object.keys(world.principals).filter((id) => checkFinalizeAuthority(world, id, BEAR, NOW).outcome === 'authorized');
    for (const id of legal) assert.ok(AUTHORIZED.has(id), `${label}: unexpected finalizer discovered: ${id}`);
  }
});
