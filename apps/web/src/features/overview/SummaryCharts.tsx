/**
 * SummaryCharts - the FR-061/FR-062 visualization block of the public
 * overview: a zero-based bar chart of the measured/estimated/unknown source
 * classification and a zero-based daily-volume line chart per accounting
 * category, each with an accessible data table carrying the SAME selected
 * values beside it (never color alone: every series also has a shape glyph
 * and a text label, and every value is keyboard reachable with its full
 * context in the aria-label).
 *
 * Lineage: follows components/Chart.tsx (focusable points, gap hatching,
 * shared formatting) and components/ObservationTable.tsx (table parity),
 * restricted to summary aggregates.
 */
import { useMemo } from 'react';
import {
  classificationBars,
  volumeSeries,
  type AreaTotals,
  type MeasuredVersusEstimatedIndicator,
  type SourceClassification,
} from './derivation';

export interface SummaryChartsProps {
  /** The measured-vs-estimated indicator whose buckets feed the bar chart. */
  readonly indicator: MeasuredVersusEstimatedIndicator;
  /** The area totals whose categories and daily values feed the line chart and tables. */
  readonly totals: AreaTotals;
}

const CLASSIFICATION_COLORS: Readonly<Record<SourceClassification, string>> = {
  measured: '#16887e',
  estimated: '#c98a2d',
  unknown: '#7d5ba6',
};

const BAR_PLOT = { left: 46, top: 26, bottom: 168, width: 300 };
const LINE_PLOT = { left: 52, right: 612, top: 22, bottom: 172 };

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatVolume(value: number | null): string {
  return value === null ? 'No data' : `${value.toFixed(2)} acre-feet`;
}

