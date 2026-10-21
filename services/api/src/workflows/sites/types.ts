/**
 * Type vocabulary for the site-setup workflow (WD-010): FR-031 (engineer
 * site setup and editing), FR-023 (site metadata change history),
 * FR-033 (datastream and sensor setup history - effective-dated setups so a
 * device change never rewrites prior readings' device/method context) and
 * FR-034 (versioned capacity thresholds).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads. The
 * future Fastify layer maps PATCH /sites/{id} (allowed metadata fields,
 * version conflict check and audit) onto these decisions: 401 identity,
 * 403 capability, 404 hidden object, 412 stale If-Match, 422 validation
 * with field paths.
 */

/** Editable metadata block of a site (FR-031: name, type, capacities, location, elevation, system, photos). */
export interface SiteMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly systemId: string;
  readonly siteTypeId: string;
  readonly status: 'proposed' | 'active' | 'inactive' | 'retired';
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationFt: number | null;
  readonly stateCode: string;
  readonly capacities: { readonly maxDiversionCfs: number | null; readonly storageAcreFeet: number | null };
  readonly photos: readonly PhotoMetadata[];
  /** Optimistic version; PATCH requires If-Match against it. */
  readonly version: number;
}

export interface PhotoMetadata {
  readonly id: string;
  readonly caption: string;
  /** UTC instant the photo was taken. */
  readonly takenAt: string;
  readonly category: 'site-overview' | 'installation' | 'gauge-plate' | 'other';
}

/** The allowed PATCH fields (everything else - id, status, visibility - is 422). */
export interface SiteMetadataPatch {
  readonly displayName?: string;
  readonly siteTypeId?: string;
  readonly systemId?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly elevationFt?: number;
  readonly stateCode?: string;
  readonly capacities?: { maxDiversionCfs?: number | null; storageAcreFeet?: number | null };
  readonly photos?: readonly PhotoMetadata[];
}

/**
 * One effective-dated measurement setup of a stream (FR-033). Changing a
 * setup closes the current epoch and appends a NEW record; existing
 * readings keep resolving the epoch that was current when they were
 * observed - history is never rewritten.
 */
export interface SetupEpoch {
  readonly id: string;
  readonly streamId: string;
  readonly effectiveFrom: string;
  /** Half-open end [effectiveFrom, effectiveTo); null = current setup. */
  readonly effectiveTo: string | null;
  readonly deviceId: string;
  readonly serial: string;
  readonly model: string;
  readonly methodTypeId: string;
  readonly validRangeMin: number | null;
  readonly validRangeMax: number | null;
  /** Stream setup version this epoch was recorded at (commit re-verification anchor). */
  readonly setupVersion: number;
}

/** A versioned capacity threshold (FR-034: scoped and versioned). */
export interface ThresholdRecord {
  readonly id: string;
  readonly siteId: string;
  /** Observed property the threshold flags ('discharge', 'stage', ...). */
  readonly metric: string;
  readonly label: string;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** 1-based ordinal within (siteId, metric): thresholds version forward, never overwrite. */
  readonly version: number;
}

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type SiteAuditAction =
  | 'create-site'
  | 'edit-site-metadata'
  | 'replace-measurement-setup'
  | 'set-capacity-thresholds';

/**
 * FR-023: authorized edits record actor, time and before-and-after values,
 * and history remains after actor deactivation (the log is append-only and
 * actor ids stay resolvable via the policy engine's resolveActor).
 */
export interface SiteAuditEvent {
  readonly id: string;
  readonly action: SiteAuditAction;
  readonly actorId: string;
  readonly siteId: string;
  readonly streamId: string | null;
  readonly changes: readonly FieldChange[];
  readonly recordedAt: string;
}

export interface SiteFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

export interface SiteAppliedDecision<T> {
  readonly outcome: 'applied';
  readonly code: 'OK';
  readonly status: 200 | 201;
  readonly site: SiteMetadata;
  readonly auditEvent: SiteAuditEvent;
  /** The record created by the action (epoch or threshold), when applicable. */
  readonly created: T | null;
}

export interface SiteRejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED';
  readonly message: string;
  readonly fieldErrors: readonly SiteFieldError[];
  readonly policyReason: string | null;
}

/** Stale If-Match: concurrent changes produce a reviewable conflict, never a silent overwrite (FR-023). */
export interface SitePreconditionDecision {
  readonly outcome: 'conflict';
  readonly code: 'PRECONDITION_FAILED';
  readonly status: 412;
  readonly siteId: string;
  readonly currentVersion: number;
  readonly attemptedVersion: number;
  readonly message: string;
}

export type SiteDecision<T = unknown> = SiteAppliedDecision<T> | SiteRejectedDecision | SitePreconditionDecision;

/** Execution context: clock + the If-Match version for PATCH. */
export interface SiteContext {
  readonly now: string;
  /** If-Match: the site version this edit builds on; required for edits. */
  readonly ifMatch?: number;
}

/** Body of a measurement-setup replacement (FR-033). */
export interface SetupReplacementInput {
  readonly deviceId: string;
  readonly serial: string;
  readonly model: string;
  readonly methodTypeId?: string;
  readonly validRangeMin?: number | null;
  readonly validRangeMax?: number | null;
  /** The new setup is effective from this instant; must be after the current epoch start. */
  readonly effectiveFrom: string;
}

/** Body of a threshold change (FR-034). */
export interface ThresholdInput {
  readonly metric: string;
  readonly label: string;
  readonly lowerBound?: number | null;
  readonly upperBound?: number | null;
  readonly effectiveFrom: string;
}

/** Body of site creation (FR-031). */
export interface CreateSiteInput extends SiteMetadataPatch {
  readonly displayName: string;
  readonly systemId: string;
  readonly siteTypeId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly stateCode: string;
}
