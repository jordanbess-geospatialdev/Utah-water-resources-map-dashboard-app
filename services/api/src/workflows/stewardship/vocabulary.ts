/**
 * Governed-term registry for universal metadata (WD-014; FR-012).
 *
 * "Only an authorized steward creates or retires distribution systems and
 * global sensors, properties, units, qualifiers and processing levels; used
 * terms cannot be deleted in a way that breaks historical records."
 *
 * Rules implemented here:
 *
 * - STEWARD-ONLY create/retire: every mutation passes the policy gate
 *   (action `manage-vocabulary`, satisfied by the steward's
 *   statewide-administration / manage-vocabulary grant). Anyone else -
 *   engineer, commissioner, deputy, researcher, water user - is denied 403;
 *   anonymous, unknown or deactivated actors are denied 401. The registry
 *   renders verdicts; it never decides them.
 * - RETIREMENT NEVER DELETES: a retired term stays in the registry with its
 *   label, description and audit history. `resolveTerm` keeps resolving
 *   retired terms forever, so historical observations and revisions that
 *   reference a retired qualifier keep rendering (tested against a fixture
 *   stream record). What retirement DOES close is NEW usage:
 *   `assertUsableTerms` rejects retired ids for fresh records.
 * - DUPLICATE LABEL REJECTION: labels are unique per kind, forever - the
 *   label of a retired term stays reserved so history can never become
 *   ambiguous. Duplicate ids are likewise rejected.
 * - VERSION STAMP + AUDIT: the registry carries a monotonic version
 *   counter; every create/retire bumps it, stamps the changed term and
 *   appends an immutable audit event naming actor, instant, term and
 *   registry version.
 *
 * Fixture-backed: the seed loads the frozen contract world (vocabulary.json,
 * systems.json and the station site-type set) through the same loader the
 * tests pin; there is no privileged seeding path. Pure in-memory store with
 * injected clock: two runs with identical inputs serialize byte-identically.
 */
import { readFileSync } from 'node:fs';
import type { PolicyObject, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, governanceObject, instantIso, withExtraObjects, type GateOutcome, type PolicyEvaluator } from './gate.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const VOCABULARY_KINDS = ['property', 'unit', 'qualifier', 'processingLevel', 'siteType', 'system'] as const;
export type VocabularyKind = (typeof VOCABULARY_KINDS)[number];

export type TermStatus = 'active' | 'retired';

export interface GovernedTerm {
  readonly id: string;
  readonly kind: VocabularyKind;
  readonly label: string;
  readonly description: string;
  /** Dimension tag (flow / level / equipment) for properties and units. */
  readonly dimension: string | null;
  /** Canonical unit id for properties. */
  readonly canonicalUnitId: string | null;
  readonly status: TermStatus;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
  /** Registry version at the term's last change (version stamp, FR-012 audit). */
  readonly registryVersion: number;
}

export type VocabularyAuditAction = 'create' | 'retire';

export interface VocabularyAuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly action: VocabularyAuditAction;
  readonly kind: VocabularyKind;
  readonly termId: string;
  readonly label: string;
  readonly registryVersion: number;
}

/** Governance-mutation denial: policy verdict + mapped HTTP status. */
export type VocabularyDenial = { readonly ok: false; readonly denied: GateOutcome & { ok: false } };

export type CreateTermInput = {
  readonly kind: VocabularyKind | string;
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly dimension?: string | null;
  readonly canonicalUnitId?: string | null;
};

export type RetireTermInput = {
  readonly kind: VocabularyKind | string;
  readonly id: string;
};

export type CreateTermErrorCode =
  | 'unknown-kind'
  | 'bad-id'
  | 'bad-label'
  | 'duplicate-id'
  | 'duplicate-label'
  | 'unknown-canonical-unit'
  | 'retired-canonical-unit';

export type RetireTermErrorCode = 'unknown-kind' | 'unknown-term' | 'already-retired';

export type TermLookupIssue = { readonly code: 'unknown-term' | 'retired-term'; readonly kind: VocabularyKind; readonly id: string };

// ---------------------------------------------------------------------------
// Validation constants (pure)
// ---------------------------------------------------------------------------

