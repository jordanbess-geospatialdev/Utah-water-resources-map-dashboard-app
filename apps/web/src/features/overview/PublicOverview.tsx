/**
 * PublicOverview - the FR-058 public overview surface for anonymous users:
 * it LEADS with the intelligible statewide summary (a plain-language lead
 * derived from the indicators, never hand-written prose that can drift),
 * then the three self-describing indicator cards (telemetry coverage,
 * reviewed-data coverage, measured-vs-estimated with its distinct unknown
 * bucket), the FR-060 data-dictionary entry point, and the selected-system
 * drill-down with the FR-061 space/time totals and FR-062 charts.
 *
 * Every indicator card shows its numerator, denominator, period (half-open,
 * with its meaning), asOf and exclusions VISIBLY - never hidden in tooltips
 * - and distinguishes OUTPUT measures from OUTCOME context. Missing scopes
 * render "not available", never a fabricated zero. Loading/empty/error/stale
 * states are first-class (role=status/alert with retry).
 *
 * The numbers come from ./derivation (the pure mirror of
 * services/api/src/summaries), pinned to the services values by
 * derivation.test.ts. WD-018 does not wire the shell: see README.md.
 */
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  areaTotals,
  defaultTotalsWindow,
  plainLanguageSummary,
  statewideOverview,
  summaryIndicators,
  type Indicator,
  type MeasuredVersusEstimatedIndicator,
  type SummaryWorldInput,
} from './derivation';
import SummaryCharts from './SummaryCharts';
import { FIXTURE_CLOCK, FIXTURE_SEED, observations, revisions, stations, systems } from '../../shell/data/fixtures';

export interface PublicOverviewProps {
  /** 'stale' renders the asOf staleness notice; the shell owns the judgment. */
  readonly status?: 'loading' | 'ready' | 'stale' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Selected distribution system for the drill-down; null/undefined = statewide. */
  readonly selectedSystemId?: string | null;
  readonly onSelectSystem?: (systemId: string | null) => void;
  /** FR-060 entry point: opens the maintained data dictionary (definitions, units, levels, qualifiers, lineage). */
  readonly onOpenDataDictionary?: () => void;
  /** Injectable world (tests); defaults to the frozen contract fixtures. */
  readonly world?: SummaryWorldInput;
}

const CARD_STYLE: CSSProperties = { border: '1px solid #dfe3da', borderRadius: 8, padding: '10px 12px', margin: '0 0 10px', background: '#fbfcfa' };
const CHIP_STYLE: CSSProperties = { display: 'inline-block', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 8, border: '1px solid #c6cdc0', color: '#3f4a3c', marginLeft: 8 };
const MUTED: CSSProperties = { color: '#5a6355', fontSize: 12 };
const EXCLUSION_STYLE: CSSProperties = { fontSize: 11, color: '#5a6355', margin: '2px 0 0', paddingLeft: 14 };

