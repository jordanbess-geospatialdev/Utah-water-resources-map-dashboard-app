/**
 * Shared fixture world and section builders for the WD-017 supplier-report
 * suites (mirrors ../stewardship/test/helpers.ts): the standard synthetic
 * actors (two suppliers on DIFFERENT systems + one reviewer per
 * organization) attached to the fixture policy world through the
 * established withEntitlement-style derivation (packages/policy is never
 * edited).
 */
import { fixtureSupplierDeps, type SupplierDeps } from '../report.ts';
import { standardSupplierWorld, STANDARD_ACTORS } from '../world.ts';
import type { ReportSections } from '../types.ts';

/** The fixture fixed clock (matches the seed manifest). */
export const NOW = '2026-03-09T07:00:00Z';
/** A later clock instant for resubmission/bookkeeping transitions. */
export const LATER = '2026-04-02T15:30:00Z';

export const BEAR = 'sys-bear-river';
export const WEBER = 'sys-weber-river';
export const ORG_CACHE = 'org-cache-water';
export const ORG_BEAR_USERS = 'org-bear-river-users';

/** Deps with the standard supplier world at the fixture clock. */
export function supplierDeps(now: string = NOW): SupplierDeps {
  return fixtureSupplierDeps(now, standardSupplierWorld());
}

/** A fully valid section set (all category rules satisfied, no warnings). */
export function validSections(): ReportSections {
  return {
    culinaryUse: { populationServed: 52_000, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 },
    sourceInventory: [
      { sourceId: 'W-1', sourceType: 'well', name: 'Canyon Well 1', pumpCapacityGpm: 1500, annualWithdrawalGallons: 1_200_000_000, metered: true },
      { sourceId: 'SP-2', sourceType: 'spring', name: 'East Spring', pumpCapacityGpm: null, annualWithdrawalGallons: 600_000_000, metered: false },
    ],
    purchaseInventory: [{ sellerName: 'Regional Water Conservancy District', annualPurchasedGallons: 250_000_000 }],
    wholesaleInventory: [{ buyerName: 'Box Elder Mutual', annualSoldGallons: 90_000_000 }],
    returnInventory: [{ returnType: 'treated-effluent', receivingBody: 'Little Bear River', annualReturnedGallons: 40_000_000 }],
    sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 },
    secondaryUse: { irrigatedAcres: 310.5, secondaryConnections: 2_400, annualSecondaryVolumeGallons: 480_000_000, metered: true },
  };
}

/** A fully valid section set with one acknowledged-warning field (peak-hour demand implausibly high). */
export function sectionsWithWarning(): ReportSections {
  return { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 90_000 } };
}
