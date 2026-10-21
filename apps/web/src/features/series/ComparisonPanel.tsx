import { useMemo, useState } from 'react';
import type { SeriesPoint } from '../../shell/data/observations';
import { streamSeries as loadStreamSeries, streamGaps as shellStreamGaps } from '../../shell/data/observations';
import { revisions as fixtureRevisions, stations } from '../../shell/data/fixtures';
import {
  dailySummaries,
  localDayKeys,
  selectAtBasis,
  type GapBandLike,
  type ProcessingBasis,
  type RevisionLike,
  type StreamLike,
} from './derivation';

/**
 * Multi-site / multi-year comparison panel (WD-008; FR-007): aligned daily
 * intervals in common units, one line per series with distinct color AND
 * shape, gaps that stay visible as line breaks plus per-series source and
 * quality legend, and an aligned table alternative with the same values.
 *
 * Default data comes from the WD-006 shell loaders; streams with
 * incompatible units are refused with a visible explanation instead of a
 * silent conversion (FR-061), mirroring the API's typed INCOMPATIBLE_UNITS
 * denial in services/api/src/series/compare.ts.
 */
export interface ComparisonSelection {
  streamId: string;
  /** Display label override; defaults to "<station name> (<stream id>)". */
  label?: string;
}

export interface ComparisonPanelProps {
  selections?: readonly ComparisonSelection[];
  start?: string;
  end?: string;
  basis?: ProcessingBasis;
}

interface SeriesModel {
  label: string;
  sourceLabel: string;
  unitId: string;
  color: string;
  shape: 'circle' | 'square' | 'triangle';
  byDay: Map<string, { mean: number | null; coverage: number; estimatedShare: number; gapHours: number }>;
  gaps: readonly GapBandLike[];
}

const SERIES_STYLE = [
  { color: '#16887e', shape: 'circle' as const },
  { color: '#c87535', shape: 'square' as const },
  { color: '#7d5ba6', shape: 'triangle' as const },
];

const DEFAULT_SELECTIONS: readonly ComparisonSelection[] = [
  { streamId: 'str-corinne-q' },
  { streamId: 'str-hyrum-q-public' },
];

function streamLike(streamId: string): { stream: StreamLike; stationName: string } | null {
  const station = stations.find((entry) => entry.datastreams.some((candidate) => candidate.id === streamId));
  const stream = station?.datastreams.find((candidate) => candidate.id === streamId);
  if (!station || !stream) return null;
  return {
    stream: {
      id: stream.id,
      unitId: stream.unitId,
      cadenceMinutes: stream.cadenceMinutes,
      validRangeMin: stream.validRangeMin,
      validRangeMax: stream.validRangeMax,
      timeZone: stream.timeZone,
    },
    stationName: station.displayName,
  };
}

function formatMean(value: number | null, unit: string): string {
  return value === null ? 'Unavailable' : `${value.toFixed(2)} ${unit}`;
}

