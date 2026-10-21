/**
 * VisitHistoryPanel - the FR-046 per-site visit, maintenance and inspection
 * history UI.
 *
 * "A visit records site, author, visit time, type, measurement or
 * maintenance actions and attachments; last checked or rated dates are
 * structured queryable fields and visit history survives equipment
 * replacement."
 *
 * Attachments are visibility-filtered per acting persona with the SAME
 * semantics as the API projection helpers (visitModel.projectHistoryVisits):
 * without the internal capability the panel shows the public projection -
 * no actor ids, no visit notes, public attachments only, and not even a
 * count of hidden internal rows; an entitled engineer sees actor, notes and
 * internal attachment rows (which carry an explicit "internal" text marker,
 * never color alone).
 *
 * Accessibility contract (mirrors the quality-history panel):
 * - a real <table> with caption, column headers (scope="col") and row
 *   headers (scope="row", the visit id);
 * - keyboard navigable: Tab reaches each row, arrow keys move within it;
 * - visibility is always text + shape (▸ internal), never color alone;
 * - loading, empty, error-with-retry and access-denied states are
 *   first-class (role=status / role=alert).
 *
 * Mountable, shell-free component: data arrives via props; the demo data is
 * a deterministic fixture-shaped seed (the contract fixtures carry no
 * visits; WD-012 adds none outside the API store).
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  actionLabel,
  projectHistoryVisits,
  summarizeHistory,
  type HistoryVisit,
} from './visitModel';

export interface VisitHistoryPanelProps {
  /** Site whose history is shown. */
  readonly siteId?: string;
  /** History rows (already loaded); defaults to the deterministic demo seed for the site. */
  readonly visits?: readonly HistoryVisit[];
  /**
   * Whether the ACTING persona may see internal-class rows for this site
   * (the policy engine decides server-side; the shell passes the verdict
   * and this panel never guesses from a role label).
   */
  readonly canSeeInternal?: boolean;
  /** Data status. */
  readonly status?: 'loading' | 'ready' | 'error' | 'denied';
  /** Message shown in the error state. */
  readonly errorMessage?: string;
  /** Retry callback offered in the error state. */
  readonly onRetry?: () => void;
  /** Message shown in the denied state (403/404 surface). */
  readonly deniedMessage?: string;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

/** Deterministic demo seed: two visits, public + internal + wiring-note attachments. */
function demoVisitsFor(siteId: string): readonly HistoryVisit[] {
  return [
    {
      id: 'visit-demo-1001',
      siteId,
      actorId: 'principal-fatima-engineer',
      actorName: 'Fatima Al-Rashid',
      visitTime: '2026-03-12T15:30:00Z',
      recordedAt: '2026-03-12T16:00:00Z',
      type: 'inspection',
      actionIds: ['gauge-inspection', 'measurement-taken'],
      notes: 'Annual inspection; curve holding within tolerance.',
      lastChecked: '2026-03-12T15:00:00Z',
      lastRated: null,
      attachments: [
        { id: 'att-demo-1001', category: 'photo', visibility: 'public', filename: 'corinne-gauge-plate-2026-03.jpg', thumbnailPath: '/cache/attachments/att-demo-1001/thumb-96.jpg' },
        { id: 'att-demo-1002', category: 'wiring-note', visibility: 'internal', filename: 'wiring-notes-2026-03.txt', thumbnailPath: null },
      ],
      hiddenAttachmentCount: 0,
    },
    {
      id: 'visit-demo-1002',
      siteId,
      actorId: 'principal-fatima-engineer',
      actorName: 'Fatima Al-Rashid',
      visitTime: '2026-03-20T17:00:00Z',
      recordedAt: '2026-03-20T18:00:00Z',
      type: 'maintenance',
      actionIds: ['sensor-replacement', 'equipment-maintenance'],
      notes: 'FlumeLog 300 installed (dev-rtu-corinne-02); the pre-replacement inspection above keeps its own device context.',
      lastChecked: '2026-03-20T16:30:00Z',
      lastRated: '2026-03-20T17:00:00Z',
      attachments: [{ id: 'att-demo-1003', category: 'photo', visibility: 'public', filename: 'new-sensor-install.jpg', thumbnailPath: '/cache/attachments/att-demo-1003/thumb-96.jpg' }],
      hiddenAttachmentCount: 0,
    },
  ];
}

/** Keyboard navigation: arrows move between rows and cells, Tab moves between rows. */
function handleTableKeyDown(event: ReactKeyboardEvent<HTMLTableSectionElement>): void {
  const { key } = event;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
  const cell = (event.target as HTMLElement).closest<HTMLElement>('td,th');
  const row = (event.target as HTMLElement).closest<HTMLElement>('tr');
  if (!cell || !row) return;
  event.preventDefault();
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('tr[data-vh-row]'));
    const index = rows.indexOf(row);
    const next = rows[index + (key === 'ArrowDown' ? 1 : -1)];
    (next?.querySelector<HTMLElement>('td,th') ?? next)?.focus();
    return;
  }
  const cells = Array.from(row.querySelectorAll<HTMLElement>('td,th'));
  const index = cells.indexOf(cell);
  (cells[index + (key === 'ArrowRight' ? 1 : -1)] ?? cell).focus();
}

function formatDay(instant: string): string {
  return instant.slice(0, 10);
}

