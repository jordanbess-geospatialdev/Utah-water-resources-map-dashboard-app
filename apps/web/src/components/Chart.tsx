import { useMemo } from 'react';
import type { SeriesPoint } from '../shell/data/observations';
import { FIXTURE_TIME_ZONE } from '../shell/data/fixtures';

/**
 * Bounded time-series chart, ported from the validated prototype's Chart.tsx
 * and adapted to the contract observation world.
 *
 * Accessibility and data-honesty rules (FR-004, FR-005, FR-062):
 * - Keyboard-accessible values: every point is focusable and carries its full
 *   value, raw-versus-best distinction and flags in the accessible label.
 * - Missing readings are never zero: null frames draw a "no value" marker and
 *   format as "Unavailable"; declared gaps break the line (no visual
 *   interpolation across the outage).
 * - Out-of-range and negative values are labelled at the plot edge with the
 *   true value in the label, never silently clipped.
 * - The data table alternative (ObservationTable) shares these exact
 *   formatting helpers, so both surfaces show the same selected values.
 */
export interface GapBand {
  start: string;
  end: string;
  reason: string;
}

export interface ChartProps {
  points: SeriesPoint[];
  gapBands: GapBand[];
  unitId: string;
  stationName: string;
  emphasis: 'best' | 'raw';
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
}

const PLOT = { left: 42, right: 596, top: 14, bottom: 168 };
const DST_TRANSITION = '2026-03-08T09:00:00Z';

/** Shared formatting: the chart and the table alternative must show identical values. */
export function formatFlow(value: number | null, unitId: string): string {
  return value === null ? 'Unavailable' : `${value.toFixed(1)} ${unitId}`;
}

export function formatTimeMT(at: string): string {
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: FIXTURE_TIME_ZONE });
}

export function formatDateMT(at: string): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: FIXTURE_TIME_ZONE });
}

function markerKind(point: SeriesPoint): 'out-of-range' | 'negative' | 'estimated' | 'revised' | 'plain' {
  if (point.flags.includes('out-of-range')) return 'out-of-range';
  if (point.flags.includes('negative')) return 'negative';
  if (point.flags.includes('estimated')) return 'estimated';
  if (point.flags.includes('revised')) return 'revised';
  return 'plain';
}

