/**
 * Site setup and editing (WD-010): FR-031 create/edit within actor scope
 * with coordinate validation, FR-023 PATCH semantics with If-Match +
 * before/after audit that survives actor deactivation, FR-033
 * effective-dated datastream/deployment records (a setup change appends a
 * NEW epoch; prior readings keep the original device/method context), and
 * FR-034 versioned capacity thresholds.
 *
 * Check order per mutation (exercised by the tests):
 *  1. resolve the site/stream            -> 404 NOT_FOUND;
 *  2. capability via @utah-water/policy  -> 401 identity, 404 hidden
 *     restricted out-of-scope, else 403 (DENY_LIFECYCLE_STATE closes
 *     retired/inactive sites; edit-site-metadata is draft-edit, so a
 *     proposed site stays editable in scope);
 *  3. field validation                   -> 422 with field paths (unknown
 *     PATCH fields, Utah coordinate bounds that catch lat/lon swaps,
 *     elevation, capacities, effective dates);
 *  4. If-Match optimistic version        -> 412 PRECONDITION_FAILED with
 *     both versions (concurrent edits conflict, never silently overwrite);
 *  5. apply + append audit.
 */
import { evaluate, type AuthorizationRequest, type Capability, type Decision as PolicyDecision } from '../../../../../packages/policy/src/index.ts';
import type { SiteStore } from './store.ts';
import { EDITABLE_SITE_FIELDS, PHOTO_CATEGORIES } from './store.ts';
import type {
  CreateSiteInput,
  FieldChange,
  SetupEpoch,
  SetupReplacementInput,
  SiteContext,
  SiteDecision,
  SiteFieldError,
  SiteMetadata,
  SiteMetadataPatch,
  SiteRejectedDecision,
  ThresholdInput,
  ThresholdRecord,
} from './types.ts';

export const EDIT_SITE_CAPABILITY: Capability = 'edit-site-metadata';
export const CREATE_SITE_CAPABILITY: Capability = 'create-sites';

// Utah bounding box (EPSG:4326, latitude then longitude per the fixture
// axis-order contract): a swapped pair is ~70 degrees off and always fails.
const UTAH_LATITUDE_MIN = 36.9;
const UTAH_LATITUDE_MAX = 42.1;
const UTAH_LONGITUDE_MIN = -114.2;
const UTAH_LONGITUDE_MAX = -108.9;

function reject(
  status: SiteRejectedDecision['status'],
  code: SiteRejectedDecision['code'],
  message: string,
  fieldErrors: readonly SiteFieldError[] = [],
  policyReason: string | null = null,
): SiteRejectedDecision {
  return { outcome: 'rejected', status, code, message, fieldErrors, policyReason };
}

function fieldError(fieldPath: string, code: string, message: string): SiteFieldError {
  return { fieldPath, code, message };
}

