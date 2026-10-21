import { useEffect, useMemo, useRef, useState } from 'react';
import type { SeriesPoint } from '../../shell/data/observations';
import { streamSeries as loadStreamSeries } from '../../shell/data/observations';
import { stations } from '../../shell/data/fixtures';
import type { ProcessingBasis } from './derivation';

/**
 * Export panel (WD-008; FR-063): selection summary, asynchronous job trigger
 * with visible status/progress states, a download-link PLACEHOLDER that
 * honors the reauthorization contract, and typed denial states.
 *
 * The async job shown here is a deterministic local simulation of
 * services/api/src/exports/exportJob.ts (queued -> running -> succeeded |
 * failed with row/time caps). The real wiring lands with the HTTP service
 * (POST /api/v1/exports + GET /api/v1/exports/{id}); the download link stays
 * a placeholder on purpose: every download must re-run the grant gate, and a
 * revoked grant fails closed (see the exports README). No reusable storage
 * URL is ever shown.
 */
export interface ExportSelection {
  streamIds: readonly string[];
  start: string;
  end: string;
  basis: ProcessingBasis;
}

export interface ExportPanelProps {
  selection?: ExportSelection;
  /** Rendered instead of the request form when the caller already knows the request is denied. */
  denial?: { status: number; code: string; message: string } | null;
}

type JobPhase =
  | { kind: 'idle' }
  | { kind: 'queued'; jobId: string }
  | { kind: 'running'; jobId: string; progress: number }
  | { kind: 'succeeded'; jobId: string; rowCount: number; expiresAt: string }
  | { kind: 'failed'; jobId: string; code: string; message: string }
  | { kind: 'denied'; status: number; code: string; message: string };

const DEFAULT_SELECTION: ExportSelection = {
  streamIds: ['str-corinne-q'],
  start: '2026-03-06T07:00:00.000Z',
  end: '2026-03-09T06:00:00.000Z',
  basis: 'raw',
};

const PHASE_LABEL: Record<JobPhase['kind'], string> = {
  idle: 'No export requested yet',
  queued: 'Queued — waiting for a worker',
  running: 'Running — rendering rows',
  succeeded: 'Succeeded — ready to download',
  failed: 'Failed',
  denied: 'Denied',
};

export default function ExportPanel({ selection = DEFAULT_SELECTION, denial = null }: ExportPanelProps) {
  const [phase, setPhase] = useState<JobPhase>(denial ? { kind: 'denied', ...denial } : { kind: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const estimatedRows = useMemo(() => {
    let rows = 0;
    for (const streamId of selection.streamIds) {
      const startMs = Date.parse(selection.start);
      const endMs = Date.parse(selection.end);
      rows += loadStreamSeries(streamId).filter((point: SeriesPoint) => {
        const at = Date.parse(point.observedAt);
        return at >= startMs && at < endMs;
      }).length;
    }
    return rows;
  }, [selection]);

  const stationNames = useMemo(
    () =>
      selection.streamIds
        .map((streamId) => stations.find((station) => station.datastreams.some((stream) => stream.id === streamId))?.displayName ?? streamId)
        .join(', '),
    [selection.streamIds],
  );

  const startJob = (): void => {
    if (denial) {
      setPhase({ kind: 'denied', ...denial });
      return;
    }
    const jobId = 'exp-1';
    setPhase({ kind: 'queued', jobId });
    timer.current = setTimeout(() => {
      setPhase({ kind: 'running', jobId, progress: 35 });
      timer.current = setTimeout(() => {
        setPhase({ kind: 'running', jobId, progress: 80 });
        timer.current = setTimeout(() => {
          setPhase({
            kind: 'succeeded',
            jobId,
            rowCount: estimatedRows,
            expiresAt: '15 minutes after completion (reauthorize on download)',
          });
        }, 350);
      }, 350);
    }, 350);
  };

  const retry = (): void => {
    setPhase({ kind: 'idle' });
  };

  return (
    <div className="panel" data-feature="series-export">
      <div className="panel-heading">
        <h2>CSV export</h2>
        <span>Asynchronous job · row and time caps · download re-authorizes on every request</span>
      </div>
      <div style={{ padding: '12px 16px', fontSize: 11 }}>
        <h3 style={{ fontSize: 11, margin: '0 0 4px' }}>Selection summary</h3>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 10px', margin: '0 0 10px' }}>
          <dt>Stations</dt>
          <dd style={{ margin: 0 }}>{stationNames}</dd>
          <dt>Window</dt>
          <dd style={{ margin: 0 }}>
            {selection.start} to {selection.end} (half-open, UTC)
          </dd>
          <dt>Processing basis</dt>
          <dd style={{ margin: 0 }}>{selection.basis}</dd>
          <dt>Estimated rows</dt>
          <dd style={{ margin: 0 }}>
            {estimatedRows} (jobs above the row cap are rejected with EXPORT_ROW_CAP_EXCEEDED, never silently truncated)
          </dd>
        </dl>

        <p role="status" aria-live="polite" style={{ margin: '4px 0 8px' }}>
          <strong>{PHASE_LABEL[phase.kind]}</strong>
          {phase.kind === 'running' ? ` (${phase.progress}%)` : ''}
          {phase.kind === 'succeeded' ? ` — ${phase.rowCount} rows · expires ${phase.expiresAt}` : ''}
          {phase.kind === 'failed' || phase.kind === 'denied' ? ` — ${phase.code}: ${phase.message}` : ''}
        </p>

        {phase.kind === 'idle' ? (
          <button type="button" className="button" onClick={startJob}>
            Request CSV export
          </button>
        ) : null}
        {phase.kind === 'queued' || phase.kind === 'running' ? (
          <div aria-hidden style={{ border: '1px solid #c9d6c9', height: 8, maxWidth: 320 }}>
            <div
              style={{
                width: `${phase.kind === 'running' ? phase.progress : 8}%`,
                height: '100%',
                background: '#4c8561',
                transition: 'width .3s',
              }}
            />
          </div>
        ) : null}
        {phase.kind === 'succeeded' ? (
          <p style={{ margin: '4px 0' }}>
            {/* PLACEHOLDER: the real link is GET /api/v1/exports/{id}, which
                re-runs the grant gate per download; a revoked grant fails
                closed. No reusable storage URL is issued. */}
            <a
              href="#"
              onClick={(event) => event.preventDefault()}
              aria-disabled="true"
              title="Placeholder until the API service lands (WD-016 wiring); the real download re-authorizes on click"
            >
              Download {phase.rowCount}-row CSV ({phase.jobId})
            </a>{' '}
            <span className="muted">placeholder — every download re-checks your current grants</span>
          </p>
        ) : null}
        {phase.kind === 'failed' || phase.kind === 'denied' ? (
          <button type="button" className="button small" onClick={retry}>
            Start over
          </button>
        ) : null}
        <p style={{ fontSize: 10, color: '#5f7268', margin: '8px 0 0' }}>
          CSV columns follow the technical specification (station/stream ids, property/unit, observation time + retained
          offset, value, processing level, qualifiers, source and revision identifiers); user-controlled text is
          neutralized against spreadsheet formula injection; missing values export as empty fields, never 0.
        </p>
      </div>
    </div>
  );
}
