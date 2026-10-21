/**
 * RecurringQualityPanel - the FR-043 recurring quality-issue trends UI
 * (WD-013-R2).
 *
 * "Users see chart markers and a sortable table of repeated flags or
 * corrections by site and period; counts reconcile to the selected issue and
 * revision records without counting one incident repeatedly."
 *
 * Renders ONE derivation twice (chart/table parity):
 * - a grouped bar chart of incident counts by period and kind, every bar
 *   carrying its kind's SHAPE marker and the count as text - never color
 *   alone (FR-034 rule);
 * - a sortable table (site, kind, period, incident count + underlying
 *   record count, last seen, curve-boundary annotations) of the SAME rows,
 *   filterable by period and kind.
 *
 * Every count is the deduplicated incident count with its reconciliation
 * partner (the underlying records) beside it: the two-corrections chain on
 * obs-q-032 shows as ONE incident backed by 2 revision records.
 *
 * Accessibility contract (mirrors the WD-011/Wd-013 quality panels):
 * - a real <table> with caption, column headers (scope="col") and row
 *   headers (scope="row"), sortable via header buttons with aria-sort;
 * - the filter result count is an aria-live region;
 * - states are text: loading, empty, error (with retry) and denied (the
 *   server-side visibility projection refused the caller);
 * - kind identity is always marker + label, never color alone.
 *
 * Read-only by construction; the data arrives already visibility-projected
 * from services/api/src/quality-trends (restricted/internal sites only ever
 * appear because the server admitted the viewer). Defaults to the reviewed
 * demo snapshot of the frozen contract fixtures; see README.md for the
 * pending API wiring.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import {
  buildTrendRows,
  chartSeries,
  DEMO_NOW,
  filterTrendRows,
  KIND_LABELS,
  KIND_MARKERS,
  REVIEWED_DEMO_INCIDENTS,
  sortTrendRows,
  TREND_KINDS,
  type IncidentView,
  type TrendKind,
  type TrendSortBy,
  type TrendSortDirection,
} from './trendsModel';

export interface RecurringQualityData {
  /** Deduplicated incidents (the API trend report's incident list). */
  readonly incidents: readonly IncidentView[];
  /** The reference instant the report was derived under. */
  readonly now: string;
  /** Optional site display names keyed by station id. */
  readonly siteNames?: Readonly<Record<string, string>>;
}