/** Governed term id shape (same shape family as fixture vocabulary ids). */
export const TERM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LABEL_MAX_LENGTH = 80;
/** Fixture snapshot stamp: the frozen seed is registry version 1. */
export const SEED_REGISTRY_VERSION = 1;
export const SEED_TERM_STAMP = '2025-07-01T00:00:00Z';
export const SEED_TERM_ACTOR = 'fixture-seed';

/** Canonical label key: case-insensitive, whitespace-collapsed. */
export function labelKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Fixture seed (frozen contract world; no privileged seeding path)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

interface VocabularyFixture {
  observedProperties: ReadonlyArray<{ id: string; name: string; dimension?: string; canonicalUnitId?: string; description?: string }>;
  units: ReadonlyArray<{ id: string; name: string; dimension?: string; description?: string }>;
  qualifiers: ReadonlyArray<{ id: string; name: string; description?: string }>;
  processingLevels: ReadonlyArray<{ id: string; name: string; description?: string }>;
}

interface SystemsFixtureFile {
  systems: ReadonlyArray<{ id: string; name: string; kind?: string; description?: string }>;
}

interface StationsFixtureFile {
  stations: ReadonlyArray<{ siteTypeId?: string }>;
}

/**
 * Load the governed-term seed from the frozen contract fixtures:
 * properties, units, qualifiers and processing levels from
 * vocabulary.json, distribution systems from systems.json, and the station
 * site-type set from stations.json.
 */
