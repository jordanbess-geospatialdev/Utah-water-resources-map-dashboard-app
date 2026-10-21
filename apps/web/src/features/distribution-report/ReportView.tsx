import { useState } from 'react';
import {
  NOTE_LEGEND,
  formatMean,
  formatPct,
  formatVolume,
  hashFooter,
  noteSymbols,
  noteText,
  supersededBanner,
  volumeChartPoints,
  type ReportLike,
  type StreamSectionLike,
} from './reportModel';

/**
 * Renders a generated distribution report (WD-025; FR-024): per-site daily
 * flow/volume tables with quality and coverage notes, category-separated
 * totals, the formula documentation block, extraction time and per-stream
 * source revision labels, a content-hash footer, and a superseded-version
 * banner when a regenerated version replaces a prior one.
 *
 * Accessibility/data-honesty rules (FR-062): every chart carries the SAME
 * values in an always-present table alternative; note markers are text+shape
 * (never color alone); missing days read "Unavailable", never 0; the daily
 * volume chart is configurable in size (compact/standard/wide) per FR-024.
 *
 * Printable-layout note: the layout uses print-friendly panels and no
 * fixed-position controls; the PDF EXPORT itself is a later transport task
 * on the export pipeline (see README.md) - the values here are exactly the
 * dataset the server selected, so any transport reconciles by construction.
 */
export interface ReportViewProps {
  report: ReportLike;
}

const CHART_SIZES: readonly { id: string; label: string; width: number; height: number }[] = [
  { id: 'compact', label: 'Compact (320 px)', width: 320, height: 80 },
  { id: 'standard', label: 'Standard (560 px)', width: 560, height: 110 },
  { id: 'wide', label: 'Wide (760 px)', width: 760, height: 140 },
] as const;

function VolumeChart({ stream }: { stream: StreamSectionLike }) {
  const [sizeId, setSizeId] = useState('standard');
  const size = CHART_SIZES.find((option) => option.id === sizeId) ?? CHART_SIZES[1]!;
  const points = volumeChartPoints(stream).filter((point) => point.volume !== null);
  const max = points.reduce((peak, point) => Math.max(peak, point.volume ?? 0), 0) || 1;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
        <label htmlFor={`chart-size-${stream.streamId}`} style={{ fontSize: 11 }}>
          Chart size
        </label>
        <select id={`chart-size-${stream.streamId}`} value={sizeId} onChange={(event) => setSizeId(event.target.value)}>
          {CHART_SIZES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {points.length === 0 ? (
        <p className="muted" style={{ fontSize: 11 }}>
          No covered days in this period — nothing to chart (missing is never zero).
        </p>
      ) : (
        <svg
          role="img"
          aria-label={`Daily volume sparkline for ${stream.stationDisplayName} (${stream.streamId}); ${points.length} covered days; the table below carries the same values`}
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
        >
          {points.map((point, index) => {
            const x = (index / Math.max(points.length - 1, 1)) * (size.width - 8) + 4;
            const barHeight = ((point.volume ?? 0) / max) * (size.height - 14);
            return <rect key={point.key} x={x - 1.5} y={size.height - 10 - barHeight} width={3} height={Math.max(barHeight, 1)} fill="#4c8561" />;
          })}
          <line x1={0} x2={size.width} y1={size.height - 10} y2={size.height - 10} stroke="#c9d6c9" strokeWidth={1} />
        </svg>
      )}
    </div>
  );
}