function formatPercent(fraction: number | null): string {
  return fraction === null ? 'n/a' : `${Math.round(fraction * 100)}%`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function ClassificationChart({ indicator }: { indicator: MeasuredVersusEstimatedIndicator }) {
  const bars = useMemo(() => classificationBars(indicator), [indicator]);
  if (bars.length === 0 || indicator.denominator === 0) {
    return (
      <p role="status" className="chart-empty-note">
        No reported readings in this scope for the classification chart.
      </p>
    );
  }
  const axisMax = niceMax(Math.max(...bars.map((bar) => bar.value)));
  const slot = (BAR_PLOT.width - BAR_PLOT.left) / bars.length;
  const yOf = (value: number) => BAR_PLOT.bottom - (value / axisMax) * (BAR_PLOT.bottom - BAR_PLOT.top);

  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={`Bar chart of source classification: ${bars
      .map((bar) => `${bar.shortLabel} ${bar.value} of ${bar.denominator}`)
      .join('; ')}. Zero-based axis in ${indicator.unit}.`}>
      {[0, 0.5, 1].map((tick) => {
        const value = axisMax * tick;
        const y = yOf(value);
        return (
          <g key={tick}>
            <line x1={BAR_PLOT.left} x2={BAR_PLOT.width} y1={y} y2={y} stroke="#e4e7e0" strokeDasharray="4 5" />
            <text x={BAR_PLOT.left - 6} y={y + 4} textAnchor="end" className="chart-label">
              {formatCount(Math.round(value))}
            </text>
          </g>
        );
      })}
      <text x={10} y={14} className="chart-label">readings</text>
      <line x1={BAR_PLOT.left} x2={BAR_PLOT.width} y1={BAR_PLOT.bottom} y2={BAR_PLOT.bottom} stroke="#8a9388" />
      <text x={BAR_PLOT.left - 6} y={BAR_PLOT.bottom + 4} textAnchor="end" className="chart-label">0</text>
      {bars.map((bar, index) => {
        const centerX = BAR_PLOT.left + slot * (index + 0.5);
        const barWidth = slot * 0.5;
        const barTop = yOf(bar.value);
        return (
          <g
            key={bar.classification}
            tabIndex={0}
            role="button"
            aria-label={bar.ariaLabel}
            className="summary-chart-bar"
          >
            <rect
              x={centerX - barWidth / 2}
              y={barTop}
              width={barWidth}
              height={BAR_PLOT.bottom - barTop}
              fill={CLASSIFICATION_COLORS[bar.classification]}
              stroke="#1c2b26"
              strokeWidth={0.8}
            />
            <text x={centerX} y={barTop - 14} textAnchor="middle" className="chart-shape" aria-hidden>
              {bar.shape}
            </text>
            <text x={centerX} y={barTop - 4} textAnchor="middle" className="chart-label">
              {formatCount(bar.value)}
            </text>
            <text x={centerX} y={BAR_PLOT.bottom + 16} textAnchor="middle" className="chart-label">
              {bar.shortLabel}
            </text>
            <text x={centerX} y={BAR_PLOT.bottom + 28} textAnchor="middle" className="chart-label">
              {formatPercent(bar.fraction)} of {formatCount(bar.denominator)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function VolumeChart({ totals }: { totals: AreaTotals }) {
  const series = useMemo(() => volumeSeries(totals), [totals]);
  if (series.points.length === 0 || series.categories.length === 0) {
    return (
      <p role="status" className="chart-empty-note">
        No included flow streams in this scope and window: no totals are fabricated.
      </p>
    );
  }
  const maxVolume = Math.max(
    0,
    ...series.points.flatMap((point) => point.values.map((value) => value.volumeAcreFeet ?? 0)),
  );
  const axisMax = niceMax(maxVolume);
  const xOf = (index: number) => LINE_PLOT.left + (index / Math.max(series.points.length - 1, 1)) * (LINE_PLOT.right - LINE_PLOT.left);
  const yOf = (value: number) => LINE_PLOT.bottom - (value / axisMax) * (LINE_PLOT.bottom - LINE_PLOT.top);

  return (
    <svg viewBox="0 0 640 200" role="img" aria-label={`Line chart of daily volume in acre-feet by accounting category, ${totals.basis} basis, local days ${series.points[0]!.day} through ${series.points[series.points.length - 1]!.day}. Zero-based axis. Categories: ${series.categories.map((category) => category.label).join('; ')}.`}>
      {[0, 0.5, 1].map((tick) => {
        const value = axisMax * tick;
        const y = yOf(value);
        return (
          <g key={tick}>
            <line x1={LINE_PLOT.left} x2={LINE_PLOT.right} y1={y} y2={y} stroke="#e4e7e0" strokeDasharray="4 5" />
            <text x={LINE_PLOT.left - 6} y={y + 4} textAnchor="end" className="chart-label">
              {value.toFixed(0)}
            </text>
          </g>
        );
      })}
      <text x={8} y={14} className="chart-label">acre-feet</text>
      <line x1={LINE_PLOT.left} x2={LINE_PLOT.right} y1={LINE_PLOT.bottom} y2={LINE_PLOT.bottom} stroke="#8a9388" />
      <text x={LINE_PLOT.left - 6} y={LINE_PLOT.bottom + 4} textAnchor="end" className="chart-label">0</text>
      {series.categories.map((category) => {
        const segments: string[] = [];
        let current: string[] = [];
        series.points.forEach((point, index) => {
          const value = point.values.find((candidate) => candidate.category === category.category)?.volumeAcreFeet ?? null;
          if (value === null) {
            if (current.length > 1) segments.push(current.join(' '));
            current = [];
            return;
          }
          const x = xOf(index);
          const y = yOf(value);
          current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
        });
        if (current.length > 1) segments.push(current.join(' '));
        return (
          <g key={category.category}>
            {segments.map((segment, segmentIndex) => (
              <path key={segmentIndex} d={segment} fill="none" stroke={category.color} strokeWidth={2.2} />
            ))}
          </g>
        );
      })}
      {series.points.map((point, index) => (
        <g key={point.day}>
          {point.values.map((value) => {
            const category = series.categories.find((candidate) => candidate.category === value.category);
            if (!category) return null;
            const cx = xOf(index);
            const cy = value.volumeAcreFeet === null ? LINE_PLOT.bottom - 6 : yOf(value.volumeAcreFeet);
            return (
              <g key={value.category} tabIndex={0} role="button" aria-label={`${point.day}: ${value.ariaLabel}`} className="summary-chart-point">
                <circle cx={cx} cy={cy} r={10} fill="transparent" />
                {value.volumeAcreFeet === null ? (
                  <text x={cx} y={LINE_PLOT.bottom - 2} textAnchor="middle" className="chart-null">
                    ∅
                  </text>
                ) : (
                  <text x={cx} y={cy + 4} textAnchor="middle" fill={category.color} className="chart-shape" aria-hidden>
                    {category.shape}
                  </text>
                )}
              </g>
            );
          })}
          <text x={xOf(index)} y={LINE_PLOT.bottom + 18} textAnchor="middle" className="chart-label">
            {point.day}
          </text>
        </g>
      ))}
      <g>
        {series.categories.map((category, index) => (
          <text key={category.category} x={LINE_PLOT.left + index * 190} y={LINE_PLOT.bottom + 32} className="chart-label">
            {category.shape} {category.label}
          </text>
        ))}
      </g>
    </svg>
  );
}

function DataTable({ caption, headers, rows }: { caption: string; headers: readonly string[]; rows: readonly (readonly string[])[] }) {
  return (
    <table className="summary-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SummaryCharts({ indicator, totals }: SummaryChartsProps) {
  const bars = useMemo(() => classificationBars(indicator), [indicator]);
  const series = useMemo(() => volumeSeries(totals), [totals]);

  const classificationRows = bars.map((bar) => [
    `${bar.shape} ${bar.shortLabel}`,
    `${formatCount(bar.value)} of ${formatCount(bar.denominator)}`,
    formatPercent(bar.fraction),
    bar.classification === 'unknown' ? 'Distinct bucket: null frames and ungoverned value types are never folded into measured or estimated' : '—',
  ]);

  const volumeRows = series.points.map((point) => [
    point.day,
    ...point.values.map((value) =>
      value.volumeAcreFeet === null ? 'No data (never zero)' : `${value.volumeAcreFeet.toFixed(2)} af · ${formatPercent(value.coverageFraction)} covered`,
    ),
  ]);

  return (
    <div className="summary-charts">
      <div className="summary-chart-block">
        <h4>Source classification of reported readings ({indicator.basis} basis)</h4>
        <p className="summary-chart-sub">
          Zero-based axis · readings reported {indicator.period.start} to {indicator.period.end} (end exclusive) · as of {indicator.asOf}
        </p>
        <ClassificationChart indicator={indicator} />
        <div className="summary-legend" aria-hidden={false}>
          {bars.map((bar) => (
            <span key={bar.classification}>
              <i style={{ background: CLASSIFICATION_COLORS[bar.classification] }} aria-hidden /> {bar.shape} {bar.shortLabel}
            </span>
          ))}
        </div>
        <DataTable
          caption="Source classification values - the same selected values as the bar chart"
          headers={['Classification', 'Readings', 'Share', 'Notes']}
          rows={classificationRows}
        />
      </div>

      <div className="summary-chart-block">
        <h4>
          Daily volume by accounting category ({totals.areaName}, {totals.basis} basis)
        </h4>
        <p className="summary-chart-sub">
          Zero-based axis in acre-feet · {totals.timeZone} local days {totals.effectiveStart.slice(0, 10)} through{' '}
          {totals.effectiveEnd.slice(0, 10)} (enclosing calendar windows of {totals.requestedStart.slice(0, 10)} to {totals.requestedEnd.slice(0, 10)}) ·
          integration {totals.method}
        </p>
        <VolumeChart totals={totals} />
        <div className="summary-legend" aria-hidden={false}>
          {series.categories.map((category) => (
            <span key={category.category}>
              <i style={{ background: category.color }} aria-hidden /> {category.shape} {category.label}
            </span>
          ))}
          <span>∅ no measured volume that day (missing is never zero)</span>
        </div>
        <DataTable
          caption="Daily volume values - the same selected values as the line chart"
          headers={['Local day', ...series.categories.map((category) => `${category.shape} ${category.label} (acre-feet)`)]}
          rows={volumeRows}
        />
        <p className="summary-chart-sub">{totals.noDoubleCountPolicy}</p>
      </div>
    </div>
  );
}
