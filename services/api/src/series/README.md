# series (WD-008) - aggregation, comparison and the shared read grant gate

Pure TypeScript series domain behind the future
`GET /api/v1/streams/{id}/observations` surface (technical specification,
"Proposed application API"). Implements FR-005 / FR-006 / FR-007 / FR-066
numerical semantics over the frozen contract fixtures
(`fixtures/contracts`, seed `utah-water-fixture-v1`):

- `zone.ts` - America/Denver local-calendar machinery (local midnight
  instants, 23/25-hour DST day durations, Monday weeks, ISO week keys,
  named season windows). Built on `Intl` with a fixed IANA zone; no clock.
- `load.ts` - `SeriesStore`: frozen fixture loading (streams, observations,
  revision chains, declared gaps, governed units) plus the policy world for
  the grant gate. Bounded loading with a cadence look-back so a manual
  reading that still governs a window is not dropped.
- `aggregate.ts` - bounded `aggregateSeries()`: half-open `[start,end)` local
  calendar buckets (daily / weekly / monthly / seasonal); rectangle-right
  interval-semantics volume (`cfs * seconds / 43560`, cadence-bounded, never
  across a later reading); coverage fraction + estimated proportion; missing
  never zero; range-excluded spikes excluded from means but flagged in the
  raw listing; duplicate-timestamp normalization to the retransmission;
  processing-basis selector (raw / provisional / reviewed / best-available,
  at-or-above ladder).
- `golden.ts` / `golden.test.ts` - hand-computed golden values (daily means
  and volumes across the 2026-03-08 DST day, coverage on the declared gap,
  duplicate normalization, manual-stream integration). Tolerance 1e-9
  relative. **Pending measurement-owner approval** per the development plan;
  the full derivation is documented in `golden.ts`.
- `compare.ts` - `compareSeries()`: multi-site and multi-year comparison on
  aligned local buckets in common units; dataless buckets/years stay visible
  null gaps; incompatible property/unit mixes are typed 422s.
- `grantCheck.ts` - `readStreamGrant()` / `readStreamsGrant()`: THE gate for
  every series, comparison and export read. Public projection
  (`browse-published`) first, then the protected `view-restricted-details`
  branch; denials map 401/403/404 exactly per
  `services/api/src/auth/README.md` (hidden-object policy).

## Run the tests

```bash
cd services/api
node --test --experimental-strip-types src/series/golden.test.ts
node --test --experimental-strip-types src/series/test/series.test.ts
```

The repo-wide `pnpm --filter @utah-water/api test` glob currently only picks
up `src/workflows/revisions/test/*.test.ts`; extending it is outside WD-008's
write scope - the orchestrator should widen the glob to
`"src/{series,golden}/**"` style coverage (suggested:
`"src/**/test/*.test.ts" "src/**/*.test.ts"`).

## Numerical rules (technical specification, "Numerical and temporal rules")

| Rule | Implementation |
| --- | --- |
| Half-open `[start, end)` | every window, bucket and validity interval |
| DST 23/25-hour days | `durationSeconds` from zone offsets: 2026-03-08 = 82 800 s, 2026-11-01 = 90 000 s |
| cfs -> acre-feet | integrated cubic feet / 43 560 over each reading's representative interval |
| Never mean x 24 h | volume sums covered seconds only; golden test asserts the naive value differs |
| Missing is missing | null frames, absent slots, declared gaps and excluded spikes leave duration uncovered; `coverageFraction` + `estimatedProportion` returned; nothing zero-filled |
| No silent interpolation | a reading governs at most `[t, t + cadence)` and never past the next reading |
| Processing levels | basis selector changes values/levels (see `aggregate.ts` docstring) |

## Season windows (defaults pending owner ratification)

`irrigation` = Apr 1 - Nov 1, `water-year` = Oct 1 - Oct 1 (USGS),
`calendar-year` = Jan 1 - Jan 1. The technical specification defers exact
dates to program owners; `zone.ts#seasonWindow` is the single switch point.