export interface RecurringQualityPanelProps {
  /** Data source; defaults to the reviewed contract-fixture snapshot. */
  readonly data?: RecurringQualityData;
  /** Data status; the panel itself is synchronous and defaults to ready. */
  readonly status?: 'loading' | 'ready' | 'error' | 'denied';
  /** Message shown in the error/denied state. */
  readonly errorMessage?: string;
  /** Retry callback offered in the error/denied state. */
  readonly onRetry?: () => void;
  /** Label of the acting viewer (transparency note in the heading). */
  readonly viewerLabel?: string;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

const KIND_COLORS: Readonly<Record<TrendKind, string>> = {
  'qc-flag': '#c98a2d',
  correction: '#16887e',
  'known-issue': '#7d5ba6',
  'curve-supersession': '#4a6fa5',
};

const VISIBILITY_LABELS: Readonly<Record<string, string>> = {
  public: 'public site',
  restricted: 'restricted site',
  internal: 'internal site',
};

const CHART = { left: 34, top: 30, bottom: 96, width: 330 };

function SortHeader({
  column,
  label,
  sort,
  onSort,
}: {
  readonly column: TrendSortBy;
  readonly label: string;
  readonly sort: { by: TrendSortBy; direction: TrendSortDirection };
  readonly onSort: (column: TrendSortBy) => void;
}) {
  const active = sort.by === column;
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(column)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
          display: 'inline-flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        {label}
        <span aria-hidden style={{ fontSize: 8 }}>
          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export default function RecurringQualityPanel({
  data,
  status = 'ready',
  errorMessage,
  onRetry,
  viewerLabel = 'public projection',
}: RecurringQualityPanelProps) {
  const effectiveData: RecurringQualityData = data ?? { incidents: REVIEWED_DEMO_INCIDENTS, now: DEMO_NOW };
  const [sort, setSort] = useState<{ by: TrendSortBy; direction: TrendSortDirection }>({ by: 'lastSeen', direction: 'desc' });
  const [kindFilter, setKindFilter] = useState<TrendKind | 'all'>('all');
  const [periodFilter, setPeriodFilter] = useState<number | 'all'>('all');

  const rows = useMemo(() => buildTrendRows(effectiveData.incidents, { now: effectiveData.now }), [effectiveData]);
  const periodOptions = useMemo(() => [...new Set(rows.map((row) => row.periodIndex))].sort((a, b) => a - b), [rows]);
  const visibleRows = useMemo(
    () => sortTrendRows(filterTrendRows(rows, { kind: kindFilter, periodIndex: periodFilter }), sort),
    [rows, kindFilter, periodFilter, sort],
  );
  const series = useMemo(() => chartSeries(filterTrendRows(rows, { kind: kindFilter, periodIndex: periodFilter })), [rows, kindFilter, periodFilter]);
  const totalIncidents = visibleRows.reduce((sum, row) => sum + row.incidentCount, 0);
  const totalHits = visibleRows.reduce((sum, row) => sum + row.hitCount, 0);

  const onSort = (column: TrendSortBy): void => {
    setSort((current) =>
      current.by === column
        ? { by: column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { by: column, direction: column === 'site' || column === 'kind' ? 'asc' : 'desc' },
    );
  };

  const axisMax = Math.max(1, ...series.map((point) => point.count));
  const slot = series.length > 0 ? (CHART.width - CHART.left) / series.length : 1;
  const yOf = (value: number) => CHART.bottom - (value / axisMax) * (CHART.bottom - CHART.top);

  return (
    <section className="panel" aria-label="Recurring quality issue trends">
      <div className="panel-heading">
        <div>
          <h2>Recurring quality issues</h2>
          <span>
            Chart markers + sortable table of repeated flags and corrections by site and period · one incident per
            site/kind/cluster, never one row per revision · counts reconcile to the underlying records
          </span>
        </div>
        <span className="mini-pill">FR-043 · {viewerLabel}</span>
      </div>

      {status === 'loading' ? (
        <p role="status" style={{ padding: '22px 19px', fontSize: 11, margin: 0 }}>
          Loading recurring quality trends…
        </p>
      ) : status === 'denied' ? (
        <div style={{ padding: '22px 19px' }}>
          <p role="note" style={{ fontSize: 11, margin: '0 0 8px' }}>
            You are not authorized to view recurring quality trends for this scope.
          </p>
          {errorMessage ? <p style={{ fontSize: 9, color: '#8c9a8f', margin: '0 0 8px' }}>{errorMessage}</p> : null}
          {onRetry ? (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : status === 'error' ? (
        <div style={{ padding: '22px 19px' }}>
          <p role="alert" style={{ fontSize: 11, margin: '0 0 8px' }}>
            Recurring quality trends failed to load.
          </p>
          {errorMessage ? <p style={{ fontSize: 9, color: '#8c9a8f', margin: '0 0 8px' }}>{errorMessage}</p> : null}
          {onRetry ? (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : rows.length === 0 ? (
        <p role="status" style={{ padding: '22px 19px', fontSize: 11, margin: 0 }}>
          No recurring quality incidents in this window.
        </p>
      ) : (
        <>
          <div
            style={{
              padding: '10px 19px',
              borderBottom: '1px solid #e9ede8',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
              fontSize: 10,
            }}
          >
            <label htmlFor="rq-kind-filter" style={{ fontWeight: 650 }}>
              Kind
            </label>
            <select
              id="rq-kind-filter"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value === 'all' ? 'all' : (event.target.value as TrendKind))}
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
            >
              <option value="all">All kinds</option>
              {TREND_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_MARKERS[kind]} {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <label htmlFor="rq-period-filter" style={{ fontWeight: 650 }}>
              Period
            </label>
            <select
              id="rq-period-filter"
              value={periodFilter === 'all' ? 'all' : String(periodFilter)}
              onChange={(event) => setPeriodFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
            >
              <option value="all">All periods</option>
              {periodOptions.map((periodIndex) => (
                <option key={periodIndex} value={periodIndex}>
                  Period {periodIndex + 1} (current)
                </option>
              ))}
            </select>
            <span aria-live="polite">
              {visibleRows.length} rows · {totalIncidents} incidents · {totalHits} underlying records
            </span>
          </div>

          {series.length === 0 ? (
            <p role="status" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
              No incidents match the current filters.
            </p>
          ) : (
            <div style={{ padding: '12px 19px 4px', borderBottom: '1px solid #e9ede8' }}>
              <svg
                viewBox="0 0 340 190"
                role="img"
                aria-label={`Bar chart of recurring quality incidents by period and kind: ${series
                  .map((point) => `${point.kindLabel} ${point.count} (${point.hitCount} records)`)
                  .join('; ')}. Kinds also carry shape markers: ${TREND_KINDS.map((kind) => `${KIND_MARKERS[kind]} ${KIND_LABELS[kind]}`).join(', ')}.`}
              >
                {[0, 0.5, 1].map((tick) => {
                  const value = axisMax * tick;
                  const y = yOf(value);
                  return (
                    <g key={tick}>
                      <line x1={CHART.left} x2={CHART.width} y1={y} y2={y} stroke="#e4e7e0" strokeDasharray="4 5" />
                      <text x={CHART.left - 6} y={y + 4} textAnchor="end" className="chart-label">
                        {Math.round(value)}
                      </text>
                    </g>
                  );
                })}
                <text x={8} y={14} className="chart-label">
                  incidents
                </text>
                <line x1={CHART.left} x2={CHART.width} y1={CHART.bottom} y2={CHART.bottom} stroke="#8a9388" />
                <text x={CHART.left - 6} y={CHART.bottom + 4} textAnchor="end" className="chart-label">
                  0
                </text>
                {series.map((point, index) => {
                  const centerX = CHART.left + slot * (index + 0.5);
                  const barWidth = slot * 0.5;
                  const barTop = yOf(point.count);
                  return (
                    <g key={`${point.periodIndex}:${point.kind}:${index}`} tabIndex={0} role="button" className="summary-chart-bar" aria-label={`${point.kindLabel}: ${point.count} incidents (${point.hitCount} underlying records) in period starting ${point.periodLabel}`}>
                      <rect
                        x={centerX - barWidth / 2}
                        y={barTop}
                        width={barWidth}
                        height={CHART.bottom - barTop}
                        fill={KIND_COLORS[point.kind]}
                        stroke="#1c2b26"
                        strokeWidth={0.8}
                      />
                      <text x={centerX} y={barTop - 14} textAnchor="middle" className="chart-shape" aria-hidden>
                        {point.kindMarker}
                      </text>
                      <text x={centerX} y={barTop - 4} textAnchor="middle" className="chart-label">
                        {point.count}
                      </text>
                      <text x={centerX} y={CHART.bottom + 14} textAnchor="middle" className="chart-label">
                        {point.kindLabel}
                      </text>
                      <text x={centerX} y={CHART.bottom + 26} textAnchor="middle" className="chart-label">
                        {point.hitCount} records
                      </text>
                    </g>
                  );
                })}
              </svg>
              <p style={{ fontSize: 9, color: '#8c9a8f', margin: '4px 0 10px' }}>
                Markers:{' '}
                {TREND_KINDS.map((kind) => (
                  <span key={kind} style={{ marginRight: 10 }}>
                    <span aria-hidden style={{ fontWeight: 700 }}>
                      {KIND_MARKERS[kind]}
                    </span>{' '}
                    {KIND_LABELS[kind]}
                  </span>
                ))}
              </p>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table className="site-table">
              <caption className="sr-only">
                Recurring quality incidents by site, kind and period, sorted by {sort.by} ({sort.direction}).
                Incident counts are deduplicated per site, kind and cause cluster; the records column shows the
                underlying revision, QC, known-issue and rating-version records each count reconciles to.
              </caption>
              <thead>
                <tr>
                  <SortHeader column="site" label="Site" sort={sort} onSort={onSort} />
                  <SortHeader column="kind" label="Kind" sort={sort} onSort={onSort} />
                  <SortHeader column="period" label="Period" sort={sort} onSort={onSort} />
                  <SortHeader column="count" label="Incidents" sort={sort} onSort={onSort} />
                  <SortHeader column="lastSeen" label="Last seen" sort={sort} onSort={onSort} />
                  <th scope="col">Curve boundary</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.rowId}>
                    <th scope="row" tabIndex={0} title={row.rowId}>
                      {effectiveData.siteNames?.[row.stationId] ?? row.stationId}
                      <small style={SMALL_MUTED}>
                        {row.systemId} · {VISIBILITY_LABELS[row.visibility] ?? row.visibility} ·{' '}
                        {row.streamIds.join(', ')}
                      </small>
                    </th>
                    <td tabIndex={-1}>
                      <span aria-hidden style={{ fontWeight: 700, marginRight: 5 }}>
                        {row.kindMarker}
                      </span>
                      {row.kindLabel}
                    </td>
                    <td tabIndex={-1}>
                      {row.periodLabel}
                      <small style={SMALL_MUTED}>period {row.periodIndex + 1}</small>
                    </td>
                    <td tabIndex={-1}>
                      <strong>{row.incidentCount}</strong>
                      <small style={SMALL_MUTED}>
                        of {row.hitCount} records · {row.recurrenceRateLabel} · clusters:{' '}
                        {row.causeLabels.length}
                      </small>
                    </td>
                    <td tabIndex={-1}>
                      {row.lastSeenLabel} UTC
                      <small style={SMALL_MUTED}>{row.timeSinceLabel} ago</small>
                    </td>
                    <td tabIndex={-1} style={{ maxWidth: 300, whiteSpace: 'normal' }}>
                      {row.boundaryAnnotationLabels.length === 0 ? (
                        '—'
                      ) : (
                        row.boundaryAnnotationLabels.map((label) => (
                          <small key={label} style={{ display: 'block' }}>
                            ◆ {label}
                          </small>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleRows.length === 0 && (
            <p role="status" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
              No rows match the current filters.
            </p>
          )}
        </>
      )}
    </section>
  );
}