/** Policy denial -> API error mapping (same fixed hidden-object table as WD-011). */
function policyRejection(policy: PolicyDecision, isPublicObject: boolean, action: string): SiteRejectedDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(401, 'UNAUTHENTICATED', `${action} requires an authenticated, active principal`, [], policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !isPublicObject) {
    return reject(404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  return reject(403, 'FORBIDDEN', `actor is not permitted to ${action} (${policy.reason})`, [], policy.reason);
}

function authorizeStation(
  store: SiteStore,
  actorId: string,
  site: SiteMetadata,
  action: Capability,
  now: string,
  destinationSystemId?: string | null,
): SiteRejectedDecision | null {
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action,
    object: { kind: 'station', id: site.id, destinationSystemId: destinationSystemId ?? undefined },
  };
  const decision = evaluate(request, store.world, now);
  if (decision.effect === 'allow') return null;
  // The policy object's visibility mirrors the site's fixture visibility.
  const object = store.world.objects[site.id];
  return policyRejection(decision, object?.visibility === 'public', action === CREATE_SITE_CAPABILITY ? 'create sites' : 'edit site metadata');
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function validateCoordinate(fieldPath: 'latitude' | 'longitude', value: number): SiteFieldError | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fieldError(fieldPath, 'COORDINATE_NOT_NUMERIC', `${fieldPath} must be a finite number (EPSG:4326, latitude then longitude)`);
  }
  if (fieldPath === 'latitude' && (value < UTAH_LATITUDE_MIN || value > UTAH_LATITUDE_MAX)) {
    return fieldError(
      'latitude',
      'LATITUDE_OUT_OF_UTAH',
      `latitude ${value} is outside Utah bounds [${UTAH_LATITUDE_MIN}, ${UTAH_LATITUDE_MAX}]; a latitude/longitude swap or an axis-order error places the site far outside the state`,
    );
  }
  if (fieldPath === 'longitude' && (value < UTAH_LONGITUDE_MIN || value > UTAH_LONGITUDE_MAX)) {
    return fieldError('longitude', 'LONGITUDE_OUT_OF_UTAH', `longitude ${value} is outside Utah bounds [${UTAH_LONGITUDE_MIN}, ${UTAH_LONGITUDE_MAX}] (Utah longitudes are west, negative)`);
  }
  return null;
}

function validatePatch(patch: SiteMetadataPatch & Record<string, unknown>): SiteFieldError[] {
  const errors: SiteFieldError[] = [];
  const unknownFields = Object.keys(patch).filter((key) => !(EDITABLE_SITE_FIELDS as readonly string[]).includes(key));
  for (const key of unknownFields) {
    errors.push(fieldError(key, 'FIELD_NOT_ALLOWED', `"${key}" is not an editable site metadata field; allowed: ${EDITABLE_SITE_FIELDS.join(', ')}`));
  }
  if (patch.displayName !== undefined && typeof patch.displayName === 'string' && patch.displayName.trim() === '') {
    errors.push(fieldError('displayName', 'DISPLAY_NAME_REQUIRED', 'site name is required and must be non-empty'));
  }
  if (patch.latitude !== undefined) {
    const error = validateCoordinate('latitude', patch.latitude);
    if (error) errors.push(error);
  }
  if (patch.longitude !== undefined) {
    const error = validateCoordinate('longitude', patch.longitude);
    if (error) errors.push(error);
  }
  if (patch.elevationFt !== undefined) {
    const elevation = patch.elevationFt;
    if (elevation !== null && (typeof elevation !== 'number' || !Number.isFinite(elevation) || elevation < -500 || elevation > 15000)) {
      errors.push(fieldError('elevationFt', 'ELEVATION_INVALID', 'elevation must be null or a finite number of feet within [-500, 15000]'));
    }
  }
  if (patch.capacities !== undefined) {
    const capacities = patch.capacities;
    for (const key of ['maxDiversionCfs', 'storageAcreFeet'] as const) {
      const value = capacities[key];
      if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        errors.push(fieldError(`capacities.${key}`, 'CAPACITY_INVALID', `${key} must be null or a non-negative finite number`));
      }
    }
  }
  if (patch.photos !== undefined) {
    for (const [index, photo] of patch.photos.entries()) {
      if (!PHOTO_CATEGORIES.includes(photo.category)) {
        errors.push(fieldError(`photos[${index}].category`, 'PHOTO_CATEGORY_UNKNOWN', `category "${photo.category}" must be one of ${PHOTO_CATEGORIES.join(', ')}`));
      }
      if (typeof photo.takenAt !== 'string' || Number.isNaN(Date.parse(photo.takenAt))) {
        errors.push(fieldError(`photos[${index}].takenAt`, 'PHOTO_TIME_INVALID', 'takenAt must be an ISO 8601 instant'));
      }
    }
  }
  return errors;
}

function changeOf(field: string, before: unknown, after: unknown): FieldChange {
  return { field, before, after };
}

// ---------------------------------------------------------------------------
// PATCH /sites/{id}: metadata edits (FR-031, FR-023)
// ---------------------------------------------------------------------------

