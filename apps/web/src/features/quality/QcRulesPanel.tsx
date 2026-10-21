/**
 * QcRulesPanel - the FR-015 versioned QC rule console.
 *
 * "Range including voltage, rate-of-change, persistence, missing-data and
 * zero-value rules detect known fixture violations; each rule stores author
 * and update time, runs independently, and can be tested before promotion."
 *
 * Renders the rule list with versions, authors and status (text + shape:
 * ○ draft, ◐ fixture-tested, ● promoted), a TEST-RUN button that shows the
 * fixture outcomes BEFORE promotion (the per-version run result with its
 * violation count, or the recorded failure), the steward-only promote button
 * (disabled with its reason until the entitlement gate + a passing fixture
 * test exist), and the isolation banner: a failed rule never hides the
 * successes of its siblings.
 *
 * Mountable, shell-free component (WD-013 must not edit persona_ui's
 * App.tsx): data comes through props, defaulting to a demo state that
 * mirrors the reviewed expected outcomes (services/api/src/workflows/qc/
 * expected.ts, reviewed-pending-owner-approval). An API-backed loader
 * replaces the defaults without touching this component.
 */
import { useMemo, type CSSProperties } from 'react';
import {
  runStatusBadge,
  ruleRows,
  runSummary,
  type RuleVersionView,
  type RunResultView,
} from './qualityModel';
import { DEMO_RULES, DEMO_RUN_RESULTS } from './qualityModel';

export interface QcRulesPanelProps {
  /** Rule versions (all versions listed; the API loader supplies run history). */
  readonly rules?: readonly RuleVersionView[];
  /** Run results (test + monitoring) for the isolation view. */
  readonly runs?: readonly RunResultView[];
  /** Whether the ACTING persona passes the steward gate (server-decided). */
  readonly canPromote?: boolean;
  /** Display name of the acting persona. */
  readonly actorLabel?: string;
  readonly onTestRun?: (ruleId: string, version: number) => void;
  readonly onPromote?: (ruleId: string, version: number) => void;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

export default function QcRulesPanel({
  rules = DEMO_RULES,
  runs = DEMO_RUN_RESULTS,
  canPromote = true,
  actorLabel = 'Diego (steward)',
  onTestRun,
  onPromote,
}: QcRulesPanelProps) {
  const rows = useMemo(() => ruleRows(rules, runs, { canPromote }), [rules, runs, canPromote]);
  const summary = useMemo(() => runSummary(runs), [runs]);

  return (
    <section className="panel" aria-label="QC rules">
      <div className="panel-heading">
        <div>
          <h2>QC rules</h2>
          <span>
            Five versioned rule families · test on fixtures before promotion · steward-only promote · a failing rule never
            stops the others
          </span>
        </div>
        <span className="mini-pill">FR-015 · acting: {actorLabel}</span>
      </div>

      <p role="note" style={{ padding: '10px 19px', fontSize: 10, color: '#7b8982', margin: 0, borderBottom: '1px solid #e9ede8' }}>
        Last monitoring pass: {summary.succeeded} succeeded · {summary.failed} failed · {summary.totalViolations} fixture
        violations. Status markers: ○ draft · ◐ fixture-tested · ● promoted (text and shape, never color alone).
        {summary.failureNotes.map((note) => (
          <span key={note} style={{ display: 'block', color: '#8a4b3c' }}>
            ✕ {note}
          </span>
        ))}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="site-table">
          <caption className="sr-only">
            Versioned QC rules with author, update time, lifecycle status and the latest isolated run result per version.
          </caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Version</th>
              <th scope="col">Author</th>
              <th scope="col">Updated (UTC)</th>
              <th scope="col">Status</th>
              <th scope="col">Last run on fixtures</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const runBadge = row.lastRun === null ? null : runStatusBadge(row.lastRun.status);
              return (
                <tr key={`${row.ruleId}-v${row.version}`}>
                  <th scope="row">{row.familyLabel}</th>
                  <td>v{row.version}</td>
                  <td>{row.author}</td>
                  <td>{row.updatedAt}</td>
                  <td>
                    <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
                      {row.statusMarker}
                    </span>
                    {row.statusText}
                  </td>
                  <td>
                    {row.lastRun === null ? (
                      <span className="muted">not run</span>
                    ) : (
                      <>
                        <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
                          {runBadge!.marker}
                        </span>
                        {runBadge!.text}
                        {row.lastRun.status === 'success' ? ` · ${row.lastRun.violationCount} violation${row.lastRun.violationCount === 1 ? '' : 's'}` : null}
                        {row.lastRun.error !== null && (
                          <small style={{ display: 'block', fontSize: 9, color: '#8a4b3c', marginTop: 2 }}>{row.lastRun.error}</small>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button small"
                      onClick={() => onTestRun?.(row.ruleId, row.version)}
                      disabled={onTestRun === undefined}
                      title={onTestRun === undefined ? 'Demo state: wire the API loader to run tests' : 'Run this version against the fixture series'}
                    >
                      Test on fixtures
                    </button>{' '}
                    <button
                      type="button"
                      className="button small"
                      onClick={() => onPromote?.(row.ruleId, row.version)}
                      disabled={onPromote === undefined || row.promoteBlockedReason !== null}
                      title={row.promoteBlockedReason ?? 'Promote this version (steward gate + passing fixture test required)'}
                    >
                      Promote
                    </button>
                    {row.promoteBlockedReason !== null && (
                      <small style={SMALL_MUTED}>{row.promoteBlockedReason}</small>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ padding: '10px 19px', fontSize: 9, color: '#9caa97', margin: 0 }}>
        Promotion requires a prior successful test run against the fixtures and passes the steward entitlement gate; every
        rule executes in isolation, so the failed run above left the other counts intact.
      </p>
    </section>
  );
}
