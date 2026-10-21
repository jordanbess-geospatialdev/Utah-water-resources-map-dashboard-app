/**
 * ViolationsPanel - the FR-016 violation digest and subscription management.
 *
 * "Users choose system or stream scope and hourly, twice-daily, daily or
 * weekly cadence; each digest contains only authorized violating streams,
 * supports violation-type sorting, and links to the matching context."
 *
 * Renders the acting persona's digest (already scope- and
 * authorization-filtered server-side): entries sortable by violation type
 * or time, every entry linking to the matching filtered context, dedupe and
 * omission counts as transparency notes, and the subscription manager
 * (scope + cadence). Internal streams appear only because the server
 * admitted them for THIS recipient - never by client decision.
 *
 * Mountable, shell-free component; props default to demo state mirroring
 * the reviewed expected outcomes (the Bear engineer digest: all 20 fixture
 * violations, none omitted).
 */
import { useMemo, useState } from 'react';
import {
  CADENCES,
  CADENCE_LABELS,
  DEMO_DIGEST_COUNTS,
  DEMO_DIGEST_ENTRIES,
  DEMO_SUBSCRIPTIONS,
  violationRows,
  type DigestCadence,
  type DigestCountsView,
  type SubscriptionView,
  type ViolationEntryView,
} from './qualityModel';

export interface ViolationsPanelProps {
  /** Digest entries for the acting persona (server-filtered). */
  readonly entries?: readonly ViolationEntryView[];
  readonly counts?: DigestCountsView;
  /** Digest window label, e.g. '2026-03-09 07:00 → 08:00 UTC'. */
  readonly windowLabel?: string;
  readonly recipientLabel?: string;
  readonly subscriptions?: readonly SubscriptionView[];
  readonly onAddSubscription?: (input: { scopeKind: 'system' | 'stream'; scopeId: string; cadence: DigestCadence }) => void;
  readonly onRemoveSubscription?: (subscriptionId: string) => void;
}

export default function ViolationsPanel({
  entries = DEMO_DIGEST_ENTRIES,
  counts = DEMO_DIGEST_COUNTS,
  windowLabel = '2026-03-09 07:00 → 08:00 UTC',
  recipientLabel = 'Fatima (engineer, Bear River)',
  subscriptions = DEMO_SUBSCRIPTIONS,
  onAddSubscription,
  onRemoveSubscription,
}: ViolationsPanelProps) {
  const [sortBy, setSortBy] = useState<'type' | 'time'>('type');
  const rows = useMemo(() => violationRows(entries, { sortBy }), [entries, sortBy]);
  const [scopeKind, setScopeKind] = useState<'system' | 'stream'>('system');
  const [scopeId, setScopeId] = useState('sys-bear-river');
  const [cadence, setCadence] = useState<DigestCadence>('daily');

  return (
    <section className="panel" aria-label="QC violation digest">
      <div className="panel-heading">
        <div>
          <h2>Violation digest</h2>
          <span>
            Only streams within your authorization · violation-type sorting · links to the matching filtered context
          </span>
        </div>
        <span className="mini-pill">FR-016 · {recipientLabel}</span>
      </div>

      <div style={{ padding: '10px 19px', borderBottom: '1px solid #e9ede8', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 10 }}>
        <span>
          Window {windowLabel} · <strong>{counts.included}</strong> included · {counts.duplicatesDropped} duplicates
          collapsed · {counts.omittedForAuthorization} omitted (outside your authorization) · {counts.alreadyDelivered}{' '}
          already delivered
        </span>
        <label htmlFor="qc-sort" style={{ fontWeight: 650 }}>
          Sort
        </label>
        <select
          id="qc-sort"
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value === 'time' ? 'time' : 'type')}
          style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
        >
          <option value="type">By violation type</option>
          <option value="time">By time</option>
        </select>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="site-table">
          <caption className="sr-only">
            QC violations delivered in this digest window, sorted by violation type, each linking to the matching
            filtered context.
          </caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Stream</th>
              <th scope="col">Interval (UTC)</th>
              <th scope="col">Observed</th>
              <th scope="col">Rationale</th>
              <th scope="col">Context</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.ruleId}-v${row.ruleVersion}-${row.streamId}-${row.intervalLabel}`}>
                <th scope="row">{row.typeLabel}</th>
                <td>{row.streamId}</td>
                <td>{row.intervalLabel}</td>
                <td>{row.observed}</td>
                <td style={{ maxWidth: 320, whiteSpace: 'normal' }}>{row.rationale}</td>
                <td>
                  <a href={`#/quality/violations?${row.contextLink}`}>Matching context</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p role="note" style={{ padding: '14px 19px', fontSize: 11, margin: 0 }}>
          No authorized violations in this window.
        </p>
      )}

      <div style={{ padding: '13px 19px', borderTop: '1px solid #e9ede8' }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>QC subscriptions</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 10 }}>
          {subscriptions.map((subscription) => (
            <li key={subscription.id}>
              {subscription.scope.kind === 'system' ? `System ${subscription.scope.id}` : `Stream ${subscription.scope.id}`}{' '}
              · {CADENCE_LABELS[subscription.cadence]} · next digest {subscription.nextDueAt.slice(0, 16).replace('T', ' ')} UTC{' '}
              {onRemoveSubscription ? (
                <button type="button" className="button small" onClick={() => onRemoveSubscription(subscription.id)}>
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {onAddSubscription ? (
          <form
            style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              onAddSubscription({ scopeKind, scopeId, cadence });
            }}
          >
            <label htmlFor="qc-sub-scope-kind">Scope</label>
            <select
              id="qc-sub-scope-kind"
              value={scopeKind}
              onChange={(event) => setScopeKind(event.target.value === 'stream' ? 'stream' : 'system')}
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
            >
              <option value="system">System</option>
              <option value="stream">Stream</option>
            </select>
            <label htmlFor="qc-sub-scope-id">Id</label>
            <input
              id="qc-sub-scope-id"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de', width: 170 }}
            />
            <label htmlFor="qc-sub-cadence">Cadence</label>
            <select
              id="qc-sub-cadence"
              value={cadence}
              onChange={(event) => setCadence(event.target.value as DigestCadence)}
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
            >
              {CADENCES.map((option) => (
                <option key={option} value={option}>
                  {CADENCE_LABELS[option]}
                </option>
              ))}
            </select>
            <button type="submit" className="button small">
              Subscribe
            </button>
          </form>
        ) : (
          <p style={{ fontSize: 9, color: '#9caa97', margin: '8px 0 0' }}>
            Subscription management activates when the API loader is wired (demo state is read-only).
          </p>
        )}
      </div>
    </section>
  );
}
