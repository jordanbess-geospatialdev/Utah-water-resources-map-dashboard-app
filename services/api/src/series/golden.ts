/**
 * Golden expected values for the fixture series (seed
 * utah-water-fixture-v1), computed BY HAND from the published fixture
 * numbers below and asserted in golden.test.ts with tolerance 1e-9 relative.
 *
 * STATUS: pending measurement-owner approval. The development plan
 * (04-ai-development-and-testing.md, "Test data and scientific invariants")
 * requires golden calculations to be approved by the measurement data owner;
 * these values document the implementation's derivation and are NOT yet
 * ratified expected values.
 *
 * ---------------------------------------------------------------------------
 * DERIVATION (stream str-corinne-q, hourly cadence 60 min, valid range
 * [0, 1200] cfs, America/Denver; every reading covers exactly
 * [observedAt, observedAt + 3600 s) intersected with the local day; a reading
 * never stretches across a missing slot or a later reading; volume acre-feet
 * = sum(value * 3600) / 43560 = sum * 10/121):
 *
 * Local day 2026-03-06 = [2026-03-06T07:00Z, 2026-03-07T07:00Z), 86 400 s.
 *   Fixture readings in-window (MST local 11:00-23:00 + 00:00-06:00 next UTC
 *   day): 18.4, 18.2, 18.1, 18.3, 17.9, 18.0, 18.1, 18.4, 18.6, [03:00Z null
 *   frame], 18.5, 18.7, [06:00Z never arrived].
 *   Usable values (11): 18.4+18.2+18.1+18.3+17.9+18.0+18.1+18.4+18.6+18.5+18.7 = 201.2
 *   mean = 201.2/11; volume = 201.2 * 10/121 = 2012/121; coverage = 11/24.
 *
 * Local day 2026-03-07 = [2026-03-07T07:00Z, 2026-03-08T07:00Z), 86 400 s.
 *   Readings: 18.9, 19.0, 19.2, [10:00Z DUPLICATE obs-q-016 19.1 /
 *   obs-q-017 19.3 -> normalized to the retransmission 19.3, counted once],
 *   19.4, 19.2, 19.5, [14:00Z absent], 0 (suspect zero: REPORTED, counted),
 *   19.6, 19.8, 20.1, 20.0, 20.3, 20.2, 20.5, 20.4, 20.6, 20.8,
 *   [02:00Z -1.2 negative -> EXCLUDED from mean, slot uncovered], 21.0,
 *   21.2, 21.1, 21.4.
 *   Raw basis usable (22, includes the zero): sum = 421.5
 *     (with the superseded duplicate 19.1 instead of 19.3 the sum would be
 *     421.3 - the normalization is observable through this golden).
 *   raw mean = 421.5/22; raw volume = 4215/121; raw coverage = 22/24.
 *   Best-available basis: obs-q-032 revised -1.2 -> 20.9 (rev-corinne-2004),
 *   so 23 usable values, sum = 442.4; mean = 442.4/23; volume = 4424/121;
 *   coverage = 23/24.
 *
 * Local day 2026-03-08 (DST spring forward: 23 local hours) =
 *   [2026-03-08T07:00Z, 2026-03-09T06:00Z), 82 800 s. Local 02:00 MST jumps
 *   to 03:00 MDT: the UTC slots 07:00Z..05:00Z are consecutive, 23 slots.
 *   Readings: 21.3, 21.6, 21.8, 22.0, 22.1, [12:00Z-17:00Z declared outage
 *   gap: 6 slots MISSING, never zero], 23.5 (estimated gap edge), 23.8,
 *   [20:00Z 9500 out-of-range -> EXCLUDED, slot uncovered], 24.2, 24.5,
 *   24.7, 24.9, 25.1, 25.0, 25.3, 25.6, 25.8.
 *   Raw basis usable (16): sum = 381.2; mean = 381.2/16 = 23.825 EXACT;
 *   volume = 3812/121; coverage = 16/23; estimated = 3600 s (the gap-edge
 *   reading) -> estimated proportion 1/16.
 *   Best-available basis: obs-q-042 gap edge revised 23.5 -> 23.9
 *   (rev-corinne-2002, qualifier interpolate: still estimated), so
 *   sum = 381.6; mean = 23.85 EXACT; volume = 3816/121; coverage = 16/23.
 *   DST check: mean x 24 h would be 47.26... acre-feet; the correct volume
 *   integrates only the 16 covered hours inside the 23-hour day.
 *
 * Local week Mon 2026-03-02 (167 h = 601 200 s, DST Sunday inside):
 *   raw usable = 201.2 + 421.5 + 381.2 = 1003.9 over 49 covered slots;
 *   mean = 1003.9/49; volume = 10039/121; coverage = 49/167.
 *   best-available = 1025.2 over 50 slots; coverage = 50/167.
 *
 * Month 2026-03 (743 h = 2 674 800 s): the week's 49 covered slots plus the
 *   local-Mar-9 00:00 reading obs-q-054 (26.0, slot [2026-03-09T06:00Z,
 *   07:00Z) is inside the March window) -> 50 covered slots, sum 1029.9;
 *   coverage = 50/743; volume = 10299/121.
 *
 * Fall-back day 2026-11-01 (no fixture data): duration 90 000 s (25 h),
 * coverage 0, mean/volume null - unavailable stays unavailable.
 *
 * Manual stream str-hyrum-q-public (weekly cadence 10 080 min; a reading
 * governs until the next visit, at most its cadence):
 *   hp-002 13.1 @ 2026-03-02T17:30Z, hp-003 14.0 @ 2026-03-06T16:45Z,
 *   hp-004 15.2 @ 2026-03-09T00:30Z.
 *   Local day 2026-03-06: [07:00Z,16:45Z) = 35 100 s at 13.1, [16:45Z,24:00)
 *   = 51 300 s at 14.0 -> mean = (13.1*35100 + 14.0*51300)/86400 = 13.634375
 *   EXACT, coverage 1.
 *   Local day 2026-03-08 (82 800 s): [07:00Z, Mar 9 00:30Z) = 63 000 s at
 *   14.0, [00:30Z, 06:00Z) = 19 800 s at 15.2 -> mean = 1643/115 =
 *   14.282608695652174..., coverage 1.
 * ---------------------------------------------------------------------------
 */

