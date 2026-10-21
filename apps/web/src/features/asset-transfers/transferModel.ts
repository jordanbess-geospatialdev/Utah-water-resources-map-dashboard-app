/**
 * Pure models for the asset-transfer feature (WD-012-R2, FR-048).
 *
 * "Equipment records preserve make, model, identifier and serial-number
 * evidence; transferring an asset closes the old site association and
 * opens a dated new association without moving historical inspections to
 * the wrong site."
 *
 * The association-timeline semantics MIRROR the server domain
 * (services/api/src/workflows/sync/transfers.ts): periods are half-open
 * [from, to), the transfer boundary instant belongs to the NEW
 * association, and visits/inspections always stay attached to the site
 * where they occurred. The tests assert the boundary semantics against
 * the same scenarios the server suite runs.
 *
 * No React, no clock reads, no I/O: everything is a function of its
 * arguments; identical inputs produce identical outputs.
 */

/** Evidence-bearing equipment row as the panel renders it. */
export interface EquipmentView {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly identifier: string;
  readonly serial: string;
  readonly photoRefs: readonly string[];
  readonly registeredAt: string;
}

/** One effective-dated association period of an equipment record. */
export interface AssociationPeriod {
  readonly equipmentId: string;
  readonly siteId: string;
  /** Inclusive start of the period (the transfer boundary). */
  readonly effectiveFrom: string;
  /** Exclusive end; null = currently at this site. */
  readonly effectiveTo: string | null;
  /** Transfer that opened this period; null for the initial registration. */
  readonly openedByTransferId: string | null;
}

/** A site the actor may pick (within their assignment scope; the shell computes the list). */
export interface SiteOption {
  readonly id: string;
  readonly displayName: string;
}

/** A visit row for the history view (stays at the site where it occurred). */
export interface VisitRow {
  readonly id: string;
  readonly siteId: string;
  readonly visitTime: string;
  readonly type: string;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Timeline math (mirror of the server's half-open association semantics)
// ---------------------------------------------------------------------------

/** Ordered association periods (by effectiveFrom, then siteId for stability). */
export function associationPeriodsOf(periods: readonly AssociationPeriod[]): readonly AssociationPeriod[] {
  return [...periods].sort((left, right) =>
    Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom) || (left.siteId < right.siteId ? -1 : 1),
  );
}

/** The period covering `at` (half-open): the boundary instant is already the NEW site. */
export function periodAt(periods: readonly AssociationPeriod[], at: string): AssociationPeriod | null {
  return associationPeriodsOf(periods).find((period) => covers(period, at)) ?? null;
}

function covers(period: AssociationPeriod, at: string): boolean {
  if (Date.parse(at) < Date.parse(period.effectiveFrom)) return false;
  if (period.effectiveTo !== null && Date.parse(at) >= Date.parse(period.effectiveTo)) return false;
  return true;
}

/** The site of the equipment at `at`, or null when not yet registered. */
export function siteOfAt(periods: readonly AssociationPeriod[], at: string): string | null {
  return periodAt(periods, at)?.siteId ?? null;
}

/** The currently open period (the "from" site of the next transfer). */
export function currentPeriodOf(periods: readonly AssociationPeriod[]): AssociationPeriod | null {
  return associationPeriodsOf(periods).find((period) => period.effectiveTo === null) ?? null;
}

/** Every site the equipment was ever associated with, in period order. */
export function sitesEverOf(periods: readonly AssociationPeriod[]): readonly string[] {
  return [...new Set(associationPeriodsOf(periods).map((period) => period.siteId))];
}

/**
 * The FR-048 integrity projection: the visits that belong to a site are
 * exactly the visits RECORDED at that site - a transfer never re-files
 * them. This function exists so the panel (and the tests) can state the
 * rule in one place.
 */
export function visitsOfSite(visits: readonly VisitRow[], siteId: string): readonly VisitRow[] {
  return visits.filter((visit) => visit.siteId === siteId);
}

/**
 * The periods of ONE site, for the site history view: each row says which
 * equipment was at the site and for how long.
 */
export function periodsAtSite(periods: readonly AssociationPeriod[], siteId: string): readonly AssociationPeriod[] {
  return associationPeriodsOf(periods.filter((period) => period.siteId === siteId));
}

/** Human-readable period: "2026-01-01 to 2026-04-01 (closed)" / "since 2026-04-01 (current)". */
export function formatPeriod(period: AssociationPeriod): string {
  const from = period.effectiveFrom.slice(0, 10);
  if (period.effectiveTo === null) return `since ${from} (current)`;
  return `${from} to ${period.effectiveTo.slice(0, 10)}`;
}

/** Evidence summary line for the equipment list (FR-048 evidence visibility). */
export function evidenceLabel(equipment: EquipmentView): string {
  return `${equipment.make} ${equipment.model} - ${equipment.identifier} - s/n ${equipment.serial} - ${equipment.photoRefs.length} photo${equipment.photoRefs.length === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Transfer form (from/to site pickers within scope, dated)
// ---------------------------------------------------------------------------

export interface TransferFormValues {
  readonly equipmentId: string;
  readonly fromSiteId: string;
  readonly toSiteId: string;
  /** Boundary instant (ISO date-time with explicit offset; the model never guesses a zone). */
  readonly effectiveAt: string;
  /** Serial-number evidence confirmed on site (must match the record). */
  readonly identifier: string;
  readonly serial: string;
}

export interface TransferFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

export const EMPTY_TRANSFER_FORM: TransferFormValues = {
  equipmentId: '',
  fromSiteId: '',
  toSiteId: '',
  effectiveAt: '',
  identifier: '',
  serial: '',
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a transfer form against the equipment's real timeline and the
 * actor's in-scope site list. Mirrors the server's checks (transfers.ts):
 * evidence match, open-association match, in-scope destination, forward
 * dating, distinct sites - so the form blocks what the server would
 * reject, with the same field paths.
 */
export function validateTransferForm(
  form: TransferFormValues,
  equipment: EquipmentView | null,
  periods: readonly AssociationPeriod[],
  options: { readonly allowedSiteIds: readonly string[] },
): readonly TransferFieldError[] {
  const errors: TransferFieldError[] = [];
  const error = (fieldPath: string, code: string, message: string) => errors.push({ fieldPath, code, message });

  if (!equipment) {
    error('equipmentId', 'EQUIPMENT_UNKNOWN', 'choose the equipment to transfer');
    return errors;
  }
  const current = currentPeriodOf(periods);
  if (!current) {
    error('equipmentId', 'NO_OPEN_ASSOCIATION', 'the equipment has no open site association');
  } else {
    if (form.fromSiteId !== current.siteId) {
      error('fromSiteId', 'ASSOCIATION_MISMATCH', `the equipment's current site is "${current.siteId}" (since ${current.effectiveFrom.slice(0, 10)})`);
    }
  }
  if (form.toSiteId === '') {
    error('toSiteId', 'TO_SITE_REQUIRED', 'choose the destination site');
  } else if (!options.allowedSiteIds.includes(form.toSiteId)) {
    error('toSiteId', 'TO_SITE_OUT_OF_SCOPE', 'the destination site is outside your assignment scope');
  } else if (form.toSiteId === form.fromSiteId) {
    error('toSiteId', 'SAME_SITE', 'the destination site must differ from the current site');
  }
  if (form.effectiveAt === '') {
    error('effectiveAt', 'EFFECTIVE_DATE_REQUIRED', 'the transfer date is required (it closes the old association and opens the new one)');
  } else if (!ISO_INSTANT.test(form.effectiveAt) || Number.isNaN(Date.parse(form.effectiveAt))) {
    error('effectiveAt', 'EFFECTIVE_DATE_INVALID', 'the transfer date must be an ISO 8601 instant with an explicit offset, e.g. 2026-04-01T00:00:00Z');
  } else if (current && !(Date.parse(form.effectiveAt) > Date.parse(current.effectiveFrom))) {
    error('effectiveAt', 'EFFECTIVE_DATE_NOT_FORWARD', `the transfer date must be after the current association start ${current.effectiveFrom}`);
  }
  if (form.identifier !== equipment.identifier || form.serial !== equipment.serial) {
    error('serial', 'EVIDENCE_MISMATCH', `the confirmed identifier/serial must match the record (${equipment.identifier} / ${equipment.serial})`);
  }
  return errors;
}

