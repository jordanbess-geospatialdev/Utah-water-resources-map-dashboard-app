/**
 * Type vocabulary for the FR-051 WCAT adapter seam (WD-023-R2).
 *
 * Source of truth: docs/product/baseline/01-product-requirements.md FR-051
 * ("An agreed adapter exchanges identified stream and model inputs or
 * results with WCAT; sync is repeatable, reports changed inputs and
 * preserves observed versus calculated versus modeled distinctions and
 * authoritative ownership") and the ratified adapter-seam-only contract in
 * docs/extensions/r2/R2-EXTENSIONS-SCOPE.md.
 *
 * ADAPTER SEAM ONLY: the external schemas, identifiers, API contract,
 * ownership model and reconciliation plan are BLOCKED on the named owners
 * (Technical Services / data ownership, per the architecture's
 * release-qualification table). Until they are agreed, this module defines
 * the typed exchange contracts and their provenance rules; the only
 * implementation is the fixture-backed fake in adapter.ts. Zero network
 * transport exists (statically scanned in test/voice.test.ts); every
 * operation has a documented manual fallback path
 * (docs/extensions/r2/WCAT-MANUAL-FALLBACK.md).
 *
 * Provenance rules, enforced by the adapter on EVERY exchange:
 *  1. every artifact carries a complete provenance block
 *     {source, observedOrModeled, ownerSystem, correlationId};
 *  2. observed / calculated / modeled NEVER mix: one artifact carries
 *     exactly one class, and one exchange carries artifacts of a single
 *     class (validated; mixed exchanges are rejected whole);
 *  3. authoritative ownership is stated per artifact (ownerSystem) and
 *     preserved unchanged through the exchange;
 *  4. the correlation id of every artifact matches the exchange's
 *     correlation id, so a sync is repeatable and replayable end to end.
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads.
 */

/**
 * The observed-vs-calculated-vs-modeled distinction (FR-051). Exactly one
 * class per artifact; classes never mix within an artifact or an exchange.
 */
export type ObservedOrModeled = 'observed' | 'calculated' | 'modeled';

/** Provenance block every exchanged artifact carries, verbatim from the ratified contract. */
export interface WcatProvenance {
  /** Origin system of the artifact (e.g. 'utah-water-dashboard'). */
  readonly source: string;
  /** The one distinction class this artifact belongs to. */
  readonly observedOrModeled: ObservedOrModeled;
  /** The system that authoritatively owns this value (FR-051 "authoritative ownership"). */
  readonly ownerSystem: string;
  /** Matches the exchange correlation id; ties the artifact to its sync/replay. */
  readonly correlationId: string;
}

/** What is being exchanged with WCAT (identified stream/model inputs or results). */
export type WcatArtifactKind = 'stream-input' | 'model-input' | 'result';

/** Payload values are flat scalars: identified data only, no nested blobs. */
export type WcatPayloadValue = string | number | boolean | null;

/**
 * One identified artifact exchanged with WCAT. `identifier` is the WCAT-side
 * identifier (water right number, model node id, ...): the external
 * vocabulary is still blocked on owners, so it is an opaque string here.
 */
export interface WcatArtifact {
  readonly id: string;
  readonly kind: WcatArtifactKind;
  readonly identifier: string;
  /** Dashboard-side stream linkage, when the artifact derives from a datastream. */
  readonly streamId: string | null;
  readonly payload: Readonly<Record<string, WcatPayloadValue>>;
  readonly provenance: WcatProvenance;
}

/** One changed input a sync reports (FR-051 "reports changed inputs"). */
export interface WcatChangedInput {
  readonly artifactId: string;
  readonly identifier: string;
  readonly change: 'added' | 'value-changed' | 'removed';
  /** Digest of the previously known value ('added' -> null). */
  readonly previousDigest: string | null;
  /** Digest of the newly exchanged value ('removed' -> null). */
  readonly newDigest: string | null;
}

/** The changed-input report every sync/dry-run produces. */
export interface WcatChangedInputReport {
  readonly correlationId: string;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly changes: readonly WcatChangedInput[];
}

/** Which mode an operation ran in. */
export type WcatSyncMode = 'sync' | 'dry-run';

/**
 * A successful exchange receipt: what was accepted, what changed, and the
 * provenance of every accepted artifact ECHOED UNCHANGED (preservation is
 * testable on the receipt itself).
 */
export interface WcatSyncReceipt {
  readonly outcome: 'accepted';
  readonly adapterId: string;
  readonly correlationId: string;
  readonly mode: WcatSyncMode;
  readonly acceptedCount: number;
  /** Provenance of each accepted artifact, verbatim as received. */
  readonly acceptedProvenance: readonly { readonly artifactId: string; readonly identifier: string; readonly provenance: WcatProvenance }[];
  readonly changedInputReport: WcatChangedInputReport;
  /** Pointer to the documented manual fallback for this operation (always present). */
  readonly manualFallbackDoc: string;
}

/** Structured rejection codes for exchange validation (nothing was applied). */
export type WcatRejectionCode =
  | 'PROVENANCE_INCOMPLETE'
  | 'CLASSES_MIXED'
  | 'CORRELATION_MISMATCH'
  | 'DUPLICATE_ARTIFACT'
  | 'VALIDATION_FAILED';

export interface WcatRejection {
  readonly outcome: 'rejected';
  readonly adapterId: string;
  readonly correlationId: string;
  readonly code: WcatRejectionCode;
  readonly message: string;
  /** The offending artifact ids, when the rejection is per-artifact. */
  readonly artifactIds: readonly string[];
}

export type WcatSyncResult = WcatSyncReceipt | WcatRejection;

/** A WCAT exchange request: one correlation id, one artifact class, identified artifacts. */
export interface WcatSyncRequest {
  /** Correlation id for the whole exchange; every artifact's provenance must match it. */
  readonly correlationId: string;
  /** Injected request instant; the adapter never reads a clock. */
  readonly requestedAt: string;
  readonly artifacts: readonly WcatArtifact[];
}

/**
 * The documented manual fallback for an adapter operation (FR-051's
 * "deterministic manual fallback"; the established simulated-channel
 * discipline): every operation has one.
 */
export interface WcatManualFallback {
  readonly docPath: string;
  readonly summary: string;
  readonly operations: readonly { readonly operation: 'sync' | 'dry-run' | 'replay'; readonly manualPath: string }[];
}
