import { useMemo, useState } from 'react';
import Chart from '../../components/Chart';
import ObservationTable from '../../components/ObservationTable';
import type { SeriesPoint } from '../../shell/data/observations';
import { streamSeries as loadStreamSeries, streamGaps as shellStreamGaps } from '../../shell/data/observations';
import { FIXTURE_TIME_ZONE, revisions as fixtureRevisions, stations } from '../../shell/data/fixtures';
import {
  SERIES_LEGEND,
  coverageAnnotation,
  dailySummaries,
  selectAtBasis,
  type GapBandLike,
  type ProcessingBasis,
  type RevisionLike,
  type SelectedPoint,
  type StreamLike,
} from './derivation';

/**
 * Site-detail series panel (WD-008; FR-005, FR-006, FR-062, FR-066):
 * the accessible chart lineage (components/Chart, read-only reuse) with a
 * processing-level selector, daily coverage/estimated annotations with
 * zero-based coverage bars, a text+shape quality legend, and the
 * ObservationTable alternative carrying the SAME selected values.
 *
 * Default data comes from the WD-006 shell loaders (frozen contract
 * fixtures); every piece is overridable so an API-backed loader can replace
 * the fixtures without touching this component.
 */
export interface SeriesChartData {
  points: readonly SeriesPoint[];
  revisions: readonly RevisionLike[];
  stream: StreamLike;
  gaps: readonly GapBandLike[];
  stationName: string;
  unitId: string;
}

export interface SeriesChartProps {
  streamId: string;
  initialBasis?: ProcessingBasis;
  status?: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  onRetry?: () => void;
  data?: SeriesChartData;
}

const BASIS_OPTIONS: ReadonlyArray<{ value: ProcessingBasis; label: string }> = [
  { value: 'raw', label: 'Raw' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'best-available', label: 'Best available' },
];

function fixtureData(streamId: string): SeriesChartData | null {
  const stream = stations.flatMap((station) => station.datastreams).find((entry) => entry.id === streamId);
  const station = stations.find((entry) => entry.datastreams.some((candidate) => candidate.id === streamId));
  if (!stream || !station) return null;
  return {
    points: loadStreamSeries(streamId),
    revisions: fixtureRevisions as readonly RevisionLike[],
    stream: {
      id: stream.id,
      unitId: stream.unitId,
      cadenceMinutes: stream.cadenceMinutes,
      validRangeMin: stream.validRangeMin,
      validRangeMax: stream.validRangeMax,
      timeZone: stream.timeZone,
    },
    gaps: shellStreamGaps(streamId).map((gap) => ({ id: gap.id, start: gap.start, end: gap.end, reason: gap.reason })),
    stationName: station.displayName,
    unitId: stream.unitId,
  };
}

