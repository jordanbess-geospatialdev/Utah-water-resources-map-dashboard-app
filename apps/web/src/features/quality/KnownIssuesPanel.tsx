/**
 * KnownIssuesPanel - the FR-038 known data issues view.
 *
 * "Users record a known issue with affected stream and time interval, status
 * and visibility; affected charts and exports carry the permitted issue
 * context and resolution history."
 *
 * Renders the visibility-filtered issue list: affected stream + half-open
 * interval, status (text + shape: ● open, ◐ monitoring, ✓ resolved), the
 * visibility rule applied to charts and exports (public issues travel in
 * public exports; internal issues only in authorized ones), and the
 * APPEND-ONLY resolution history (seq, actor, transition, note, time).
 *
 * Mountable, shell-free component; props default to demo state mirroring
 * the fixture issues (the resolved public outage with its two-event history
 * and the open internal voltage issue).
 */
import { useMemo } from 'react';
import { DEMO_KNOWN_ISSUES, knownIssueRows, type KnownIssueView } from './qualityModel';

export interface KnownIssuesPanelProps {
  /** Issues the server already visibility-filtered for the acting persona. */
  readonly issues?: readonly KnownIssueView[];
  /** Whether the acting persona may see internal issues (server-decided). */
  readonly includeInternal?: boolean;
  readonly actorLabel?: string;
  readonly onStatusChange?: (issueId: string, to: 'monitoring' | 'resolved' | 'open', note: string) => void;
}

export default function KnownIssuesPanel({
  issues = DEMO_KNOWN_ISSUES,
  includeInternal = false,
  actorLabel = 'Anonymous (public view)',
  onStatusChange,
}: KnownIssuesPanelProps) {
  const visible = useMemo(() => issues.filter((issue) => issue.visibility === 'public' || includeInternal), [issues, includeInternal]);
  const rows = useMemo(() => knownIssueRows(visible), [visible]);

  return (
    <section className="panel" aria-label="Known data issues">
      <div className="panel-heading">
        <div>
          <h2>Known data issues</h2>
          <span>
            Stream + interval, status and visibility · resolution history is append-only · charts and exports carry the
            permitted issue context
          </span>
        </div>
        <span className="mini-pill">FR-038 · {actorLabel}</span>
      </div>

      {rows.length === 0 ? (
        <p role="note" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
          No known issues visible to this view.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <li key={row.id} style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
              <div style={{ fontSize: 11, fontWeight: 650 }}>
                <span aria-hidden style={{ marginRight: 6, fontWeight: 700 }}>
                  {row.statusMarker}
                </span>
                {row.title}
              </div>
              <div style={{ fontSize: 10, color: '#7b8982', marginTop: 3 }}>
                {row.streamId} · {row.intervalLabel} · status {row.statusText} · {row.visibility} — {row.visibilityNote}
              </div>
              <div style={{ fontSize: 10, color: '#7b8982', marginTop: 3 }}>
                Recorded {row.recordedLabel}
                {row.resolvedLabel !== null ? ` · resolved ${row.resolvedLabel}` : ''}
              </div>
              {row.history.length > 0 ? (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 10, cursor: 'pointer' }}>
                    Resolution history ({row.history.length} event{row.history.length === 1 ? '' : 's'}, append-only)
                  </summary>
                  <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 10 }}>
                    {row.history.map((event) => (
                      <li key={event.seq} value={event.seq}>
                        {event.from} → {event.to} by {event.actorId} at {event.at.slice(0, 16).replace('T', ' ')} UTC
                        {event.note.length > 0 ? ` — ${event.note}` : ''}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : (
                <div style={{ fontSize: 9, color: '#9caa97', marginTop: 6 }}>No resolution events yet.</div>
              )}
              {onStatusChange ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  <button type="button" className="button small" onClick={() => onStatusChange(row.id, 'monitoring', '')}>
                    Mark monitoring
                  </button>
                  <button type="button" className="button small" onClick={() => onStatusChange(row.id, 'resolved', '')}>
                    Resolve
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
        Public issues travel with public charts and exports; internal issues appear only in authorized exports. Status
        markers: ● open · ◐ monitoring · ✓ resolved (text and shape, never color alone).
      </p>
    </section>
  );
}
