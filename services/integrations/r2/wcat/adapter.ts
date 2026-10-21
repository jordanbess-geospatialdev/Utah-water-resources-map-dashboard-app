/**
 * FR-051 WCAT adapter interface + fixture fake (WD-023-R2).
 *
 * ADAPTER SEAM ONLY (see types.ts): the real schemas, ids, API contract,
 * ownership and reconciliation plan are blocked on the named owners, so the
 * only implementation here is FixtureFakeWcatAdapter - a deterministic,
 * in-memory, fixture-backed fake that enforces the SAME provenance rules a
 * future real adapter must enforce. Zero network transport (statically
 * scanned); every operation has a documented manual fallback path.
 *
 * Semantics implemented by the fake (what a real adapter must preserve):
 *  - sync(request): validates, computes the changed-input report against
 *    the previously known fixture state, APPLIES the new state, records the
 *    exchange for replay, and returns a receipt with every accepted
 *    artifact's provenance echoed UNCHANGED;
 *  - dryRun(request): identical validation and identical report, but NO
 *    state change and NO recorded history - a dry run leaves nothing
 *    behind;
 *  - replay(correlationId): returns the recorded receipt of that sync
 *    byte-identically (deterministic replay), independent of any later
 *    state changes;
 *  - requests are treated as FULL SNAPSHOTS of their identifier set: an
 *    identifier known before but absent from the request is reported
 *    'removed'.
 *
 * Digests are canonical (sorted-key) JSON of the value content, so equal
 * content always digests equal regardless of key order. No clock reads:
 * every instant is injected; no randomness: digests are content-derived.
 */
import { createHash } from 'node:crypto';
import type {
  ObservedOrModeled,
  WcatArtifact,
  WcatManualFallback,
  WcatSyncRequest,
  WcatSyncResult,
} from './types.ts';

/**
 * The adapter seam (FR-051): sync, dry-run and replay over the typed
 * exchange contracts. A real transport plugs in here AFTER the external
 * contract is agreed; until then the fixture fake below is the only
 * implementation, and it enforces the same provenance rules.
 */
export interface WcatAdapter {
  readonly adapterId: string;
  /** Validate + report changed inputs + apply the exchange, recorded for replay. */
  sync(request: WcatSyncRequest): WcatSyncResult;
  /** Validate + report changed inputs; leaves NO state and NO history. */
  dryRun(request: WcatSyncRequest): WcatSyncResult;
  /** Return the recorded receipt of a past sync byte-identically; null when unknown. */
  replay(correlationId: string): WcatSyncResult | null;
  /** The documented manual fallback for every operation. */
  manualFallback(): WcatManualFallback;
}

export const WCAT_MANUAL_FALLBACK_DOC = 'docs/extensions/r2/WCAT-MANUAL-FALLBACK.md';

// ---------------------------------------------------------------------------
// Canonical digests
// ---------------------------------------------------------------------------

/** Sort object keys recursively so equal content digests equal, always. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content digest of one artifact: WHAT it says (identifier, kind, class,
 * payload). Provenance ownership fields are digested only through the
 * class (observedOrModeled); source/ownerSystem/correlationId changes are
 * provenance updates, not value changes, and are reported as such by
 * provenance comparison rather than silently absorbed.
 */
export function artifactDigest(artifact: WcatArtifact): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        identifier: artifact.identifier,
        kind: artifact.kind,
        observedOrModeled: artifact.provenance.observedOrModeled,
        payload: artifact.payload,
      }),
      'utf8',
    )
    .digest('hex');
}

/** Canonical serialization of a result (deterministic; used by the replay test). */
export function serializeWcatResult(result: WcatSyncResult): string {
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Validation (the provenance rules, enforced identically in every mode)
// ---------------------------------------------------------------------------

function validateRequest(adapterId: string, request: WcatSyncRequest): { ok: true; artifactClass: ObservedOrModeled } | { ok: false; rejection: WcatSyncResult } {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const incomplete: string[] = [];
  const mismatched: string[] = [];
  for (const artifact of request.artifacts) {
    if (seen.has(artifact.id)) duplicateIds.push(artifact.id);
    seen.add(artifact.id);
    const provenance = artifact.provenance;
    const complete =
      typeof provenance?.source === 'string' &&
      provenance.source.length > 0 &&
      typeof provenance?.ownerSystem === 'string' &&
      provenance.ownerSystem.length > 0 &&
      (provenance.observedOrModeled === 'observed' || provenance.observedOrModeled === 'calculated' || provenance.observedOrModeled === 'modeled') &&
      typeof provenance?.correlationId === 'string' &&
      provenance.correlationId.length > 0;
    if (!complete) incomplete.push(artifact.id);
    if (provenance?.correlationId !== request.correlationId) mismatched.push(artifact.id);
  }
  if (duplicateIds.length > 0) {
    return {
      ok: false,
      rejection: {
        outcome: 'rejected',
        adapterId,
        correlationId: request.correlationId,
        code: 'DUPLICATE_ARTIFACT',
        message: 'artifact ids must be unique within one exchange',
        artifactIds: [...new Set(duplicateIds)].sort(),
      },
    };
  }
  if (incomplete.length > 0) {
    return {
      ok: false,
      rejection: {
        outcome: 'rejected',
        adapterId,
        correlationId: request.correlationId,
        code: 'PROVENANCE_INCOMPLETE',
        message: 'every artifact must carry complete provenance {source, observedOrModeled, ownerSystem, correlationId}',
        artifactIds: incomplete.sort(),
      },
    };
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      rejection: {
        outcome: 'rejected',
        adapterId,
        correlationId: request.correlationId,
        code: 'CORRELATION_MISMATCH',
        message: `every artifact's provenance correlation id must equal the exchange correlation id "${request.correlationId}"`,
        artifactIds: mismatched.sort(),
      },
    };
  }
  const classes = [...new Set(request.artifacts.map((artifact) => artifact.provenance.observedOrModeled))];
  if (classes.length > 1) {
    return {
      ok: false,
      rejection: {
        outcome: 'rejected',
        adapterId,
        correlationId: request.correlationId,
        code: 'CLASSES_MIXED',
        message: `observed / calculated / modeled never mix in one exchange; found [${classes.sort().join(', ')}]`,
        artifactIds: request.artifacts.map((artifact) => artifact.id).sort(),
      },
    };
  }
  if (classes.length === 0) {
    return {
      ok: false,
      rejection: {
        outcome: 'rejected',
        adapterId,
        correlationId: request.correlationId,
        code: 'VALIDATION_FAILED',
        message: 'an exchange must carry at least one artifact',
        artifactIds: [],
      },
    };
  }
  return { ok: true, artifactClass: classes[0] as ObservedOrModeled };
}