export default function ReportView({ report }: ReportViewProps) {
  const banner = supersededBanner(report);

  return (
    <div className="panel" data-feature="distribution-report-view" style={{ breakInside: 'avoid' }}>
      <div className="panel-heading">
        <h2>
          {report.system.name} — distribution report v{report.version}
        </h2>
        <span>
          {report.period.basis} {report.period.year} · {report.processingBasis} basis · extracted {report.extractionTime}
        </span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {banner ? (
          <p role="status" style={{ border: '1px solid #b98b2f', background: '#fdf6e7', padding: '6px 8px' }}>
            {banner}
          </p>
        ) : null}

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: '0 0 10px', fontSize: 11 }}>
          <dt>Report id</dt>
          <dd style={{ margin: 0 }}>{report.reportId}</dd>
          <dt>Period</dt>
          <dd style={{ margin: 0 }}>
            {report.period.start} to {report.period.end} (half-open, {report.period.timeZone}) — {report.period.dateRule}
          </dd>
          <dt>Requested by</dt>
          <dd style={{ margin: 0 }}>{report.requestedBy}</dd>
          <dt>Extraction time</dt>
          <dd style={{ margin: 0 }}>{report.extractionTime}</dd>
          <dt>Aggregation method</dt>
          <dd style={{ margin: 0 }}>{report.sections.provenance.methodVersion}</dd>
        </dl>

        {report.sections.excludedSites.length > 0 ? (
          <p className="muted" style={{ fontSize: 11 }}>
            Excluded sites: {report.sections.excludedSites.map((site) => `${site.stationDisplayName} (${site.reason})`).join('; ')}
          </p>
        ) : null}

        {report.sections.sites.map((site) => (
          <section key={site.stationId} style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>
              {site.stationDisplayName} ({site.stationId}, {site.status})
            </h3>
            {site.excludedStreams.length > 0 ? (
              <p className="muted" style={{ fontSize: 11, margin: '0 0 4px' }}>
                Excluded streams: {site.excludedStreams.map((stream) => `${stream.streamId} — ${stream.reason}`).join('; ')}
              </p>
            ) : null}
            {site.streams.map((stream) => (
              <div key={stream.streamId} style={{ border: '1px solid #dde5dd', padding: '6px 8px', marginBottom: 8 }}>
                <h4 style={{ fontSize: 11, margin: '0 0 4px' }}>
                  {stream.streamId} — discharge ({stream.unitId}), cadence {stream.cadenceMinutes} min, method {stream.method}
                </h4>
                <VolumeChart stream={stream} />
                <table className="obs-table" style={{ width: '100%', fontSize: 11 }}>
                  <caption className="sr-only">
                    Daily flow and volume for {stream.stationDisplayName} ({stream.streamId}); unavailable days carry no value, never zero
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Local day</th>
                      <th scope="col">Volume (acre-feet)</th>
                      <th scope="col">Mean (cfs)</th>
                      <th scope="col">Coverage</th>
                      <th scope="col">Estimated</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stream.daily.map((row) => (
                      <tr key={row.key}>
                        <td>{row.key}</td>
                        <td className="numeric">{formatVolume(row.volumeAcreFeet)}</td>
                        <td className="numeric">{formatMean(row.meanValue)}</td>
                        <td className="numeric">{formatPct(row.coverageFraction)}</td>
                        <td className="numeric">{row.estimatedProportion > 0 ? formatPct(row.estimatedProportion) : '—'}</td>
                        <td>
                          <span aria-hidden>{noteSymbols(row.noteCodes)}</span>{' '}
                          <span className="sr-only">{noteText(row.noteCodes)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Period total</th>
                      <td className="numeric strong">{formatVolume(stream.totals.volumeAcreFeet)}</td>
                      <td className="numeric">{formatPct(stream.totals.coverageFraction)} covered</td>
                      <td className="numeric">{formatPct(stream.totals.estimatedProportion)} estimated</td>
                      <td colSpan={2} className="muted">
                        {stream.totals.daysWithNoData} of {stream.totals.dayCount} days unavailable
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {stream.qualityNotes.length > 0 ? (
                  <ul style={{ fontSize: 11, margin: '4px 0 0', paddingLeft: 16 }}>
                    {stream.qualityNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                <ul className="muted" style={{ fontSize: 11, margin: '4px 0 0', paddingLeft: 16 }}>
                  {stream.coverageNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}

        <section style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>System totals by accounting category</h3>
          <table className="obs-table" style={{ width: '100%', fontSize: 11 }}>
            <caption className="sr-only">Category-separated totals; categories are never summed together</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Streams</th>
                <th scope="col">Volume (acre-feet)</th>
                <th scope="col">Coverage</th>
                <th scope="col">Estimated</th>
              </tr>
            </thead>
            <tbody>
              {report.sections.totals.categories.map((category) => (
                <tr key={category.category}>
                  <td>{category.label}</td>
                  <td>{category.streamIds.join(', ')}</td>
                  <td className="numeric strong">{formatVolume(category.volumeAcreFeet)}</td>
                  <td className="numeric">{formatPct(category.coverageFraction)}</td>
                  <td className="numeric">{formatPct(category.estimatedProportion)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Combined total</th>
                <td colSpan={4} className="muted">
                  not computed — never summed across categories (no double count)
                </td>
              </tr>
            </tfoot>
          </table>
          {report.sections.totals.excludedStreams.length > 0 ? (
            <p className="muted" style={{ fontSize: 11 }}>
              Outside flow totals: {report.sections.totals.excludedStreams.map((stream) => `${stream.streamId} — ${stream.reason}`).join('; ')}
            </p>
          ) : null}
        </section>

        <section style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Formulas and processing context</h3>
          <dl style={{ fontSize: 11, margin: 0 }}>
            {report.sections.formulas.statements.map((statement) => (
              <div key={statement.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '0 8px' }}>
                <dt>
                  <strong>{statement.id}</strong>
                </dt>
                <dd style={{ margin: 0 }}>
                  {statement.statement} <span className="muted">[{statement.methodRef}]</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted" style={{ fontSize: 11 }}>
            Rounding: {report.sections.formulas.roundingPolicy}
          </p>
        </section>

        <section style={{ marginBottom: 8 }}>
          <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Source revisions (which chain produced these numbers)</h3>
          {report.sections.provenance.streams.map((stream) => (
            <p key={stream.streamId} style={{ fontSize: 11, margin: '0 0 4px' }}>
              <strong>{stream.streamId}</strong> ({stream.stationDisplayName}, {stream.basis} basis):{' '}
              {stream.revisedObservations.length === 0
                ? 'no revised observations in the period'
                : stream.revisedObservations
                    .map((label) => `${label.observationId} -> ${label.headRevisionId} (v${label.chainVersion}, ${label.headProcessingLevel}, recorded ${label.headRecordedAt}${label.usedAtSelectedBasis ? ', used' : ', not used at this basis'})`)
                    .join('; ')}
              {stream.rawFallbackCount > 0 ? `; ${stream.rawFallbackCount} below-basis fallback(s) to raw` : ''}
            </p>
          ))}
          <p className="muted" style={{ fontSize: 11 }}>
            Data version {report.sections.provenance.dataVersion} (fixture seed utah-water-fixture-v1); the data version changes whenever the underlying revision chain changes.
          </p>
        </section>

        <section>
          <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Legend (text + shape)</h3>
          <ul style={{ fontSize: 11, margin: 0, paddingLeft: 16, columns: 2 }}>
            {NOTE_LEGEND.map((entry) => (
              <li key={entry.code}>
                <span aria-hidden>{entry.shape}</span> {entry.label}
              </li>
            ))}
          </ul>
        </section>

        <footer style={{ borderTop: '1px solid #dde5dd', marginTop: 10, paddingTop: 8 }}>
          <p style={{ fontSize: 10, margin: 0 }} className="muted">
            {hashFooter(report)} · generated by {report.requestedBy} · deterministic regeneration: identical inputs and clock reproduce this content hash byte-for-byte
          </p>
          <p style={{ fontSize: 10, margin: '4px 0 0' }} className="muted">
            Printable layout (values reconcile to the selected dataset by construction); PDF export is a later transport task on the export pipeline. Immutable finalization is R2 (FR-029): regeneration supersedes, never rewrites.
          </p>
        </footer>
      </div>
    </div>
  );
}