function IndicatorCard({ indicator }: { indicator: Indicator }) {
  const fractionText =
    indicator.fraction === null ? 'Not available (no denominator)' : `${Math.round(indicator.fraction * 100)}%`;
  return (
    <article className="indicator-card" style={CARD_STYLE} aria-label={indicator.label}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>
        {indicator.label}
        <span style={CHIP_STYLE}>{indicator.measureKind === 'output' ? 'Output measure' : 'Outcome context'}</span>
      </h3>
      <p style={{ fontSize: 22, margin: '0 0 4px' }} data-indicator-fraction={fractionText}>
        {indicator.numerator} of {indicator.denominator} {indicator.unit}
        <span style={{ fontSize: 14, color: '#3f4a3c', marginLeft: 8 }}>{fractionText}</span>
      </p>
      <p style={MUTED}>
        Period {indicator.period.start} to {indicator.period.end} (end exclusive) — {indicator.period.description}. As of {indicator.asOf}.
      </p>
      <p style={MUTED}>Method: {indicator.method}</p>
      <details open>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Exclusions applied to the denominator ({indicator.exclusions.length})</summary>
        <ul style={{ margin: '4px 0 0' }}>
          {indicator.exclusions.map((exclusion) => (
            <li key={exclusion.reason} style={EXCLUSION_STYLE}>
              {exclusion.reason}: {exclusion.count}
              {exclusion.ids.length > 0 ? ` (${exclusion.ids.join(', ')})` : ''}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function ClassificationCard({ indicator }: { indicator: MeasuredVersusEstimatedIndicator }) {
  return (
    <article className="indicator-card indicator-card-classification" style={CARD_STYLE} aria-label={indicator.label}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>
        {indicator.label}
        <span style={CHIP_STYLE}>Output measure</span>
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 6px' }}>
        {indicator.buckets.map((bucket) => (
          <li key={bucket.classification} style={{ fontSize: 15, margin: '2px 0' }}>
            <strong>{bucket.numerator}</strong> of {bucket.denominator} {indicator.unit} — {bucket.label}
            <span style={{ marginLeft: 8, color: '#3f4a3c', fontSize: 13 }}>
              {bucket.fraction === null ? 'not available' : `${Math.round(bucket.fraction * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
      <p style={MUTED}>
        Period {indicator.period.start} to {indicator.period.end} (end exclusive) — {indicator.period.description}. As of {indicator.asOf}.
      </p>
      <p style={MUTED}>Method: {indicator.method}</p>
      <details open>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Exclusions applied to the denominator ({indicator.exclusions.length})</summary>
        <ul style={{ margin: '4px 0 0' }}>
          {indicator.exclusions.map((exclusion) => (
            <li key={exclusion.reason} style={EXCLUSION_STYLE}>
              {exclusion.reason}: {exclusion.count}
              {exclusion.ids.length > 0 ? ` (${exclusion.ids.join(', ')})` : ''}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function PublicOverview({
  status = 'ready',
  errorMessage,
  onRetry,
  selectedSystemId = null,
  onSelectSystem,
  onOpenDataDictionary,
  world,
}: PublicOverviewProps) {
  const fixtureWorld = useMemo<SummaryWorldInput>(
    () => world ?? { asOf: FIXTURE_CLOCK, stations, systems, observations, revisions },
    [world],
  );
  const [totalsBasis, setTotalsBasis] = useState<'raw' | 'best-available'>('best-available');

  const overview = useMemo(() => statewideOverview(fixtureWorld), [fixtureWorld]);
  const scoped = useMemo(
    () =>
      selectedSystemId === null
        ? overview.statewide
        : summaryIndicators(fixtureWorld, { systemId: selectedSystemId }),
    [overview, fixtureWorld, selectedSystemId],
  );
  const totalsWindow = useMemo(() => defaultTotalsWindow(fixtureWorld.asOf), [fixtureWorld.asOf]);
  const totals = useMemo(
    () =>
      areaTotals(fixtureWorld, {
        area: selectedSystemId === null ? 'statewide' : { systemId: selectedSystemId },
        start: totalsWindow.start,
        end: totalsWindow.end,
        basis: totalsBasis,
        visibility: 'public',
      }),
    [fixtureWorld, selectedSystemId, totalsBasis, totalsWindow],
  );

  const scopeEmpty = scoped.telemetry.denominator === 0;

  return (
    <section className="public-overview" aria-label="Public overview and policy summary">
      <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Utah water measurement overview</h2>
      <p style={MUTED}>
        Fixture world {FIXTURE_SEED} · data as of {fixtureWorld.asOf} · all numbers below state their numerator, denominator, period, update time and exclusions.
      </p>

      {status === 'loading' && (
        <p role="status" aria-busy="true">
          Loading the overview summaries…
        </p>
      )}
      {status === 'error' && (
        <div role="alert">
          <p>{errorMessage ?? 'The overview summaries could not be loaded.'}</p>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {status === 'stale' && (
        <p role="status">
          Stale data notice: these summaries were computed as of {fixtureWorld.asOf} and may lag current conditions. Missing readings stay missing; nothing is filled in.
        </p>
      )}

      {status !== 'loading' && status !== 'error' && (
        <>
          <p className="overview-lead" style={{ fontSize: 15, margin: '8px 0 10px' }}>
            {plainLanguageSummary(overview.statewide)}
          </p>
          <p style={MUTED}>
            Output measures describe the measurement program’s own work (telemetry, review, source classification); outcome context (the volume
            totals further down) describes the water itself and always carries its coverage and accounting caveats.
          </p>

          <div className="indicator-grid">
            <IndicatorCard indicator={overview.statewide.telemetry} />
            <IndicatorCard indicator={overview.statewide.reviewed} />
            <ClassificationCard indicator={overview.statewide.measuredVersusEstimated} />
          </div>

          {onOpenDataDictionary ? (
            <p>
              <button type="button" onClick={onOpenDataDictionary} className="dictionary-link">
                Open the data dictionary (definitions of fields, units, processing levels, qualifiers and lineage)
              </button>
            </p>
          ) : (
            <p>
              <a href="#data-dictionary">Data dictionary: definitions of fields, units, processing levels, qualifiers and lineage</a>
            </p>
          )}

          <fieldset style={{ border: '1px solid #dfe3da', borderRadius: 8, margin: '12px 0', padding: '8px 12px' }}>
            <legend style={{ fontSize: 13, fontWeight: 600 }}>Selected system drill-down</legend>
            <div role="radiogroup" aria-label="Summary scope" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <label>
                <input
                  type="radio"
                  name="overview-scope"
                  checked={selectedSystemId === null}
                  onChange={() => onSelectSystem?.(null)}
                />{' '}
                Statewide
              </label>
              {overview.systems.map((system) => (
                <label key={system.systemId}>
                  <input
                    type="radio"
                    name="overview-scope"
                    checked={selectedSystemId === system.systemId}
                    onChange={() => onSelectSystem?.(system.systemId)}
                  />{' '}
                  {system.systemName}
                </label>
              ))}
            </div>

            <h3 style={{ fontSize: 15, margin: '10px 0 6px' }}>
              {scoped.scope.kind === 'statewide' ? 'Statewide indicators' : `Indicators for ${scoped.scope.systemName}`}
            </h3>
            {scopeEmpty ? (
              <p role="status">
                No active measurement stations in this scope: the indicators are not available (not zero), and no totals are fabricated.
              </p>
            ) : (
              <div className="indicator-grid">
                <IndicatorCard indicator={scoped.telemetry} />
                <IndicatorCard indicator={scoped.reviewed} />
                <ClassificationCard indicator={scoped.measuredVersusEstimated} />
              </div>
            )}

            <div style={{ margin: '10px 0 6px' }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>
                Totals processing basis{' '}
                <select
                  value={totalsBasis}
                  onChange={(event) => setTotalsBasis(event.target.value as 'raw' | 'best-available')}
                >
                  <option value="raw">Raw</option>
                  <option value="best-available">Best available</option>
                </select>
              </label>
            </div>

            {totals.outcome === 'allowed' ? (
              <>
                <SummaryCharts indicator={scoped.measuredVersusEstimated} totals={totals.value} />
                <h4 style={{ fontSize: 13, margin: '10px 0 4px' }}>Per-category totals ({totals.value.basis} basis, acre-feet)</h4>
                {totals.value.categories.length === 0 ? (
                  <p role="status">No included flow streams in this scope and window; nothing is summed.</p>
                ) : (
                  <table className="summary-table">
                    <caption className="sr-only">Space and time totals by accounting category with coverage</caption>
                    <thead>
                      <tr>
                        <th scope="col">Accounting category</th>
                        <th scope="col">Volume (acre-feet)</th>
                        <th scope="col">Coverage</th>
                        <th scope="col">Estimated share</th>
                        <th scope="col">Streams</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.value.categories.map((category) => (
                        <tr key={category.category}>
                          <th scope="row">{category.label}</th>
                          <td>{category.volumeAcreFeet.toFixed(2)}</td>
                          <td>{Math.round(category.coverageFraction * 100)}% of window time</td>
                          <td>{Math.round(category.estimatedProportion * 100)}%</td>
                          <td>{category.streamIds.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <details className="stream-exclusions">
                  <summary style={{ fontSize: 12, cursor: 'pointer' }}>
                    Streams excluded from these totals ({totals.value.streams.filter((stream) => !stream.included).length})
                  </summary>
                  <ul style={{ margin: '4px 0 0' }}>
                    {totals.value.streams
                      .filter((stream) => !stream.included)
                      .map((stream) => (
                        <li key={stream.streamId} style={EXCLUSION_STYLE}>
                          <code>{stream.streamId}</code> ({stream.stationDisplayName}): {stream.exclusionReason}
                        </li>
                      ))}
                  </ul>
                </details>
              </>
            ) : (
              <p role="alert">Totals unavailable: {totals.message}</p>
            )}
          </fieldset>
        </>
      )}
    </section>
  );
}

export default PublicOverview;