// ---------------------------------------------------------------------------
// The fixture fake
// ---------------------------------------------------------------------------

interface KnownState {
  readonly artifactId: string;
  readonly identifier: string;
  readonly digest: string;
  readonly provenance: WcatArtifact['provenance'];
}

/**
 * The fixture-backed fake WCAT adapter: deterministic, in-memory, offline.
 * Construct one per test/process; its state is private to the instance.
 */
export function createFixtureFakeWcatAdapter(options?: { readonly adapterId?: string }): WcatAdapter {
  const adapterId = options?.adapterId ?? 'fixture-fake-wcat';
  const state = new Map<string, KnownState>(); // keyed by identifier
  const history = new Map<string, { request: WcatSyncRequest; receipt: WcatSyncResult }>();

  const evaluate = (mode: 'sync' | 'dry-run', request: WcatSyncRequest): WcatSyncResult => {
    const validation = validateRequest(adapterId, request);
    if (!validation.ok) return validation.rejection;

    const changes = [];
    const acceptedProvenance = [];
    const requestIdentifiers = new Set(request.artifacts.map((artifact) => artifact.identifier));

    for (const artifact of request.artifacts) {
      const digest = artifactDigest(artifact);
      const known = state.get(artifact.identifier);
      if (!known) {
        changes.push({ artifactId: artifact.id, identifier: artifact.identifier, change: 'added', previousDigest: null, newDigest: digest });
      } else if (known.digest !== digest) {
        changes.push({ artifactId: artifact.id, identifier: artifact.identifier, change: 'value-changed', previousDigest: known.digest, newDigest: digest });
      }
      acceptedProvenance.push({ artifactId: artifact.id, identifier: artifact.identifier, provenance: artifact.provenance });
    }
    for (const known of state.values()) {
      if (!requestIdentifiers.has(known.identifier)) {
        changes.push({ artifactId: known.artifactId, identifier: known.identifier, change: 'removed', previousDigest: known.digest, newDigest: null });
      }
    }
    changes.sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : a.change < b.change ? -1 : 1));
    acceptedProvenance.sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1));

    const changedCount = request.artifacts.filter((artifact) => changes.some((change) => change.identifier === artifact.identifier && change.change !== 'removed')).length;
    const unchangedCount = request.artifacts.length - changedCount;

    return {
      outcome: 'accepted',
      adapterId,
      correlationId: request.correlationId,
      mode,
      acceptedCount: request.artifacts.length,
      acceptedProvenance: Object.freeze(acceptedProvenance),
      changedInputReport: Object.freeze({
        correlationId: request.correlationId,
        changedCount,
        unchangedCount,
        changes: Object.freeze(changes),
      }),
      manualFallbackDoc: WCAT_MANUAL_FALLBACK_DOC,
    };
  };

  const apply = (request: WcatSyncRequest): void => {
    const requestIdentifiers = new Set(request.artifacts.map((artifact) => artifact.identifier));
    for (const [identifier, known] of state) {
      if (!requestIdentifiers.has(identifier)) state.delete(identifier);
    }
    for (const artifact of request.artifacts) {
      state.set(artifact.identifier, { artifactId: artifact.id, identifier: artifact.identifier, digest: artifactDigest(artifact), provenance: artifact.provenance });
    }
  };

  return {
    adapterId,
    sync(request) {
      const receipt = evaluate('sync', request);
      if (receipt.outcome === 'accepted') {
        apply(request);
        history.set(request.correlationId, { request, receipt });
      }
      return receipt;
    },
    dryRun(request) {
      // Identical validation and report; NO state change, NO history entry.
      return evaluate('dry-run', request);
    },
    replay(correlationId) {
      const recorded = history.get(correlationId);
      return recorded ? recorded.receipt : null;
    },
    manualFallback(): WcatManualFallback {
      return {
        docPath: WCAT_MANUAL_FALLBACK_DOC,
        summary: 'Deterministic manual fallback for every adapter operation (simulated-channel discipline); see the document for the per-operation procedures.',
        operations: [
          { operation: 'sync', manualPath: `${WCAT_MANUAL_FALLBACK_DOC}#sync` },
          { operation: 'dry-run', manualPath: `${WCAT_MANUAL_FALLBACK_DOC}#dry-run` },
          { operation: 'replay', manualPath: `${WCAT_MANUAL_FALLBACK_DOC}#replay` },
        ],
      };
    },
  };
}

/** Convenience fixture: the deterministic stub provider of the adapter world. */
export const FIXTURE_FAKE_ADAPTER_ID = 'fixture-fake-wcat';
