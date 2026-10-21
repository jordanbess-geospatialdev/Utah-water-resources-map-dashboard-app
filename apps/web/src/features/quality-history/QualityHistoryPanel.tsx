/**
 * QualityHistoryPanel - the FR-042 point/interval audit UI.
 *
 * "Selecting a point or flagged interval displays all authorized revisions
 * with actor, timestamp, original and replacement value, qualifiers and
 * reason, including a revision later superseded by another edit."
 *
 * Read-only by construction: every mutation path lives in the correction
 * workflow (services/api/src/workflows/revisions); this panel only renders
 * the derived chain. Accessibility contract:
 * - a real <table> with caption, column headers (scope="col") and row
 *   headers (scope="row", the chain version);
 * - keyboard navigable: Tab reaches each row, ArrowUp/ArrowDown move between
 *   rows, ArrowLeft/ArrowRight move between the cells of a row;
 * - status is ALWAYS text + shape (● current, ○ superseded, ✕ withdrawn),
 *   never color alone;
 * - observation time ("when the reading was taken") and revision time ("when
 *   the edit was recorded") are labelled separately everywhere they appear.
 *
 * Mountable, shell-free component: WD-011 must not edit persona_ui's
 * App.tsx, so the panel takes its data (fixtures by default) and its
 * loading/error status through props; see index.ts for the one-line shell
 * wiring point and README.md for the pending integration note.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatDateMT, formatTimeMT } from '../../components/Chart';
import {
  FIXTURE_SEED,
  gaps as fixtureGaps,
  observations as fixtureObservations,
  qualifierName,
  revisions as fixtureRevisions,
  stations,
  userById,
} from '../../shell/data/fixtures';
import {
  formatAuditValue,
  formatChange,
  intervalQualityHistory,
  pointAuditTargets,
  pointQualityHistory,
  type AuditObservation,
  type ChainRevision,
  type IntervalSelector,
  type NameTables,
  type PointFlagReason,
  type QualityHistoryModel,
  type QualityHistoryRow,
} from './derivation';

/** A flagged interval offered for selection (declared gaps by default). */
export interface QualityHistoryInterval {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

/** Everything the panel renders; defaults to the contract fixtures. */
export interface QualityHistoryData {
  readonly observations: readonly AuditObservation[];
  readonly revisions: readonly ChainRevision[];
  readonly validRange?: { readonly min: number; readonly max: number };
  readonly intervals?: readonly QualityHistoryInterval[];
  readonly actorNames?: Readonly<Record<string, string>>;
  readonly qualifierNames?: Readonly<Record<string, string>>;
}

export interface QualityHistoryPanelProps {
  /** Stream to audit; defaults to the Corinne discharge telemetry stream. */
  readonly streamId?: string;
  /** Data source; defaults to the frozen contract fixtures for the stream. */
  readonly data?: QualityHistoryData;
  /** Data status; the panel itself is synchronous and defaults to ready. */
  readonly status?: 'loading' | 'ready' | 'error';
  /** Message shown in the error state. */
  readonly errorMessage?: string;
  /** Retry callback offered in the error state. */
  readonly onRetry?: () => void;
  /** Initial selection: 'point:<observationId>' or 'interval:<id>'. */
  readonly defaultTarget?: string;
}

const FLAG_LABELS: Readonly<Record<PointFlagReason, string>> = {
  revised: 'revised',
  'null-frame': 'no value',
  'out-of-range': 'out of range',
  negative: 'negative',
  'suspect-zero': 'suspect zero',
  estimated: 'estimated',
};

/** Fixture-backed default data for one stream (read-only shell reuse, WD-006). */
function fixtureDataFor(streamId: string): QualityHistoryData {
  const stream = stations.flatMap((station) => station.datastreams).find((candidate) => candidate.id === streamId);
  const actorNames: Record<string, string> = {};
  for (const revision of fixtureRevisions) actorNames[revision.actorId] = userById.get(revision.actorId)?.displayName ?? revision.actorId;
  const qualifierNames: Record<string, string> = {};
  for (const [id, name] of qualifierName) qualifierNames[id] = name;
  const intervals: QualityHistoryInterval[] = fixtureGaps
    .filter((gap) => gap.streamId === streamId)
    .map((gap) => ({
      id: gap.id,
      start: gap.start,
      end: gap.end,
      label: `Flagged interval ${formatDateMT(gap.start)} (${gap.reason}; ${gap.missingCount} missing)`,
    }));
  const data: QualityHistoryData = {
    observations: fixtureObservations.filter((observation) => observation.streamId === streamId),
    revisions: fixtureRevisions,
    actorNames,
    qualifierNames,
    intervals,
  };
  return stream ? { ...data, validRange: { min: stream.validRangeMin, max: stream.validRangeMax } } : data;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

/** Keyboard navigation: arrows move between rows and cells, Tab moves between rows. */
function handleTableKeyDown(event: ReactKeyboardEvent<HTMLTableSectionElement>): void {
  const { key } = event;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
  const cell = (event.target as HTMLElement).closest<HTMLElement>('td,th');
  const row = (event.target as HTMLElement).closest<HTMLElement>('tr');
  if (!cell || !row) return;
  event.preventDefault();
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('tr[data-qh-row]'));
    const index = rows.indexOf(row);
    const next = rows[index + (key === 'ArrowDown' ? 1 : -1)];
    (next?.querySelector<HTMLElement>('td,th') ?? next)?.focus();
    return;
  }
  const cells = Array.from(row.querySelectorAll<HTMLElement>('td,th'));
  const index = cells.indexOf(cell);
  (cells[index + (key === 'ArrowRight' ? 1 : -1)] ?? cell).focus();
}

