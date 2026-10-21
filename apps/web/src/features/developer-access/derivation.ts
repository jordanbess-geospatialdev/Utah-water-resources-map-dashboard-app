/**
 * Pure derivation of the FR-064 developer-access (scoped credential) view
 * model. Dependency-free and clock-free: the panel passes `now` in, the
 * tests inject constants, nothing here reads Date.now(), fetches or stores.
 *
 * The view model mirrors the API's PUBLIC token projection
 * (`TokenPublicView`, services/api/src/tokens/types.ts): it never contains a
 * secret or a secret hash - the secret exists only inside the one-time
 * disclosure state of the panel, and only until the user acknowledges it.
 */

/** Wire-level action scopes (ApiTokenCreateRequest enum, packages/contracts). */
export type TokenAction = 'catalog:read' | 'sites:read' | 'observations:read' | 'history:read' | 'exports:create';

export const TOKEN_ACTIONS: readonly TokenAction[] = [
  'catalog:read',
  'sites:read',
  'observations:read',
  'history:read',
  'exports:create',
];

export const ACTION_LABELS: Readonly<Record<TokenAction, string>> = {
  'catalog:read': 'Browse catalog',
  'sites:read': 'Read sites',
  'observations:read': 'Read observations',
  'history:read': 'Read revision history',
  'exports:create': 'Create exports',
};

export type ProcessingLevel = 'raw' | 'provisional' | 'reviewed' | 'best-available';

export const PROCESSING_LEVELS: readonly ProcessingLevel[] = ['raw', 'provisional', 'reviewed', 'best-available'];

/** Data bounds of a credential; every dimension only narrows (see TOKEN-POLICY.md). */
export interface TokenScopes {
  readonly actions?: readonly TokenAction[];
  readonly streams?: readonly string[];
  readonly properties?: readonly string[];
  readonly processingLevels?: readonly ProcessingLevel[];
  readonly dateRange?: { readonly start: string; readonly end: string } | null;
}

/** The public token record as the API returns it (no secret, no hash). */
export interface TokenRecordView {
  readonly id: string;
  readonly label: string;
  readonly scopes: TokenScopes;
  readonly principalId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly status: 'active' | 'revoked';
  readonly revokedAt: string | null;
  readonly rotatedToId: string | null;
  readonly rotatedFromId: string | null;
}

/** Status a token has FROM THE VIEWER'S PERSPECTIVE (record status + clock). */
export type DerivedTokenStatus = 'active' | 'expiring' | 'expired' | 'revoked';

/** Days before expiry at which the row is flagged "expiring". */
export const EXPIRING_WINDOW_DAYS = 14;

export interface DerivedTokenRow {
  readonly id: string;
  readonly label: string;
  readonly scopesSummary: string;
  readonly derivedStatus: DerivedTokenStatus;
  readonly statusText: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Whole days remaining (rounded up); null when revoked. */
  readonly expiresInDays: number | null;
  readonly expiryText: string;
  readonly lastUsedText: string;
  readonly rotatedFromId: string | null;
  readonly rotatedToId: string | null;
  readonly canRotate: boolean;
  readonly canRevoke: boolean;
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.ceil((toMs - fromMs) / 86_400_000);
}

/**
 * Derive one row. Status precedence: revoked beats everything (the record
 * stays readable for audit); then expired; then the expiring flag; the
 * record-level status is only ever 'active' | 'revoked', so "expired" and
 * "expiring" are pure derivations against the injected clock.
 */
export function deriveTokenRow(record: TokenRecordView, now: string): DerivedTokenRow {
  const nowMs = Date.parse(now);
  const expiresInDays = record.status === 'revoked' ? null : daysBetween(nowMs, Date.parse(record.expiresAt));
  let derivedStatus: DerivedTokenStatus;
  let statusText: string;
  if (record.status === 'revoked') {
    derivedStatus = 'revoked';
    statusText = record.rotatedToId ? `Revoked (rotated to ${record.rotatedToId})` : 'Revoked';
  } else if (expiresInDays !== null && expiresInDays <= 0) {
    derivedStatus = 'expired';
    statusText = 'Expired';
  } else if (expiresInDays !== null && expiresInDays <= EXPIRING_WINDOW_DAYS) {
    derivedStatus = 'expiring';
    statusText = `Active - expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}`;
  } else {
    derivedStatus = 'active';
    statusText = `Active - ${expiresInDays} days left`;
  }
  return {
    id: record.id,
    label: record.label,
    scopesSummary: summarizeScopes(record.scopes),
    derivedStatus,
    statusText,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expiresInDays,
    expiryText: record.status === 'revoked' ? `Revoked ${record.revokedAt ?? ''}`.trim() : `Expires ${record.expiresAt}`,
    lastUsedText: record.lastUsedAt ? `Last used ${record.lastUsedAt}` : 'Never used',
    rotatedFromId: record.rotatedFromId,
    rotatedToId: record.rotatedToId,
    canRotate: record.status === 'active' && (expiresInDays ?? 0) > 0,
    canRevoke: record.status === 'active',
  };
}

/** Rows newest-first (creation descending), revoked ones kept visible for audit. */
export function deriveTokenRows(records: readonly TokenRecordView[], now: string): readonly DerivedTokenRow[] {
  return [...records]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
    .map((record) => deriveTokenRow(record, now));
}