export default function Chart({ points, gapBands, unitId, stationName, emphasis, selectedIndex, onSelectIndex }: ChartProps) {
  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const t0 = Date.parse(points[0]!.observedAt);
    const t1 = Date.parse(points.at(-1)!.observedAt);
    const span = Math.max(t1 - t0, 1);
    const x = (at: string) => PLOT.left + ((Date.parse(at) - t0) / span) * (PLOT.right - PLOT.left);

    // Domain from in-range values only; out-of-range and negative points are edge-labelled.
    const domainValues: number[] = [];
    for (const point of points) {
      if (point.raw !== null && !point.flags.includes('out-of-range') && !point.flags.includes('negative')) domainValues.push(point.raw);
      if (point.best !== null && !point.flags.includes('out-of-range') && point.best >= 0) domainValues.push(point.best);
    }
    const domainSource = domainValues.length > 0 ? domainValues : [0];
    const rawMax = Math.max(...domainSource);
    const rawMin = Math.min(...domainSource);
    const max = rawMax * 1.18;
    const min = Math.min(rawMin * 0.72, rawMin - (rawMax - rawMin) * 0.1);
    const range = Math.max(max - min, 1);
    const yRaw = (value: number) => PLOT.bottom - ((value - min) / range) * (PLOT.bottom - PLOT.top);
    const y = (value: number) => Math.min(Math.max(yRaw(value), PLOT.top), PLOT.bottom);

    // Paths break at null values and across declared gaps (no interpolation).
    const buildPath = (pick: (point: SeriesPoint) => number | null) => {
      const segments: string[] = [];
      let current: string[] = [];
      let previousAt: string | null = null;
      points.forEach((point) => {
        const value = pick(point);
        const breaks = previousAt !== null && crossesGap(previousAt, point.observedAt, gapBands);
        if (value === null || breaks) {
          if (current.length > 1) segments.push(current.join(' '));
          current = [];
        }
        if (value !== null) {
          current.push(`${current.length === 0 ? 'M' : 'L'}${x(point.observedAt).toFixed(1)},${y(value).toFixed(1)}`);
        }
        previousAt = point.observedAt;
      });
      if (current.length > 1) segments.push(current.join(' '));
      return segments;
    };

    return {
      x,
      y,
      min,
      max,
      bestSegments: buildPath((point) => point.best),
      rawSegments: buildPath((point) => point.raw),
      nullPoints: points.map((point, index) => ({ point, index })).filter((entry) => entry.point.raw === null && entry.point.best === null),
      windowClippedGaps: gapBands
        .map((band) => ({ band, x0: x(band.start < points[0]!.observedAt ? points[0]!.observedAt : band.start), x1: x(band.end > points.at(-1)!.observedAt ? points.at(-1)!.observedAt : band.end) }))
        .filter((entry) => entry.x1 - entry.x0 > 2),
      dstX: t0 < Date.parse(DST_TRANSITION) && t1 > Date.parse(DST_TRANSITION) ? x(DST_TRANSITION) : null,
      tickIndices: [0, Math.floor(points.length / 2), points.length - 1],
    };
  }, [points, gapBands]);

  if (points.length === 0 || geometry === null) {
    return (
      <div className="chart-empty" role="status">
        <p>No observations in this window.</p>
        <p className="chart-empty-sub">Missing readings stay missing; nothing is synthesized or zero-filled.</p>
      </div>
    );
  }

  const viewed = selectedIndex === null ? null : points[selectedIndex] ?? null;
  const emphasised = emphasis === 'best';

  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 620 205"
        role="group"
        aria-label={`Raw and best available discharge for ${stationName}; ${points.length} points in window; select a point for its value and flags`}
      >
        <defs>
          <pattern id="gap-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#b9b1a0" strokeWidth="1.4" />
          </pattern>
        </defs>
        {[0, 1, 2, 3].map((i) => {
          const value = geometry.min + ((geometry.max - geometry.min) * i) / 3;
          const gy = geometry.y(value);
          return (
            <g key={i}>
              <line x1={PLOT.left} x2={PLOT.right} y1={gy} y2={gy} stroke="#e8ecea" strokeDasharray="4 5" />
              <text x={PLOT.left - 8} y={gy + 4} textAnchor="end" className="chart-label">
                {value.toFixed(0)}
              </text>
            </g>
          );
        })}
        {geometry.windowClippedGaps.map((entry) => (
          <g key={`${entry.band.start}-gap`}>
            <rect x={entry.x0} y={PLOT.top} width={entry.x1 - entry.x0} height={PLOT.bottom - PLOT.top} fill="url(#gap-hatch)" opacity="0.5" />
            <text x={(entry.x0 + entry.x1) / 2} y={PLOT.top + 12} textAnchor="middle" className="chart-label gap-label">
              declared gap
            </text>
          </g>
        ))}
        {geometry.dstX !== null && (
          <g>
            <line x1={geometry.dstX} x2={geometry.dstX} y1={PLOT.top} y2={PLOT.bottom} stroke="#9db8ae" strokeDasharray="2 4" />
            <text x={geometry.dstX + 4} y={PLOT.bottom - 6} className="chart-label">
              MST→MDT
            </text>
          </g>
        )}
        {/* Draw only the segmented lines: a plot-wide area fill would imply
            values across declared gaps and after the first segment ends. */}
        {geometry.rawSegments.map((segment, i) => (
          <path key={`raw-${i}`} d={segment} fill="none" stroke="#b1b8bb" strokeWidth={emphasised ? 1.8 : 2.4} strokeDasharray="4 4" opacity={emphasised ? 0.9 : 1} />
        ))}
        {geometry.bestSegments.map((segment, i) => (
          <path key={`best-${i}`} d={segment} fill="none" stroke="#16887e" strokeWidth={emphasised ? 2.6 : 2} />
        ))}
        {geometry.nullPoints.map((entry) => (
          <text key={entry.point.id} x={geometry.x(entry.point.observedAt)} y={PLOT.bottom - 3} textAnchor="middle" className="chart-null">
            ∅
          </text>
        ))}
        {points.map((point, index) => {
          const value = point.best ?? point.raw;
          if (value === null) return null;
          const cx = geometry.x(point.observedAt);
          const cy = geometry.y(value);
          const kind = markerKind(point);
          const selected = selectedIndex === index;
          const label = `${formatTimeMT(point.observedAt)} MT: best available ${formatFlow(point.best, unitId)}, raw ${formatFlow(point.raw, unitId)}${
            point.flags.length > 0 ? `; flags: ${point.flags.join(', ')}` : ''
          }. ${selected ? 'Selected.' : 'Select point.'}`;
          return (
            <g
              key={point.id}
              tabIndex={0}
              role="button"
              aria-label={label}
              className={`chart-point${selected ? ' selected' : ''}`}
              onClick={() => onSelectIndex(selected ? null : index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectIndex(selected ? null : index);
                }
              }}
            >
              <circle cx={cx} cy={cy} r="11" fill="transparent" />
              {kind === 'out-of-range' || kind === 'negative' ? (
                <polygon
                  points={kind === 'out-of-range' ? `${cx},${cy - 7} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}` : `${cx},${cy + 7} ${cx - 6},${cy - 4} ${cx + 6},${cy - 4}`}
                  fill={kind === 'out-of-range' ? '#c65c50' : '#7d5ba6'}
                  stroke="white"
                  strokeWidth="1.2"
                />
              ) : kind === 'estimated' ? (
                <rect x={cx - 4} y={cy - 4} width="8" height="8" transform={`rotate(45 ${cx} ${cy})`} fill="#c98a2d" stroke="white" strokeWidth="1.2" />
              ) : (
                <circle cx={cx} cy={cy} r={selected ? 5 : 3.2} fill={selected ? '#c87535' : kind === 'revised' ? '#0f6b62' : '#16887e'} stroke="white" strokeWidth="1.5" />
              )}
            </g>
          );
        })}
        {geometry.tickIndices.map((index) => (
          <text key={`tick-${index}`} x={geometry.x(points[index]!.observedAt)} y="196" textAnchor="middle" className="chart-label">
            {formatDateMT(points[index]!.observedAt)}
          </text>
        ))}
      </svg>
      <div className="chart-foot">
        <div className="chart-legend">
          <span>
            <i className="best" aria-hidden /> Best available
          </span>
          <span>
            <i className="raw" aria-hidden /> Raw observation
          </span>
          <span>
            <i className="edge" aria-hidden /> ▲ out of range · ≈ estimated · ∅ no value
          </span>
        </div>
        <span>Mountain Time · {unitId}</span>
      </div>
      {viewed && (
        <div className="point-info" role="status">
          <strong>{formatTimeMT(viewed.observedAt)} MT</strong>
          <span>
            {' '}
            Raw {formatFlow(viewed.raw, unitId)} · Best {formatFlow(viewed.best, unitId)}
          </span>
          <p>
            {viewed.processingLevel === 'raw'
              ? 'Original raw observation; no revision recorded.'
              : `Best available from ${viewed.processingLevel} revision${viewed.revisionIds.length > 1 ? 's' : ''} ${viewed.revisionIds.join(', ')}; the raw value is preserved.`}
            {viewed.flags.length > 0 ? ` Flags: ${viewed.flags.join(', ')}.` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

function crossesGap(fromAt: string, toAt: string, bands: GapBand[]): boolean {
  const from = Date.parse(fromAt);
  const to = Date.parse(toAt);
  return bands.some((band) => Date.parse(band.start) < to && Date.parse(band.end) > from);
}