function StatusCell({ row }: { readonly row: QualityHistoryRow }) {
  return (
    <td tabIndex={-1}>
      <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
        {row.statusMarker}
      </span>
      {row.statusText}
      {row.supersededByRevisionId !== null && (
        <small style={SMALL_MUTED}>by {row.supersededByRevisionId}</small>
      )}
    </td>
  );
}

function HistoryTable({
  rows,
  showObserved,
  describedBy,
}: {
  readonly rows: readonly QualityHistoryRow[];
  readonly showObserved: boolean;
  readonly describedBy: string;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="site-table" aria-describedby={describedBy}>
        <caption className="sr-only">
          Revision chain audit. Revision time is when an edit was recorded; observed time is when the reading was
          taken. Superseded revisions remain listed.
        </caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Recorded (edit time)</th>
            {showObserved ? <th scope="col">Observed (measurement time)</th> : null}
            <th scope="col">Actor</th>
            <th scope="col">Change</th>
            <th scope="col">Qualifiers</th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody onKeyDown={handleTableKeyDown}>
          {rows.map((row) => (
            <tr key={row.revisionId} data-qh-row>
              <th scope="row" tabIndex={0} title={`Revision ${row.revisionId} (If-Match version ${row.version})`}>
                v{row.version}
              </th>
              <td tabIndex={-1}>
                {formatTimeMT(row.recordedAt)}
                <small style={SMALL_MUTED}>{row.recordedAt}</small>
              </td>
              {showObserved ? (
                <td tabIndex={-1}>
                  {formatTimeMT(row.observedAt)}
                  <small style={SMALL_MUTED}>{row.observedAt}</small>
                </td>
              ) : null}
              <td tabIndex={-1}>{row.actorName}</td>
              <td tabIndex={-1}>
                {formatChange(row)}
                {row.isTombstone && row.retainedOriginal !== null && (
                  <small style={SMALL_MUTED}>
                    retained original received {row.retainedOriginal.receivedAt} from {row.retainedOriginal.sourceId}
                  </small>
                )}
              </td>
              <td tabIndex={-1}>
                {row.qualifierNames.length > 0 ? row.qualifierNames.join(', ') : <span className="muted">—</span>}
              </td>
              <td tabIndex={-1} style={{ maxWidth: 280, whiteSpace: 'normal' }}>
                {row.reason}
              </td>
              <StatusCell row={row} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProvenanceCard({ model }: { readonly model: Extract<QualityHistoryModel, { kind: 'point' }> }) {
  const provenance = model.provenance;
  const rows: [string, string][] = [
    ['Observed (measurement time)', `${formatTimeMT(provenance.observedAt)} (${provenance.sourceOffset})`],
    ['Received (ingest time)', `${formatTimeMT(provenance.receivedAt)} (${provenance.receivedAt})`],
    ['Raw value (never edited)', formatAuditValue(provenance.value, provenance.unitId)],
    ['Value type', provenance.valueType],
    ['Source event', provenance.sourceEventId],
    ['Source', provenance.sourceId],
  ];
  return (
    <div style={{ background: '#fafcf9', borderBottom: '1px solid #e9ede8', padding: '13px 19px' }}>
      <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
        Original (raw) — immutable, corrections append only
      </h3>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: 10 }}>
        {rows.map(([term, detail]) => (
          <div key={term} style={{ display: 'contents' }}>
            <dt style={{ color: '#8c9a8f' }}>{term}:</dt>
            <dd style={{ margin: 0 }}>{detail}</dd>
          </div>
        ))}
      </dl>
      {provenance.note !== undefined && (
        <p style={{ fontSize: 10, color: '#7b8982', margin: '8px 0 0', lineHeight: 1.6 }}>{provenance.note}</p>
      )}
    </div>
  );
}

/**
 * The FR-042 audit panel. Selecting a flagged point or a declared interval
 * renders the full revision chain read-only; loading, empty (raw-only
 * provenance) and error-with-retry states are first-class.
 */
export default function QualityHistoryPanel({
  streamId = 'str-corinne-q',
  data,
  status = 'ready',
  errorMessage,
  onRetry,
  defaultTarget,
}: QualityHistoryPanelProps) {
  const resolvedData = useMemo(() => data ?? fixtureDataFor(streamId), [data, streamId]);
  const names = useMemo<NameTables>(() => {
    // exactOptionalPropertyTypes: never assign explicit undefined to optional props.
    const tables: { actorNames?: Readonly<Record<string, string>>; qualifierNames?: Readonly<Record<string, string>> } = {};
    if (resolvedData.actorNames !== undefined) tables.actorNames = resolvedData.actorNames;
    if (resolvedData.qualifierNames !== undefined) tables.qualifierNames = resolvedData.qualifierNames;
    return tables;
  }, [resolvedData]);

  const pointTargets = useMemo(
    () => pointAuditTargets(resolvedData.observations, resolvedData.revisions, streamId, resolvedData.validRange),
    [resolvedData, streamId],
  );

  const defaultSelection = useMemo(() => {
    if (defaultTarget !== undefined) return defaultTarget;
    const revised = pointTargets.find((target) => target.revisionCount > 0);
    if (revised) return `point:${revised.observation.id}`;
    const firstInterval = resolvedData.intervals?.[0];
    if (firstInterval) return `interval:${firstInterval.id}`;
    const first = pointTargets[0];
    return first ? `point:${first.observation.id}` : '';
  }, [defaultTarget, pointTargets, resolvedData]);

  const [target, setTarget] = useState<string>(defaultSelection);
  const selection = target === '' ? defaultSelection : target;

  const model = useMemo<QualityHistoryModel | null>(() => {
    if (status !== 'ready') return null;
    if (selection.startsWith('point:')) {
      const observationId = selection.slice('point:'.length);
      const observation = resolvedData.observations.find((candidate) => candidate.id === observationId);
      if (!observation) return null;
      return pointQualityHistory(observation, resolvedData.revisions, names);
    }
    if (selection.startsWith('interval:')) {
      const intervalId = selection.slice('interval:'.length);
      const interval = resolvedData.intervals?.find((candidate) => candidate.id === intervalId);
      if (!interval) return null;
      const selector: IntervalSelector = { streamId, start: interval.start, end: interval.end };
      return intervalQualityHistory(resolvedData.observations, resolvedData.revisions, selector, names);
    }
    return null;
  }, [names, resolvedData, selection, status, streamId]);

  return (
    <section className="panel" aria-label="Quality and correction history">
      <div className="panel-heading">
        <div>
          <h2>Quality history</h2>
          <span>
            Point and interval revision audit · observation time and revision time labelled separately · superseded
            revisions retained
          </span>
        </div>
        <span className="mini-pill">FR-042 · seed {FIXTURE_SEED}</span>
      </div>

      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="qh-target" style={{ fontSize: 10, fontWeight: 650 }}>
          Audit target
        </label>
        <select
          id="qh-target"
          value={selection}
          onChange={(event) => setTarget(event.target.value)}
          style={{ fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de', maxWidth: 420 }}
        >
          <optgroup label="Points (revised or quality-flagged)">
            {pointTargets.map((candidate) => (
              <option key={candidate.observation.id} value={`point:${candidate.observation.id}`}>
                {formatTimeMT(candidate.observation.observedAt)} · {formatAuditValue(candidate.observation.value, candidate.observation.unitId)} ·{' '}
                {candidate.flags.map((flag) => FLAG_LABELS[flag]).join(', ')}
                {candidate.revisionCount > 0 ? ` · ${candidate.revisionCount} revision${candidate.revisionCount > 1 ? 's' : ''}` : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label="Flagged intervals (declared, half-open on observation time)">
            {(resolvedData.intervals ?? []).map((interval) => (
              <option key={interval.id} value={`interval:${interval.id}`}>
                {interval.label} · {interval.start} → {interval.end}
              </option>
            ))}
          </optgroup>
        </select>
        <span className="muted" style={{ fontSize: 9 }}>
          Keyboard: Tab between rows, arrow keys within the table
        </span>
      </div>

      {status === 'loading' && (
        <p role="status" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Loading revision history…
        </p>
      )}

      {status === 'error' && (
        <div role="alert" style={{ padding: '14px 19px', margin: 0 }}>
          <p style={{ fontSize: 11, margin: '0 0 10px', color: '#8a4b3c' }}>
            {errorMessage ?? 'Revision history is unavailable.'}
          </p>
          {onRetry !== undefined && (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'ready' && model === null && (
        <p role="note" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Nothing to audit: no revised or flagged points for this stream.
        </p>
      )}

      {status === 'ready' && model?.kind === 'point' && (
        <>
          <ProvenanceCard model={model} />
          {model.hasRevisions ? (
            <HistoryTable rows={model.rows} showObserved={false} describedBy="qh-note" />
          ) : (
            <p role="note" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
              No revisions recorded for this point — the raw value as received is the best-available value. Only the
              original provenance above applies.
            </p>
          )}
        </>
      )}

      {status === 'ready' && model?.kind === 'interval' && (
        <>
          <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8', fontSize: 10, color: '#7b8982' }}>
            Flagged interval {model.start} → {model.end} (half-open, on observation time) · {model.revisedPointCount}{' '}
            revised point{model.revisedPointCount === 1 ? '' : 's'} · {model.rows.length} revision
            {model.rows.length === 1 ? '' : 's'}, superseded ones included
          </div>
          {model.rows.length > 0 ? (
            <HistoryTable rows={model.rows} showObserved describedBy="qh-note" />
          ) : (
            <p role="note" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
              No revised points inside this window; missing readings stay missing and are never back-filled.
            </p>
          )}
        </>
      )}

      {status === 'ready' && model !== null && model.rows.length > 0 && (
        <p id="qh-note" style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
          Recorded = revision time (when the edit was made). Observed = measurement time (when the reading was taken).
          Status: ● current · ○ superseded · ✕ withdrawn (original retained).
        </p>
      )}
    </section>
  );
}