export function updateSiteMetadata(
  store: SiteStore,
  actorId: string,
  siteId: string,
  patch: SiteMetadataPatch,
  ctx: SiteContext,
): SiteDecision<null> {
  const site = store.siteById(siteId);
  if (!site) {
    return reject(404, 'NOT_FOUND', 'site not found', [fieldError('siteId', 'SITE_UNKNOWN', `site "${siteId}" does not exist`)]);
  }

  // Moving a site to another system validates BOTH scopes (engine rule).
  const destination = patch.systemId !== undefined && patch.systemId !== site.systemId ? patch.systemId : null;
  const denied = authorizeStation(store, actorId, site, EDIT_SITE_CAPABILITY, ctx.now, destination);
  if (denied) return denied;

  const errors = validatePatch(patch);
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'site edit failed validation; see fieldErrors', errors);
  }

  // If-Match: concurrent edits conflict with both versions exposed (FR-023).
  if (ctx.ifMatch === undefined || ctx.ifMatch !== site.version) {
    return {
      outcome: 'conflict',
      code: 'PRECONDITION_FAILED',
      status: 412,
      siteId,
      currentVersion: site.version,
      attemptedVersion: ctx.ifMatch ?? -1,
      message: `site "${siteId}" is at version ${site.version}; If-Match ${ctx.ifMatch ?? '(missing)'} does not match - re-fetch and reapply`,
    };
  }

  const changes: FieldChange[] = [];
  const next: Record<string, unknown> = { ...site };
  const track = (field: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push(changeOf(field, before, after));
      next[field] = after;
    }
  };
  track('displayName', site.displayName, patch.displayName ?? site.displayName);
  track('siteTypeId', site.siteTypeId, patch.siteTypeId ?? site.siteTypeId);
  track('systemId', site.systemId, patch.systemId ?? site.systemId);
  track('latitude', site.latitude, patch.latitude ?? site.latitude);
  track('longitude', site.longitude, patch.longitude ?? site.longitude);
  track('elevationFt', site.elevationFt, patch.elevationFt !== undefined ? patch.elevationFt : site.elevationFt);
  track('stateCode', site.stateCode, patch.stateCode ?? site.stateCode);
  if (patch.capacities !== undefined) {
    track('capacities', site.capacities, {
      maxDiversionCfs: patch.capacities.maxDiversionCfs !== undefined ? patch.capacities.maxDiversionCfs : site.capacities.maxDiversionCfs,
      storageAcreFeet: patch.capacities.storageAcreFeet !== undefined ? patch.capacities.storageAcreFeet : site.capacities.storageAcreFeet,
    });
  }
  if (patch.photos !== undefined) track('photos', site.photos, patch.photos);

  const { site: updated, auditEvent } = store.applySiteEdit({
    siteId,
    actorId,
    now: ctx.now,
    changes,
    patch: () => next as unknown as SiteMetadata,
    action: 'edit-site-metadata',
  });
  return { outcome: 'applied', code: 'OK', status: 200, site: updated, auditEvent, created: null };
}

// ---------------------------------------------------------------------------
// POST /sites: creation (FR-031)
// ---------------------------------------------------------------------------