/** Build the submit body for the transfer endpoint from a validated form. */
export function composeTransferBody(form: TransferFormValues): {
  readonly equipmentId: string;
  readonly fromSiteId: string;
  readonly toSiteId: string;
  readonly effectiveAt: string;
  readonly identifier: string;
  readonly serial: string;
} {
  return {
    equipmentId: form.equipmentId,
    fromSiteId: form.fromSiteId,
    toSiteId: form.toSiteId,
    effectiveAt: form.effectiveAt,
    identifier: form.identifier,
    serial: form.serial,
  };
}

// ---------------------------------------------------------------------------
// Demo seed (deterministic, fixture-shaped; the shell wires live data later)
// ---------------------------------------------------------------------------

export const DEMO_EQUIPMENT: readonly EquipmentView[] = [
  {
    id: 'eq-1001',
    make: 'FlumeLog',
    model: '300',
    identifier: 'rtu-corinne-02',
    serial: 'FL300-2201-88',
    photoRefs: ['placeholder://attachments/eq-photo-1', 'placeholder://attachments/eq-photo-2'],
    registeredAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'eq-1002',
    make: 'AquaMetric',
    model: 'SG-15',
    identifier: 'gauge-hyrum-01',
    serial: 'AM15-4417-02',
    photoRefs: ['placeholder://attachments/eq-photo-3'],
    registeredAt: '2025-11-15T00:00:00Z',
  },
];

export const DEMO_ASSOCIATIONS: readonly AssociationPeriod[] = [
  { equipmentId: 'eq-1001', siteId: 'sta-bear-corinne', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-04-01T00:00:00Z', openedByTransferId: null },
  { equipmentId: 'eq-1001', siteId: 'sta-hyrum-diversion-public', effectiveFrom: '2026-04-01T00:00:00Z', effectiveTo: null, openedByTransferId: 'xfer-1001' },
  { equipmentId: 'eq-1002', siteId: 'sta-hyrum-diversion-public', effectiveFrom: '2025-11-15T00:00:00Z', effectiveTo: null, openedByTransferId: null },
];

export const DEMO_SITES: readonly SiteOption[] = [
  { id: 'sta-bear-corinne', displayName: 'Bear River at Corinne' },
  { id: 'sta-hyrum-diversion-public', displayName: 'Hyrum Diversion (public)' },
  { id: 'sta-bear-lake-diagnostic', displayName: 'Bear Lake Diagnostic' },
];

export const DEMO_VISITS: readonly VisitRow[] = [
  { id: 'visit-1001', siteId: 'sta-bear-corinne', visitTime: '2026-03-12T15:30:00Z', type: 'inspection', notes: 'pre-transfer inspection at Corinne' },
  { id: 'visit-1002', siteId: 'sta-hyrum-diversion-public', visitTime: '2026-04-02T15:30:00Z', type: 'inspection', notes: 'post-transfer inspection at Hyrum' },
];
