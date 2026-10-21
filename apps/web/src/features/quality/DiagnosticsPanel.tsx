/**
 * DiagnosticsPanel - the FR-036 engineering diagnostics view with FR-034
 * capacity threshold flags.
 *
 * "Authorized engineer views expose available discharge, level, voltage and
 * other relevant streams; internal diagnostics do not become public merely
 * because a site is public." / "Out-of-range fixture values trigger
 * labelled map and series indicators; thresholds are scoped and versioned
 * and the UI uses a symbol or text as well as color."
 *
 * The granted view lists the discharge, level(stage) and voltage streams in
 * the caller's scope - including INTERNAL streams such as the battery
 * voltage telemetry - each with its latest reading and its labelled
 * threshold flags (every badge carries a symbol AND a text label plus a
 * severity word, never color alone). Non-engineers get the denied state:
 * the server's status and reason, and no stream rows. The panel never
 * decides authorization itself; the `access` prop comes from the server
 * verdict (services/api/src/workflows/qc/diagnostics.ts).
 *
 * Mountable, shell-free component; props default to demo state mirroring
 * the fixture diagnostics (the internal voltage stream with its ▼
 * low-battery flag, the capacity ▲/‼ flags on the discharge series).
 */
import { useMemo } from 'react';
import { DEMO_DIAGNOSTIC_STREAMS, diagnosticsRows, type DiagnosticStreamView } from './qualityModel';

export interface DiagnosticsPanelProps {
  /** Server verdict for the acting persona ('granted' shows streams, 'denied' shows the alert). */
  readonly access?: 'granted' | 'denied';
  /** HTTP status and machine reason echoed by the server when denied. */
  readonly deniedStatus?: 401 | 403;
  readonly deniedReason?: string;
  readonly streams?: readonly DiagnosticStreamView[];
  readonly actorLabel?: string;
}

const VISIBILITY_NOTES: Readonly<Record<DiagnosticStreamView['visibility'], string>> = {
  public: 'public',
  restricted: 'restricted (assigned staff)',
  internal: 'internal - engineers only, never in public projections',
};

export default function DiagnosticsPanel({
  access = 'granted',
  deniedStatus = 403,
  deniedReason = 'DENY_CAPABILITY_NOT_GRANTED',
  streams = DEMO_DIAGNOSTIC_STREAMS,
  actorLabel = 'Fatima (engineer, Bear River)',
}: DiagnosticsPanelProps) {
  const rows = useMemo(() => (access === 'granted' ? diagnosticsRows(streams) : []), [access, streams]);

  return (
    <section className="panel" aria-label="Engineering diagnostics">
      <div className="panel-heading">
        <div>
          <h2>Engineering diagnostics</h2>
          <span>
            Discharge, level and voltage streams in your scope · scoped, versioned capacity thresholds · flags are symbol
            + text, never color alone
          </span>
        </div>
        <span className="mini-pill">FR-036 · FR-034 · {actorLabel}</span>
      </div>

      {access === 'denied' && (
        <div role="alert" style={{ padding: '14px 19px' }}>
          <p style={{ fontSize: 11, margin: 0, color: '#8a4b3c' }}>
            Engineering diagnostics are available to authorized engineers only (HTTP {deniedStatus}, {deniedReason}).
            Internal diagnostic streams never appear in public views, and a public site never makes its diagnostics
            public.
          </p>
        </div>
      )}

      {access === 'granted' && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="site-table">
              <caption className="sr-only">
                Engineer diagnostics: discharge, level and voltage streams in scope with latest readings and labelled
                threshold flags.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Stream</th>
                  <th scope="col">Property</th>
                  <th scope="col">Visibility</th>
                  <th scope="col">Latest reading</th>
                  <th scope="col">Threshold flags (symbol + text)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.streamId}>
                    <th scope="row">{row.streamId}</th>
                    <td>{row.propertyLabel}</td>
                    <td>{VISIBILITY_NOTES[row.visibility]}</td>
                    <td>{row.latestLabel}</td>
                    <td>
                      {row.badges.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        row.badges.map((badge) => (
                          <span key={`${badge.symbol}-${badge.label}`} style={{ display: 'block' }}>
                            <span aria-hidden style={{ fontWeight: 700, marginRight: 5 }}>
                              {badge.symbol}
                            </span>
                            {badge.text} <span className="muted">({badge.severityLabel})</span>
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
            Flags come from scoped, versioned threshold sets (steward-reviewed before promotion). The internal voltage
            stream and its flags are engineer-only: they are byte-swept out of every public projection.
          </p>
        </>
      )}
    </section>
  );
}