export function createSite(store: SiteStore, actorId: string, input: CreateSiteInput, ctx: SiteContext): SiteDecision<null> {
  const principal = store.world.principals[actorId] ?? null;
  // Creation authorizes against the destination system object: a
  // system-scoped engineer can only create inside their system.
  const request: AuthorizationRequest = {
    principal,
    action: CREATE_SITE_CAPABILITY,
    object: { kind: 'system', id: input.systemId },
  };
  const decision = evaluate(request, store.world, ctx.now);
  if (decision.effect !== 'allow') {
    return policyRejection(decision, true, 'create sites');
  }

  const errors: SiteFieldError[] = validatePatch(input);
  if (typeof input.displayName !== 'string' || input.displayName.trim() === '') {
    errors.unshift(fieldError('displayName', 'DISPLAY_NAME_REQUIRED', 'site name is required'));
  }
  if (input.latitude === undefined) errors.push(fieldError('latitude', 'COORDINATE_REQUIRED', 'latitude is required at creation'));
  if (input.longitude === undefined) errors.push(fieldError('longitude', 'COORDINATE_REQUIRED', 'longitude is required at creation'));
  if (typeof input.siteTypeId !== 'string' || input.siteTypeId.trim() === '') {
    errors.push(fieldError('siteTypeId', 'SITE_TYPE_REQUIRED', 'siteTypeId is required'));
  }
  if (typeof input.stateCode !== 'string' || input.stateCode.trim() === '') {
    errors.push(fieldError('stateCode', 'STATE_REQUIRED', 'stateCode is required'));
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'site creation failed validation; see fieldErrors', errors);
  }

  const id = `sta-new-${String(1000 + store.auditEvents.length + 1)}`;
  const { site, auditEvent } = store.recordNewSite({
    site: {
      id,
      displayName: input.displayName.trim(),
      externalId: null,
      systemId: input.systemId,
      siteTypeId: input.siteTypeId,
      status: 'proposed',
      latitude: input.latitude,
      longitude: input.longitude,
      elevationFt: input.elevationFt ?? null,
      stateCode: input.stateCode,
      capacities: {
        maxDiversionCfs: input.capacities?.maxDiversionCfs ?? null,
        storageAcreFeet: input.capacities?.storageAcreFeet ?? null,
      },
      photos: input.photos ?? [],
      version: 1,
    },
    actorId,
    now: ctx.now,
  });
  return { outcome: 'applied', code: 'OK', status: 201, site, auditEvent, created: null };
}

// ---------------------------------------------------------------------------
// Measurement-setup replacement (FR-033): a NEW effective-dated epoch
// ---------------------------------------------------------------------------

export function replaceMeasurementSetup(
  store: SiteStore,
  actorId: string,
  streamId: string,
  input: SetupReplacementInput,
  ctx: SiteContext,
): SiteDecision<SetupEpoch> {
  const stream = store.streamById(streamId);
  if (!stream) {
    return reject(404, 'NOT_FOUND', 'stream not found', [fieldError('streamId', 'STREAM_UNKNOWN', `stream "${streamId}" does not exist`)]);
  }
  const site = store.siteById(stream.stationId);
  if (!site) {
    return reject(404, 'NOT_FOUND', 'site not found');
  }
  const denied = authorizeStation(store, actorId, site, EDIT_SITE_CAPABILITY, ctx.now);
  if (denied) return denied;

  const errors: SiteFieldError[] = [];
  if (typeof input.deviceId !== 'string' || input.deviceId.trim() === '') {
    errors.push(fieldError('deviceId', 'DEVICE_REQUIRED', 'deviceId is required for a setup change'));
  }
  if (typeof input.serial !== 'string' || input.serial.trim() === '') {
    errors.push(fieldError('serial', 'SERIAL_REQUIRED', 'serial is required for a setup change'));
  }
  const effectiveMs = Date.parse(input.effectiveFrom);
  const current = store.currentEpoch(streamId);
  if (Number.isNaN(effectiveMs)) {
    errors.push(fieldError('effectiveFrom', 'EFFECTIVE_DATE_INVALID', 'effectiveFrom must be an ISO 8601 instant'));
  } else if (current && effectiveMs <= Date.parse(current.effectiveFrom)) {
    errors.push(
      fieldError('effectiveFrom', 'EFFECTIVE_DATE_NOT_FORWARD', `effectiveFrom must be after the current setup epoch start ${current.effectiveFrom}; setups are effective-dated forward and never backdated over closed epochs`),
    );
  }
  if (
    input.validRangeMin !== undefined &&
    input.validRangeMin !== null &&
    (typeof input.validRangeMin !== 'number' || !Number.isFinite(input.validRangeMin))
  ) {
    errors.push(fieldError('validRangeMin', 'RANGE_INVALID', 'validRangeMin must be null or a finite number'));
  }
  if (
    input.validRangeMax !== undefined &&
    input.validRangeMax !== null &&
    (typeof input.validRangeMax !== 'number' || !Number.isFinite(input.validRangeMax))
  ) {
    errors.push(fieldError('validRangeMax', 'RANGE_INVALID', 'validRangeMax must be null or a finite number'));
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'setup change failed validation; see fieldErrors', errors);
  }

  const methodTypeId = input.methodTypeId ?? stream.methodTypeId;
  const { epoch, auditEvent } = store.appendSetupEpoch({
    streamId,
    actorId,
    siteId: site.id,
    now: ctx.now,
    closeCurrentAt: input.effectiveFrom,
    epoch: {
      streamId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      deviceId: input.deviceId.trim(),
      serial: input.serial.trim(),
      model: input.model,
      methodTypeId,
      validRangeMin: input.validRangeMin !== undefined ? input.validRangeMin : (current?.validRangeMin ?? null),
      validRangeMax: input.validRangeMax !== undefined ? input.validRangeMax : (current?.validRangeMax ?? null),
    },
  });
  return { outcome: 'applied', code: 'OK', status: 200, site, auditEvent, created: epoch };
}