/** Relative comparison tolerance for golden assertions. */
export const GOLDEN_TOLERANCE_RELATIVE = 1e-9;

export function closeRelative(actual: number, expected: number): boolean {
  const scale = Math.max(Math.abs(expected), 1e-12);
  return Math.abs(actual - expected) <= GOLDEN_TOLERANCE_RELATIVE * scale;
}

/** stream str-corinne-q */
export const CORINNE = {
  streamId: 'str-corinne-q',
  /** 2026-03-06, raw basis (identical at best-available: no revisions touch this day). */
  daily0306: {
    key: '2026-03-06',
    intervalStart: '2026-03-06T07:00:00.000Z',
    intervalEnd: '2026-03-07T07:00:00.000Z',
    durationSeconds: 86_400,
    coveredSeconds: 39_600,
    coverageFraction: 11 / 24,
    estimatedSeconds: 0,
    estimatedProportion: 0,
    meanValue: 201.2 / 11,
    volumeAcreFeet: 2012 / 121,
    usableCount: 11,
    nullPointCount: 1,
    excludedPointCount: 0,
  },
  /** 2026-03-07, raw basis. */
  daily0307Raw: {
    key: '2026-03-07',
    intervalStart: '2026-03-07T07:00:00.000Z',
    intervalEnd: '2026-03-08T07:00:00.000Z',
    durationSeconds: 86_400,
    coveredSeconds: 79_200,
    coverageFraction: 22 / 24,
    meanValue: 421.5 / 22,
    volumeAcreFeet: 4215 / 121,
    usableCount: 22,
    excludedPointCount: 1,
  },
  /** 2026-03-07, best-available basis (obs-q-032 -> 20.9). */
  daily0307Best: {
    coveredSeconds: 82_800,
    coverageFraction: 23 / 24,
    meanValue: 442.4 / 23,
    volumeAcreFeet: 4424 / 121,
    usableCount: 23,
    excludedPointCount: 0,
  },
  /** 2026-03-08 (23-hour DST day), raw basis. */
  daily0308Raw: {
    key: '2026-03-08',
    intervalStart: '2026-03-08T07:00:00.000Z',
    intervalEnd: '2026-03-09T06:00:00.000Z',
    durationSeconds: 82_800,
    coveredSeconds: 57_600,
    coverageFraction: 16 / 23,
    estimatedSeconds: 3_600,
    estimatedProportion: 1 / 16,
    meanValue: 23.825,
    volumeAcreFeet: 3812 / 121,
    usableCount: 16,
    excludedPointCount: 1,
    /** The naive mean x 24 h volume the DST rule forbids (for the negative assertion). */
    naiveMeanTimes24hAcreFeet: (23.825 * 86_400) / 43_560,
  },
  /** 2026-03-08, best-available basis (obs-q-042 -> 23.9, still estimated). */
  daily0308Best: {
    coveredSeconds: 57_600,
    coverageFraction: 16 / 23,
    estimatedSeconds: 3_600,
    estimatedProportion: 1 / 16,
    meanValue: 23.85,
    volumeAcreFeet: 3816 / 121,
    usableCount: 16,
  },
  /** Local week Mon 2026-03-02 (167 h). */
  weekly: {
    key: '2026-W10',
    intervalStart: '2026-03-02T07:00:00.000Z',
    intervalEnd: '2026-03-09T06:00:00.000Z',
    durationSeconds: 601_200,
    rawCoveredSeconds: 176_400,
    rawCoverageFraction: 49 / 167,
    rawMeanValue: 1003.9 / 49,
    rawVolumeAcreFeet: 10_039 / 121,
    bestCoverageFraction: 50 / 167,
    bestMeanValue: 1025.2 / 50,
  },
  /** Month 2026-03 (743 h: 31 days minus the DST hour). */
  monthly: {
    key: '2026-03',
    intervalStart: '2026-03-01T07:00:00.000Z',
    intervalEnd: '2026-04-01T06:00:00.000Z',
    durationSeconds: 2_674_800,
    coveredSeconds: 180_000,
    rawCoverageFraction: 50 / 743,
    rawMeanValue: 1029.9 / 50,
    rawVolumeAcreFeet: 10_299 / 121,
  },
  /** Declared outage gap inside local day 2026-03-08. */
  gap: {
    id: 'gap-corinne-20260308',
    start: '2026-03-08T12:00:00.000Z',
    end: '2026-03-08T18:00:00.000Z',
    reason: 'source-outage',
    missingSlots: 6,
  },
  /** Duplicate-timestamp normalization at 2026-03-07T10:00Z. */
  duplicate: {
    instant: '2026-03-07T10:00:00.000Z',
    supersededId: 'obs-q-016',
    supersededValue: 19.1,
    normalizedId: 'obs-q-017',
    normalizedValue: 19.3,
  },
  /** Fall-back day (no data): duration only. */
  fallBackDayDurationSeconds: 90_000,
} as const;

/** stream str-hyrum-q-public (manual, weekly cadence). */
export const HYRUM = {
  streamId: 'str-hyrum-q-public',
  daily0306Mean: 13.634375,
  daily0306Coverage: 1,
  daily0308Mean: 1643 / 115,
  daily0308Coverage: 1,
} as const;

/** The stream window used for the primary golden aggregation assertions. */
export const GOLDEN_WINDOW = {
  start: '2026-03-06T07:00:00.000Z',
  end: '2026-03-09T06:00:00.000Z',
} as const;