export default function SeriesChart({
  streamId,
  initialBasis = 'best-available',
  status = 'ready',
  errorMessage,
  onRetry,
  data,
}: SeriesChartProps) {
  const [basis, setBasis] = useState<ProcessingBasis>(initialBasis);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(true);

  const resolved = useMemo(() => data ?? fixtureData(streamId), [data, streamId]);

  const selected = useMemo<SelectedPoint[]>(
    () => (resolved ? selectAtBasis(resolved.points, resolved.revisions, basis, resolved.stream) : []),
    [resolved, basis],
  );
  const chartPoints = useMemo<SeriesPoint[]>(() => selected.map((entry) => entry.point as SeriesPoint), [selected]);
  const summaries = useMemo(
    () => (resolved ? dailySummaries(chartPoints, resolved.stream, resolved.gaps) : []),
    [chartPoints, resolved],
  );

  if (status === 'loading') {
    return (
      <div className="chart-empty" role="status">
        <p>Loading series…</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="chart-empty" role="alert">
        <p>{errorMessage ?? 'The series could not be loaded.'}</p>
        {onRetry ? (
          <button type="button" className="button small" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (!resolved) {
    return (
      <div className="chart-empty" role="status">
        <p>No series found for {streamId}.</p>
      </div>
    );
  }
  if (chartPoints.length === 0) {
    return (
      <div className="chart-empty" role="status">
        <p>No observations in this window.</p>
        <p className="chart-empty-sub">Missing readings stay missing; nothing is synthesized or zero-filled.</p>
      </div>
    );
  }

  const emphasis = basis === 'raw' ? 'raw' : 'best';
  const maxCoverage = 1; // coverage bars are zero-based by construction: 0% .. 100% of full coverage

  return (
    <div className="panel" data-feature="series-chart">
      <div className="panel-heading">
        <h2>Discharge series — {resolved.stationName}</h2>
        <span>
          {resolved.stream.cadenceMinutes >= 1440
            ? `Manual readings · ${Math.round(resolved.stream.cadenceMinutes / 1440)}-day cadence`
            : `Telemetry · ${resolved.stream.cadenceMinutes}-minute cadence`}{' '}
          · {FIXTURE_TIME_ZONE} · {resolved.unitId}
        </span>
        <div className="segmented" role="group" aria-label="Processing level">
          {BASIS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={basis === option.value}
              className={basis === option.value ? 'active' : undefined}
              onClick={() => {
                setBasis(option.value);
                setSelectedIndex(null);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '12px 16px' }}>
        <Chart
          points={chartPoints}
          gapBands={resolved.gaps.map((gap) => ({ start: gap.start, end: gap.end, reason: gap.reason }))}
          unitId={resolved.unitId}
          stationName={resolved.stationName}
          emphasis={emphasis}
          selectedIndex={selectedIndex}
          onSelectIndex={setSelectedIndex}
        />

        <p style={{ margin: '6px 0 2px', fontSize: 10, color: '#5f7268' }}>
          Processing basis shown: <strong>{BASIS_OPTIONS.find((option) => option.value === basis)?.label}</strong>. Raw
          values always stay visible as the dashed line; corrections never overwrite them.
        </p>

        <ul
          style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '4px 14px', margin: '4px 0 8px', padding: 0, fontSize: 10 }}
          aria-label="Quality legend (shape and text)"
        >
          {SERIES_LEGEND.map((item) => (
            <li key={item.label}>
              <span aria-hidden style={{ marginRight: 4 }}>
                {item.shape}
              </span>
              {item.label}
            </li>
          ))}
        </ul>

        <section aria-label="Daily coverage and estimated share">
          <h3 style={{ fontSize: 11, margin: '8px 0 4px' }}>Daily coverage (zero-based scale, {maxCoverage * 100}% = full day)</h3>
          <table className="obs-table" style={{ fontSize: 10 }}>
            <caption className="sr-only">Coverage, estimated share and volume per local day; gaps are holes, never zeros</caption>
            <thead>
              <tr>
                <th scope="col">Local day</th>
                <th scope="col">Coverage</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((day) => (
                <tr key={day.key}>
                  <th scope="row">{day.key}</th>
                  <td style={{ minWidth: 140 }}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: `${Math.round(day.coverageFraction * 100)}%`,
                        maxWidth: 100,
                        minWidth: 1,
                        height: 8,
                        background: day.coverageFraction === 0 ? 'transparent' : '#4c8561',
                        border: '1px solid #c9d6c9',
                        verticalAlign: 'middle',
                      }}
                    />
                    {day.gapHours > 0 ? <span aria-hidden>▨</span> : null}
                  </td>
                  <td>
                    {coverageAnnotation(day)}
                    {day.volumeAcreFeet !== null ? ` · ${day.volumeAcreFeet.toFixed(2)} acre-feet` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div style={{ margin: '10px 0 6px' }}>
          <button type="button" className="button small" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
            {showTable ? 'Hide table alternative' : 'Show table alternative'}
          </button>
        </div>
        {showTable ? (
          <ObservationTable points={chartPoints} unitId={resolved.unitId} selectedIndex={selectedIndex} onSelectIndex={setSelectedIndex} />
        ) : null}

        <p style={{ fontSize: 10, color: '#5f7268', margin: '8px 0 0' }}>
          Select a point on the chart or a table row to inspect it. The table alternative always carries the same
          selected values as the chart (FR-062); missing readings read “Unavailable”, never 0.
        </p>
      </div>
    </div>
  );
}