// ---------------------------------------------------------------------------
// Capacity thresholds (FR-034): versioned forward, never overwritten
// ---------------------------------------------------------------------------

export function setCapacityThresholds(
  store: SiteStore,
  actorId: string,
  siteId: string,
  input: ThresholdInput,
  ctx: SiteContext,
): SiteDecision<ThresholdRecord> {
  const site = store.siteById(siteId);
  if (!site) {
    return reject(404, 'NOT_FOUND', 'site not found', [fieldError('siteId', 'SITE_UNKNOWN', `site "${siteId}" does not exist`)]);
  }
  const denied = authorizeStation(store, actorId, site, EDIT_SITE_CAPABILITY, ctx.now);
  if (denied) return denied;

  const errors: SiteFieldError[] = [];
  const streamProperties = store.streamPropertiesOf(siteId).map((entry) => entry.observedPropertyId);
  if (!streamProperties.includes(input.metric)) {
    errors.push(fieldError('metric', 'METRIC_NOT_ON_SITE', `metric "${input.metric}" is not measured by any stream of "${siteId}" (${streamProperties.join(', ') || 'none'})`));
  }
  if (typeof input.label !== 'string' || input.label.trim() === '') {
    errors.push(fieldError('label', 'LABEL_REQUIRED', 'a threshold label is required (FR-034 labelled indicators)'));
  }
  const lower = input.lowerBound ?? null;
  const upper = input.upperBound ?? null;
  if (lower === null && upper === null) {
    errors.push(fieldError('lowerBound', 'BOUND_REQUIRED', 'at least one bound (lower or upper) is required'));
  }
  if (lower !== null && upper !== null && !(lower < upper)) {
    errors.push(fieldError('upperBound', 'BOUNDS_INVERTED', 'lowerBound must be strictly below upperBound'));
  }
  if (Number.isNaN(Date.parse(input.effectiveFrom))) {
    errors.push(fieldError('effectiveFrom', 'EFFECTIVE_DATE_INVALID', 'effectiveFrom must be an ISO 8601 instant'));
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'threshold change failed validation; see fieldErrors', errors);
  }

  const { threshold, auditEvent } = store.appendThreshold({
    siteId,
    actorId,
    now: ctx.now,
    closePreviousAt: input.effectiveFrom,
    threshold: {
      siteId,
      metric: input.metric,
      label: input.label.trim(),
      lowerBound: lower,
      upperBound: upper,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
    },
  });
  return { outcome: 'applied', code: 'OK', status: 200, site, auditEvent, created: threshold };
}