export function loadVocabularySeed(): readonly GovernedTerm[] {
  const vocabulary = readFixture<VocabularyFixture>('vocabulary.json');
  const systems = readFixture<SystemsFixtureFile>('systems.json');
  const stations = readFixture<StationsFixtureFile>('stations.json');

  const terms: GovernedTerm[] = [];
  const stamp = (id: string, kind: VocabularyKind, label: string, description: string, extra: Partial<GovernedTerm> = {}): void => {
    terms.push({
      id,
      kind,
      label,
      description,
      dimension: null,
      canonicalUnitId: null,
      status: 'active',
      createdAt: SEED_TERM_STAMP,
      createdBy: SEED_TERM_ACTOR,
      retiredAt: null,
      retiredBy: null,
      registryVersion: SEED_REGISTRY_VERSION,
      ...extra,
    });
  };

  for (const property of vocabulary.observedProperties) {
    stamp(property.id, 'property', property.name, property.description ?? '', {
      dimension: property.dimension ?? null,
      canonicalUnitId: property.canonicalUnitId ?? null,
    });
  }
  for (const unit of vocabulary.units) {
    stamp(unit.id, 'unit', unit.name, unit.description ?? '', { dimension: unit.dimension ?? null });
  }
  for (const qualifier of vocabulary.qualifiers) {
    stamp(qualifier.id, 'qualifier', qualifier.name, qualifier.description ?? '');
  }
  for (const level of vocabulary.processingLevels) {
    stamp(level.id, 'processingLevel', level.name, level.description ?? '');
  }
  const siteTypeIds = [...new Set(stations.stations.map((station) => station.siteTypeId).filter((id): id is string => typeof id === 'string'))].sort();
  for (const siteTypeId of siteTypeIds) {
    stamp(siteTypeId, 'siteType', siteTypeId, 'Site type observed in the frozen station fixture set.');
  }
  for (const system of systems.systems) {
    stamp(system.id, 'system', system.name, system.description ?? '');
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface VocabularyServiceDeps {
  readonly world: PolicyWorld;
  /** REQUIRED injected clock (no hidden Date.now reads; determinism is tested). */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
  /** Seed terms; defaults to the frozen fixture vocabulary. Pass [] for an empty registry. */
  readonly seed?: readonly GovernedTerm[];
}

export interface VocabularyService {
  /** Steward-only term creation. Denials carry the policy verdict and mapped status. */
  createTerm(principalId: string | null, input: Readonly<CreateTermInput>): { ok: true; term: GovernedTerm } | { ok: false; errors: readonly CreateTermErrorCode[] } | VocabularyDenial;
  /** Steward-only retirement. NEVER deletes: the term stays resolvable forever. */
  retireTerm(principalId: string | null, input: Readonly<RetireTermInput>): { ok: true; term: GovernedTerm } | { ok: false; errors: readonly RetireTermErrorCode[] } | VocabularyDenial;
  /** Resolve a term for HISTORY - retired terms included. No policy gate: historical records must keep resolving (FR-012). */
  resolveTerm(kind: VocabularyKind | string, id: string): GovernedTerm | null;
  /** Active terms only - the selection surface for NEW records. */
  activeTerms(kind?: VocabularyKind | string): readonly GovernedTerm[];
  /** All terms including retired (steward console history view). */
  allTerms(kind?: VocabularyKind | string): readonly GovernedTerm[];
  /** Validate ids for NEW usage: unknown or retired ids are reported (FR-012: history resolves, new usage cannot). */
  assertUsableTerms(kind: VocabularyKind | string, ids: readonly string[]): readonly TermLookupIssue[];
  /** Immutable audit log in append order (oldest first). */
  changeLog(): readonly VocabularyAuditEvent[];
  /** Monotonic registry version; bumped and stamped on every change. */
  registryVersion(): number;
  /** Byte-stable serialization for the determinism test. */
  serialize(): string;
}

/** Policy-object id for a governed term (namespace-prefixed: no world collisions). */
export function termObjectId(kind: VocabularyKind | string, id: string): string {
  return `term:${kind}:${id}`;
}

function kindRegistryObjectId(kind: VocabularyKind): string {
  return `vocab:${kind}`;
}

/**
 * The governed-term registry. Mutations evaluate `manage-vocabulary` through
 * the policy engine against per-kind registry objects (create) or the term
 * object itself (retire), so a non-steward principal can never mutate the
 * vocabulary regardless of payload.
 */
export function createVocabularyService(deps: VocabularyServiceDeps): VocabularyService {
  const clock = deps.clock;
  const policy = deps.policy;
  let terms: readonly GovernedTerm[] = Object.freeze([...(deps.seed ?? loadVocabularySeed())]);
  const audit: VocabularyAuditEvent[] = [];
  let version = terms.reduce((max, term) => Math.max(max, term.registryVersion), 0);
  let auditCounter = 0;

  const perKindRegistries: readonly PolicyObject[] = VOCABULARY_KINDS.map((kind) =>
    governanceObject({ id: kindRegistryObjectId(kind), kind: 'vocabulary' }),
  );
  const rootRegistry = governanceObject({ id: 'vocab:root', kind: 'vocabulary' });

  /** World with the registry objects (and optionally one term object) attached. */
  const worldFor = (extra: readonly PolicyObject[] = []): PolicyWorld =>
    withExtraObjects(deps.world, [rootRegistry, ...perKindRegistries, ...extra]);

  const gate = (principalId: string | null, objectId: string, status: string): GateOutcome =>
    gateAct(
      { world: worldFor([governanceObject({ id: objectId, kind: 'vocabulary', status })]), clock, policy },
      principalId,
      'manage-vocabulary',
      { kind: 'vocabulary', id: objectId },
    );

  const deny = (outcome: GateOutcome & { ok: false }): VocabularyDenial => ({ ok: false, denied: outcome });

  const nextAuditId = (): string => `ve-${String((auditCounter += 1)).padStart(6, '0')}`;

  return {
    createTerm(principalId, input) {
      const kind = input.kind as string;
      if (!(VOCABULARY_KINDS as readonly string[]).includes(kind)) {
        // Unknown kinds cannot be gated per-kind; deny on the root registry
        // object so even malformed requests pass the policy gate first.
        const verdict = gateAct({ world: worldFor(), clock, policy }, principalId, 'manage-vocabulary', { kind: 'vocabulary', id: 'vocab:root' });
        if (!verdict.ok) return deny(verdict);
        return { ok: false, errors: ['unknown-kind'] };
      }
      const typedKind = kind as VocabularyKind;
      const verdict = gate(principalId, kindRegistryObjectId(typedKind), 'active');
      if (!verdict.ok) return deny(verdict);

      const errors: CreateTermErrorCode[] = [];
      const id = typeof input.id === 'string' ? input.id : '';
      const label = typeof input.label === 'string' ? input.label : '';
      if (!TERM_ID_PATTERN.test(id)) errors.push('bad-id');
      if (label.trim().length === 0 || label.length > LABEL_MAX_LENGTH) errors.push('bad-label');

      if (errors.length === 0) {
        if (terms.some((term) => term.id === id)) errors.push('duplicate-id');
        if (terms.some((term) => term.kind === typedKind && labelKey(term.label) === labelKey(label))) errors.push('duplicate-label');
        if (typedKind === 'property') {
          const unitId = input.canonicalUnitId ?? null;
          if (unitId !== null) {
            const unit = terms.find((term) => term.kind === 'unit' && term.id === unitId);
            if (!unit) errors.push('unknown-canonical-unit');
            else if (unit.status === 'retired') errors.push('retired-canonical-unit');
          }
        }
      }
      if (errors.length > 0) return { ok: false, errors };

      version += 1;
      const term: GovernedTerm = Object.freeze({
        id,
        kind: typedKind,
        label: label.trim(),
        description: input.description ?? '',
        dimension: input.dimension ?? null,
        canonicalUnitId: input.canonicalUnitId ?? null,
        status: 'active',
        createdAt: instantIso(clock()),
        createdBy: principalId ?? '',
        retiredAt: null,
        retiredBy: null,
        registryVersion: version,
      });
      terms = Object.freeze([...terms, term]);
      audit.push(Object.freeze({
        id: nextAuditId(),
        at: term.createdAt,
        actorId: term.createdBy,
        action: 'create',
        kind: typedKind,
        termId: id,
        label: term.label,
        registryVersion: version,
      }));
      return { ok: true, term };
    },

    retireTerm(principalId, input) {
      const kind = input.kind as string;
      if (!(VOCABULARY_KINDS as readonly string[]).includes(kind)) {
        const verdict = gateAct({ world: withExtraObjects(deps.world, [...perKindRegistries.values()]), clock, policy }, principalId, 'manage-vocabulary', { kind: 'vocabulary', id: 'vocab:root' });
        if (!verdict.ok) return deny(verdict);
        return { ok: false, errors: ['unknown-kind'] };
      }
      const typedKind = kind as VocabularyKind;
      const term = terms.find((candidate) => candidate.kind === typedKind && candidate.id === input.id);
      const status = term?.status ?? 'active';
      const verdict = gate(principalId, termObjectId(typedKind, input.id), status);
      if (!verdict.ok) return deny(verdict);

      const errors: RetireTermErrorCode[] = [];
      if (!term) errors.push('unknown-term');
      else if (term.status === 'retired') errors.push('already-retired');
      if (errors.length > 0) return { ok: false, errors };

      version += 1;
      const retiredAt = instantIso(clock());
      const retired: GovernedTerm = Object.freeze({
        ...term!,
        status: 'retired',
        retiredAt,
        retiredBy: principalId ?? '',
        registryVersion: version,
      });
      terms = Object.freeze(terms.map((candidate) => (candidate === term ? retired : candidate)));
      audit.push(Object.freeze({
        id: nextAuditId(),
        at: retiredAt,
        actorId: retired.retiredBy!,
        action: 'retire',
        kind: typedKind,
        termId: term!.id,
        label: term!.label,
        registryVersion: version,
      }));
      return { ok: true, term: retired };
    },

    resolveTerm(kind, id) {
      return terms.find((term) => term.kind === (kind as VocabularyKind) && term.id === id) ?? null;
    },

    activeTerms(kind) {
      return terms.filter((term) => term.status === 'active' && (kind === undefined || term.kind === (kind as VocabularyKind)));
    },

    allTerms(kind) {
      return kind === undefined ? terms : terms.filter((term) => term.kind === (kind as VocabularyKind));
    },

    assertUsableTerms(kind, ids) {
      const issues: TermLookupIssue[] = [];
      for (const id of ids) {
        const term = terms.find((candidate) => candidate.kind === (kind as VocabularyKind) && candidate.id === id);
        if (!term) issues.push({ code: 'unknown-term', kind: kind as VocabularyKind, id });
        else if (term.status === 'retired') issues.push({ code: 'retired-term', kind: kind as VocabularyKind, id });
      }
      return issues;
    },

    changeLog() {
      return [...audit];
    },

    registryVersion() {
      return version;
    },

    serialize() {
      return JSON.stringify({ registryVersion: version, terms, audit }, null, 0);
    },
  };
}