export default function ComparisonPanel({
  selections = DEFAULT_SELECTIONS,
  start = '2026-03-06T07:00:00.000Z',
  end = '2026-03-09T06:00:00.000Z',
  basis = 'raw',
}: ComparisonPanelProps) {
  const [showTable, setShowTable] = useState(true);

  const model = useMemo(() => {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    const dayKeys = localDayKeys(startMs, endMs);
    const series: SeriesModel[] = [];
    let commonUnit: string | null = null;
    let incompatible: string | null = null;
    for (const [index, selection] of selections.entries()) {
      const resolved = streamLike(selection.streamId);
      if (!resolved) continue;
      if (commonUnit === null) commonUnit = resolved.stream.unitId;
      else if (resolved.stream.unitId !== commonUnit) {
        incompatible = `Cannot compare ${resolved.stream.unitId} with ${commonUnit}: common units are required (no silent conversion).`;
        break;
      }
      const points: readonly SeriesPoint[] = loadStreamSeries(selection.streamId).filter((point) => {
        const at = Date.parse(point.observedAt);
        return at >= startMs - resolved.stream.cadenceMinutes * 60_000 && at < endMs;
      });
      const revisions = fixtureRevisions;
      const selected = selectAtBasis(points, revisions as readonly RevisionLike[], basis, resolved.stream);
      const gaps: GapBandLike[] = shellStreamGaps(selection.streamId).map((gap) => ({
        id: gap.id,
        start: gap.start,
        end: gap.end,
        reason: gap.reason,
      }));
      const summaries = dailySummaries(selected.map((entry) => entry.point), resolved.stream, gaps);
      const style = SERIES_STYLE[index % SERIES_STYLE.length]!;
      series.push({
        label: selection.label ?? `${resolved.stationName} (${selection.streamId})`,
        sourceLabel: `${resolved.stationName} — ${resolved.stream.cadenceMinutes >= 1440 ? `manual, ${Math.round(resolved.stream.cadenceMinutes / 1440)}-day cadence` : `telemetry, ${resolved.stream.cadenceMinutes}-minute cadence`} · basis ${basis}`,
        unitId: resolved.stream.unitId,
        color: style.color,
        shape: style.shape,
        byDay: new Map(
          summaries.map((day) => [
            day.key,
            {
              mean: day.meanValue,
              coverage: day.coverageFraction,
              estimatedShare: day.estimatedProportion,
              gapHours: day.gapHours,
            },
          ]),
        ),
        gaps,
      });
    }
    return { dayKeys, series, unit: commonUnit ?? '', incompatible };
  }, [selections, start, end, basis]);

  if (model.incompatible) {
    return (
      <div className="chart-empty" role="alert">
        <p>{model.incompatible}</p>
        <p className="chart-empty-sub">Pick series with the same observed property and unit.</p>
      </div>
    );
  }
  if (model.series.length === 0) {
    return (
      <div className="chart-empty" role="status">
        <p>No comparable series selected.</p>
      </div>
    );
  }

  // Multi-line geometry: x by day index, y over the shared in-range domain.
  const width = 640;
  const height = 210;
  const plot = { left: 46, right: width - 12, top: 14, bottom: 176 };
  const values = model.series.flatMap((entry) => [...entry.byDay.values()].map((day) => day.mean).filter((mean): mean is number => mean !== null));
  const max = Math.max(...values, 1) * 1.15;
  const x = (index: number) => plot.left + (model.dayKeys.length <= 1 ? 0 : (index / (model.dayKeys.length - 1)) * (plot.right - plot.left));
  const y = (value: number) => plot.bottom - (value / max) * (plot.bottom - plot.top);

  const shapePath = (shape: SeriesModel['shape'], cx: number, cy: number) =>
    shape === 'circle'
      ? { kind: 'circle' as const, cx, cy, r: 3.4 }
      : shape === 'square'
        ? { kind: 'rect' as const, x: cx - 3.4, y: cy - 3.4, w: 6.8 }
        : { kind: 'polygon' as const, points: `${cx},${cy - 4.5} ${cx - 4},${cy + 3} ${cx + 4},${cy + 3}` };

  return (
    <div className="panel" data-feature="series-comparison">
      <div className="panel-heading">
        <h2>Site comparison</h2>
        <span>
          Aligned local days · America/Denver · common unit {model.unit} · basis {basis}
        </span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily mean comparison of ${model.series.map((entry) => entry.label).join(' and ')} in ${model.unit}; gaps stay visible as breaks; exact values follow in the table`}>
          {[0, 1, 2, 3].map((i) => {
            const value = (max * i) / 3;
            const gy = y(value);
            return (
              <g key={i}>
                <line x1={plot.left} x2={plot.right} y1={gy} y2={gy} stroke="#e8ecea" strokeDasharray="4 5" />
                <text x={plot.left - 6} y={gy + 4} textAnchor="end" className="chart-label">
                  {value.toFixed(0)}
                </text>
              </g>
            );
          })}
          {model.series.map((entry) => {
            // Line breaks at null days: a segment only continues across days
            // that both have values (visible gaps, no interpolation).
            const segments: string[] = [];
            let current: string[] = [];
            model.dayKeys.forEach((key, index) => {
              const day = entry.byDay.get(key);
              const mean = day?.mean ?? null;
              if (mean === null) {
                if (current.length > 1) segments.push(current.join(' '));
                current = [];
              } else {
                current.push(`${current.length === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(mean).toFixed(1)}`);
              }
            });
            if (current.length > 1) segments.push(current.join(' '));
            return (
              <g key={entry.label}>
                {segments.map((segment, i) => (
                  <path key={i} d={segment} fill="none" stroke={entry.color} strokeWidth={2.2} />
                ))}
                {model.dayKeys.map((key, index) => {
                  const day = entry.byDay.get(key);
                  if (!day || day.mean === null) return null;
                  const cx = x(index);
                  const cy = y(day.mean);
                  const shape = shapePath(entry.shape, cx, cy);
                  return shape.kind === 'circle' ? (
                    <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} fill={entry.color} stroke="white" strokeWidth={1.2} />
                  ) : shape.kind === 'rect' ? (
                    <rect key={key} x={shape.x} y={shape.y} width={shape.w} height={shape.w} fill={entry.color} stroke="white" strokeWidth={1.2} />
                  ) : (
                    <polygon key={key} points={shape.points} fill={entry.color} stroke="white" strokeWidth={1.2} />
                  );
                })}
              </g>
            );
          })}
          {model.dayKeys.map((key, index) => (
            <text key={key} x={x(index)} y={height - 6} textAnchor="middle" className="chart-label">
              {key.slice(5)}
            </text>
          ))}
        </svg>

        <ul style={{ listStyle: 'none', margin: '6px 0 10px', padding: 0, fontSize: 10 }} aria-label="Per-series source and quality legend">
          {model.series.map((entry) => (
            <li key={entry.label} style={{ margin: '2px 0' }}>
              <span aria-hidden style={{ color: entry.color, marginRight: 4, fontWeight: 700 }}>
                {entry.shape === 'circle' ? '●' : entry.shape === 'square' ? '■' : '▲'}
              </span>
              <strong>{entry.label}</strong> — {entry.sourceLabel}
              {entry.gaps.length > 0
                ? ` · ${entry.gaps.length} declared gap${entry.gaps.length > 1 ? 's' : ''} (${Math.round(
                    entry.gaps.reduce((hours, gap) => hours + (Date.parse(gap.end) - Date.parse(gap.start)) / 3_600_000, 0),
                  )} h, no data, not zero)`
                : ' · no declared gaps'}
            </li>
          ))}
        </ul>

        <button type="button" className="button small" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
          {showTable ? 'Hide aligned table' : 'Show aligned table'}
        </button>
        {showTable ? (
          <div className="obs-table-wrap">
            <table className="obs-table" style={{ fontSize: 10 }}>
              <caption className="sr-only">Aligned daily means and coverage per series; Unavailable marks a visible gap, never zero</caption>
              <thead>
                <tr>
                  <th scope="col">Local day</th>
                  {model.series.map((entry) => (
                    <th key={entry.label} scope="col">
                      {entry.label} — mean ({entry.unitId}) · coverage
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.dayKeys.map((key) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    {model.series.map((entry) => {
                      const day = entry.byDay.get(key);
                      return (
                        <td key={entry.label} className={day?.mean != null ? 'numeric' : undefined}>
                          {formatMean(day?.mean ?? null, entry.unitId)}
                          {day && day.mean !== null ? ` · ${Math.round(day.coverage * 100)}%${day.estimatedShare > 0 ? ` (${Math.round(day.estimatedShare * 100)}% est.)` : ''}` : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