export default function VisitHistoryPanel({
  siteId = 'sta-bear-corinne',
  visits,
  canSeeInternal = false,
  status = 'ready',
  errorMessage,
  onRetry,
  deniedMessage,
}: VisitHistoryPanelProps) {
  const resolvedVisits = useMemo(() => visits ?? demoVisitsFor(siteId), [visits, siteId]);
  const projected = useMemo(() => projectHistoryVisits(resolvedVisits, { includeInternal: canSeeInternal }), [resolvedVisits, canSeeInternal]);
  const summary = useMemo(() => summarizeHistory(siteId, resolvedVisits), [resolvedVisits, siteId]);
  const [showAllActions, setShowAllActions] = useState(false);
  const shownActions = showAllActions ? 8 : 3;

  return (
    <section className="panel" aria-label="Site visit and inspection history">
      <div className="panel-heading">
        <div>
          <h2>Visits and inspection history</h2>
          <span>
            Append-only per site · visit time and recorded time labelled separately · structured last checked / last rated dates
            survive equipment replacement
          </span>
        </div>
        <span className="mini-pill">FR-046 · FR-049</span>
      </div>

      {status === 'loading' && (
        <p role="status" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Loading visit history…
        </p>
      )}

      {status === 'error' && (
        <div role="alert" style={{ padding: '14px 19px', margin: 0 }}>
          <p style={{ fontSize: 11, margin: '0 0 10px', color: '#8a4b3c' }}>{errorMessage ?? 'Visit history is unavailable.'}</p>
          {onRetry !== undefined && (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'denied' && (
        <div role="alert" style={{ padding: '14px 19px', margin: 0 }}>
          <p style={{ fontSize: 11, margin: 0, color: '#8a4b3c' }}>
            {deniedMessage ?? 'You are not permitted to view this site\u2019s visit history.'}
          </p>
        </div>
      )}

      {status === 'ready' && projected.length === 0 && (
        <p role="note" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          No visits recorded for this site yet.
        </p>
      )}

      {status === 'ready' && projected.length > 0 && (
        <>
          <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8', display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10 }}>
            <span>
              <strong>Visits:</strong> {summary.visitCount}
            </span>
            <span>
              <strong>Last visit:</strong> {summary.lastVisitTime ?? '—'}
            </span>
            <span>
              <strong>Last checked:</strong> {summary.lastChecked ?? 'never'}
            </span>
            <span>
              <strong>Last rated:</strong> {summary.lastRated ?? 'never'}
            </span>
            <span className="muted">
              {canSeeInternal ? 'Engineer view: internal attachments and notes visible.' : 'Public view: notes and internal attachments are not part of this projection.'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="site-table" aria-describedby="vh-note">
              <caption className="sr-only">
                Visit, maintenance and inspection history. Visit time is when the crew was on site; recorded time is when the visit
                was logged. Internal attachments are marked with the word internal.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Visit</th>
                  <th scope="col">Visit time (on site)</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">By</th>
                  <th scope="col">Type</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Attachments</th>
                  <th scope="col">Checked / rated</th>
                </tr>
              </thead>
              <tbody onKeyDown={handleTableKeyDown}>
                {projected.map((visit) => (
                  <tr key={visit.id} data-vh-row>
                    <th scope="row" tabIndex={0} title={`Visit ${visit.id} (append-only history entry ${visit.id})`}>
                      {visit.id}
                    </th>
                    <td tabIndex={-1}>
                      {formatDay(visit.visitTime)}
                      <small style={SMALL_MUTED}>{visit.visitTime}</small>
                    </td>
                    <td tabIndex={-1}>
                      {formatDay(visit.recordedAt)}
                      <small style={SMALL_MUTED}>{visit.recordedAt}</small>
                    </td>
                    <td tabIndex={-1}>{visit.actorName}</td>
                    <td tabIndex={-1}>{visit.type}</td>
                    <td tabIndex={-1} style={{ maxWidth: 180, whiteSpace: 'normal' }}>
                      {visit.actionIds.slice(0, shownActions).map(actionLabel).join(', ')}
                      {visit.actionIds.length > shownActions && (
                        <button type="button" className="button small" style={{ marginLeft: 4 }} onClick={() => setShowAllActions(true)}>
                          +{visit.actionIds.length - shownActions} more
                        </button>
                      )}
                    </td>
                    <td tabIndex={-1} style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                      {visit.attachments.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        visit.attachments.map((attachment) => (
                          <span key={attachment.id} style={{ display: 'block' }}>
                            {attachment.thumbnailPath !== null ? '▣' : '▤'}{' '}
                            <span aria-hidden>{attachment.visibility === 'internal' ? '▸ internal · ' : ''}</span>
                            {attachment.filename}
                            <small style={SMALL_MUTED}>{attachment.category}</small>
                          </span>
                        ))
                      )}
                    </td>
                    <td tabIndex={-1}>
                      {visit.lastChecked !== null ? (
                        <span>
                          checked {formatDay(visit.lastChecked)}
                          <br />
                        </span>
                      ) : null}
                      {visit.lastRated !== null ? <span>rated {formatDay(visit.lastRated)}</span> : null}
                      {visit.lastChecked === null && visit.lastRated === null ? <span className="muted">—</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p id="vh-note" style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
            Visit history is append-only: entries are never rewritten, so inspections recorded before an equipment replacement keep
            their place and dates. ▸ internal marks attachments that never appear in public APIs, thumbnails, exports or reports
            (FR-049).
          </p>
        </>
      )}
    </section>
  );
}