/**
 * One-line scope summary for the list. Absent dimensions mean "bounded by
 * the account's current authority", which is spelled out rather than left
 * ambiguous.
 */
export function summarizeScopes(scopes: TokenScopes): string {
  const parts: string[] = [];
  if (scopes.actions) {
    parts.push(scopes.actions.length === TOKEN_ACTIONS.length ? 'all actions' : scopes.actions.join(', '));
  } else {
    parts.push('any action the account holds');
  }
  if (scopes.streams) parts.push(scopes.streams.join(', '));
  else parts.push('any authorized stream');
  if (scopes.properties) parts.push(`${scopes.properties.join(', ')} only`);
  if (scopes.processingLevels) parts.push(scopes.processingLevels.join('/'));
  if (scopes.dateRange) parts.push(`${scopes.dateRange.start} to ${scopes.dateRange.end}`);
  return parts.join(' · ');
}

/** What the create dialog may offer: bounded by the ACCOUNT's current authority. */
export interface AccountAuthority {
  readonly principalId: string;
  readonly displayName?: string;
  readonly availableActions: readonly TokenAction[];
  readonly readableStreams: readonly { readonly id: string; readonly label: string }[];
  readonly availableProperties: readonly string[];
  readonly availableProcessingLevels: readonly ProcessingLevel[];
  /** Maximum lifetime the server will accept (days; the 90-day proposal). */
  readonly maxLifetimeDays: number;
}

export interface ScopeChoices {
  readonly actionChoices: readonly { readonly value: TokenAction; readonly label: string }[];
  readonly streamChoices: readonly { readonly value: string; readonly label: string }[];
  readonly propertyChoices: readonly { readonly value: string; readonly label: string }[];
  readonly processingLevelChoices: readonly { readonly value: ProcessingLevel; readonly label: string }[];
  readonly maxLifetimeDays: number;
}

/** Picker options for the create dialog, strictly bounded by the authority. */
export function buildScopeChoices(authority: AccountAuthority): ScopeChoices {
  return {
    actionChoices: TOKEN_ACTIONS.filter((action) => authority.availableActions.includes(action)).map((action) => ({
      value: action,
      label: ACTION_LABELS[action],
    })),
    streamChoices: authority.readableStreams.map((stream) => ({ value: stream.id, label: stream.label })),
    propertyChoices: authority.availableProperties.map((property) => ({ value: property, label: property })),
    processingLevelChoices: PROCESSING_LEVELS.filter((level) => authority.availableProcessingLevels.includes(level)).map(
      (level) => ({ value: level, label: level }),
    ),
    maxLifetimeDays: authority.maxLifetimeDays,
  };
}

/** Draft state of the create dialog. */
export interface CreateDraft {
  readonly label: string;
  readonly actions: readonly TokenAction[];
  readonly streams: readonly string[];
  readonly properties: readonly string[];
  readonly processingLevels: readonly ProcessingLevel[];
  readonly lifetimeDays: number;
}

export const DEFAULT_DRAFT: CreateDraft = {
  label: '',
  actions: [],
  streams: [],
  properties: [],
  processingLevels: [],
  lifetimeDays: 90,
};

export type DraftField = 'label' | 'actions' | 'streams' | 'lifetime';

/** Pure validation: every error the dialog can show, keyed by field. */
export function validateDraft(draft: CreateDraft, authority: AccountAuthority): Readonly<Partial<Record<DraftField, string>>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const label = draft.label.trim();
  if (label.length < 1) errors.label = 'A label is required.';
  else if (label.length > 80) errors.label = 'Labels are at most 80 characters.';
  if (draft.actions.length === 0) errors.actions = 'Select at least one action; an empty scope cannot be issued.';
  const outsideAuthority = draft.actions.filter((action) => !authority.availableActions.includes(action));
  if (outsideAuthority.length > 0) errors.actions = `Outside this account's current authority: ${outsideAuthority.join(', ')}.`;
  const unknownStreams = draft.streams.filter((id) => !authority.readableStreams.some((stream) => stream.id === id));
  if (unknownStreams.length > 0) errors.streams = `Not readable by this account today: ${unknownStreams.join(', ')}.`;
  if (draft.lifetimeDays < 1 || draft.lifetimeDays > authority.maxLifetimeDays) {
    errors.lifetime = `Lifetime must be 1 to ${authority.maxLifetimeDays} days.`;
  }
  return errors;
}

/** Draft -> the create request body (ApiTokenCreateRequest shape; scopes narrowed). */
export function draftToScopes(draft: CreateDraft, authority: AccountAuthority): TokenScopes {
  const allStreamsSelected = draft.streams.length === authority.readableStreams.length && draft.streams.length > 0;
  return {
    actions: draft.actions,
    ...(draft.streams.length > 0 && !allStreamsSelected ? { streams: draft.streams } : {}),
    ...(draft.properties.length > 0 && draft.properties.length < authority.availableProperties.length
      ? { properties: draft.properties }
      : {}),
    ...(draft.processingLevels.length > 0 && draft.processingLevels.length < PROCESSING_LEVELS.length
      ? { processingLevels: draft.processingLevels }
      : {}),
  };
}
