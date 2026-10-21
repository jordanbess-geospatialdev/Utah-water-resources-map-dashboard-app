/**
 * OperationsWorkspace - the FR-019 assigned operations workspace UI.
 *
 * "Assigned work: commissioner/engineer sites within explicit assignment
 * scope; separate public browse tab" (technical specification, "Screens and
 * interaction states"), plus the FR-036 engineer diagnostics section and the
 * FR-038 known-issues context.
 *
 * Every authorization verdict comes from the derivation in assignedScope.ts
 * driven by the injected policy evaluator - this component renders verdicts,
 * it never decides them. Internal diagnostics (gate codes, wiring notes,
 * voltage streams) reach the DOM only through the projection layer's
 * entitlement path (`projectStation(...).internal`) gated by the engine's
 * internal-class verdict; the raw fixture `station.internal` block is never
 * read here.
 *
 * Accessibility contract:
 * - tabs use role=tablist/tab with ArrowLeft/ArrowRight/Home/End keyboard
 *   operation and aria-selected state (WAI-ARIA tabs pattern);
 * - status is always text + shape (freshness/processing indicators), never
 *   color alone;
 * - loading uses role=status, denials and errors use role=alert;
 * - the site list is a real list with focusable headings; stream tables use
 *   caption + scope="col"/"row".
 *
 * Mountable, shell-free component (WD-009 may not edit the shell): the
 * default policy port is the fixture mirror (./fixturePolicy.ts,
 * cross-checked against the real engine in siteWorkspace.test.ts); the
 * one-line real wiring is documented in README.md.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FlagIndicator, FreshnessIndicator, StatusIndicator } from '../../components/StatusIndicator';
import { formatDateMT, formatFlow, formatTimeMT } from '../../components/Chart';
import {
  FIXTURE_SEED,
  principalName,
  propertyName,
  stationById,
  systemName,
} from '../../shell/data/fixtures';
import { latestReading, stationFreshness, streamSeries } from '../../shell/data/observations';
import { projectStation, type DemoRole, type Viewer } from '../../shell/data/projection';
import type { StationRecord } from '../../shell/data/types';
import { DISCOVERY_DIMENSIONS, stationMatchesFilters, type DiscoveryFilterSet } from '../discovery/filters';
import {
  deriveAssignedScope,
  publicBrowseRows,
  type AssignedEmptyReason,
  type AssignedScope,
  type AssignedSiteRow,
  type PolicyEvaluator,
  type PolicyWorldMirror,
} from './assignedScope';
import { fixturePolicyPort } from './fixturePolicy';
import { issueStatusText, knownIssuesForViewer, type VisibleKnownIssue } from './knownIssues';

export interface OperationsWorkspaceProps {
  /** Acting principal (session identity). Default null: anonymous - denied assigned tab, public browse intact. */
  readonly principalId?: string | null;
  /** Demo role for the projection entitlement path (defaults to the principal's first fixture role). */
  readonly role?: DemoRole;
  /** Owner organization for the demo projection path (water-user personas). */
  readonly organizationId?: string | null;
  /** Policy world; defaults to the fixture mirror world. */
  readonly world?: PolicyWorldMirror;
  /** Policy evaluator; defaults to the fixture mirror evaluator. */
  readonly policy?: PolicyEvaluator;
  /** Injected clock; defaults to the fixed fixture clock. */
  readonly now?: Date | string;
  /** Quick filters over the discovery filter model (read-only reuse of features/discovery). */
  readonly filters?: DiscoveryFilterSet;
  readonly onFiltersChange?: (filters: DiscoveryFilterSet) => void;
  /** Data status of the workspace derivation; the component itself is synchronous. */
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Assignment version the caller last cached; a mismatch raises the stale-state notice. */
  readonly cachedAssignmentVersion?: number;
  readonly defaultTab?: 'assigned' | 'public';
}

type TabKey = 'assigned' | 'public';

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

const DEMO_ROLES: readonly DemoRole[] = ['public', 'water-user', 'researcher', 'commissioner', 'engineer', 'steward', 'deputy'];

function viewerFor(principalId: string | null, role: DemoRole | undefined, organizationId: string | null, world: PolicyWorldMirror): Viewer {
  let resolved: DemoRole | undefined = role;
  if (resolved === undefined && principalId !== null) {
    const fixtureRole = world.principals[principalId]?.roles[0];
    if (fixtureRole && (DEMO_ROLES as readonly string[]).includes(fixtureRole)) resolved = fixtureRole as DemoRole;
  }
  return { personaId: principalId ?? 'anonymous', role: resolved ?? 'public', principalId, organizationId };
}

// ---------------------------------------------------------------------------
// Quick filters (discovery filter model, read-only reuse)
// ---------------------------------------------------------------------------

function dimensionSelect(key: 'siteStatusIds' | 'telemetry') {
  return DISCOVERY_DIMENSIONS.find((dimension) => dimension.key === key);
}

interface QuickFilterSelectProps {
  readonly keyName: 'siteStatusIds' | 'telemetry';
  readonly label: string;
  readonly filters: DiscoveryFilterSet;
  readonly onChange: (filters: DiscoveryFilterSet) => void;
}

function QuickFilterSelect({ keyName, label, filters, onChange }: QuickFilterSelectProps) {
  const dimension = dimensionSelect(keyName);
  const selected = (filters[keyName] as readonly string[] | undefined) ?? [];
  return (
    <label style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontWeight: 650 }}>{label}</span>
      <select
        value={selected[0] ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          const next: Record<string, unknown> = { ...filters };
          delete next[keyName];
          if (value !== '') next[keyName] = [value];
          onChange(next as unknown as DiscoveryFilterSet);
        }}
        style={{ fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
      >
        <option value="">No constraint</option>
        {(dimension?.values ?? []).map((value) => (
          <option key={value.id} value={value.id}>
            {value.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Empty / denied / delegation notices
// ---------------------------------------------------------------------------

const DENIED_REASONS: readonly AssignedEmptyReason[] = ['anonymous', 'unknown-principal', 'principal-inactive'];

function deniedText(reason: AssignedEmptyReason): string {
  switch (reason) {
    case 'anonymous':
      return 'Assigned work requires a signed-in account. Public browsing stays available on the Browse public tab.';
    case 'unknown-principal':
      return 'This account is not present in the current world snapshot; no assigned work can be derived for it.';
    case 'principal-inactive':
      return 'This account is deactivated. The actor remains identifiable in history, but every protected decision denies.';
    default:
      return 'No assigned work is currently available.';
  }
}

function emptyNoticeText(reason: AssignedEmptyReason): string {
  switch (reason) {
    case 'delegation-not-effective':
      return 'Your deputy delegation is not in effect yet at this clock; the assigned tab shows nothing until the delegation window opens.';
    case 'delegation-expired':
      return 'Your deputy delegation window has closed; the assigned tab is empty. Public browsing remains available.';
    case 'assignment-revoked':
      return 'Your assignment was revoked. Operational rows were removed on this derivation (revocation wins over any cached view).';
    case 'assignment-expired':
      return 'Your assignment expired; operational rows were removed on this derivation.';
    case 'assignment-not-effective':
      return 'Your assignment is not effective yet at this clock.';
    case 'no-operational-capability':
      return 'Your account holds no operational capability over any station; there is no assigned work to show.';
    case 'no-sites-in-scope':
      return 'Your grants are effective but cover no station in the current world snapshot.';
    default:
      return 'No assigned sites.';
  }
}

function ScopeNotice({ scope }: { readonly scope: AssignedScope }) {
  if (scope.delegation === null) return null;
  return (
    <p style={{ fontSize: 9, color: '#7b8982', margin: '6px 0 0' }}>
      Delegation window {formatDateMT(scope.delegation.effectiveAt)} → {formatDateMT(scope.delegation.expiresAt)}, delegated by{' '}
      {principalName(scope.delegation.delegatedBy)}. Evaluated at {scope.evaluatedAt} (assignment version {scope.assignmentVersion}).
    </p>
  );
}

// ---------------------------------------------------------------------------
// Known issues (FR-038)
// ---------------------------------------------------------------------------

function KnownIssueList({ issues }: { readonly issues: readonly VisibleKnownIssue[] }) {
  if (issues.length === 0) return <p className="muted" style={{ fontSize: 9, margin: '4px 0 0' }}>No known issues carried for this site.</p>;
  return (
    <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
      {issues.map(({ issue }) => (
        <li key={issue.id} style={{ fontSize: 9, lineHeight: 1.7 }}>
          <details>
            <summary style={{ cursor: 'pointer' }}>
              <strong>{issue.title}</strong> · {issueStatusText(issue.status)} · {issue.visibility} visibility
            </summary>
            <p style={{ margin: '4px 0', color: '#7b8982' }}>{issue.description}</p>
            <p style={{ margin: '4px 0' }}>
              Affected stream {issue.streamId} · interval {formatDateMT(issue.interval.start)} {formatTimeMT(issue.interval.start)} →{' '}
              {formatDateMT(issue.interval.end)} {formatTimeMT(issue.interval.end)} (half-open).
            </p>
            <p style={{ margin: '4px 0', fontWeight: 650 }}>Resolution history ({issue.resolutionHistory.length} event{issue.resolutionHistory.length === 1 ? '' : 's'})</p>
            <ol style={{ margin: '2px 0 4px', paddingLeft: 16 }}>
              {issue.resolutionHistory.map((event) => (
                <li key={`${issue.id}:${event.at}`}>
                  {formatDateMT(event.at)} {formatTimeMT(event.at)} · {principalName(event.actorId)} · {event.outcome} — {event.note}
                </li>
              ))}
            </ol>
          </details>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics (FR-036) - projection entitlement path only, never raw
// ---------------------------------------------------------------------------

function DiagnosticsDetails({ row, station, viewer }: { readonly row: AssignedSiteRow; readonly station: StationRecord; readonly viewer: Viewer }) {
  // The internal block is read through the projection layer's entitlement
  // path (projectStation strips it unless the viewer's entitlement covers
  // it) AND gated by the engine verdict; station.internal is never touched.
  const projection = projectStation(viewer, station);
  const internalBlock = row.internalBlockReadable ? projection?.internal ?? null : null;
  const diagnosticStreams = row.streams.filter((stream) => stream.diagnostic);
  if (!row.internalBlockReadable && diagnosticStreams.every((stream) => !stream.allowed)) {
    return <p className="muted" style={{ fontSize: 9, margin: '4px 0 0' }}>Diagnostics require an internal-field capability in scope (FR-036).</p>;
  }
  return (
    <details style={{ fontSize: 10, marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>
        Diagnostics · {diagnosticStreams.filter((stream) => stream.allowed).length} internal stream
        {diagnosticStreams.filter((stream) => stream.allowed).length === 1 ? '' : 's'}
        {row.internalBlockReadable ? ' · internal block' : ''}
      </summary>
      {row.internalBlockReadable && (
        <div style={{ background: '#fafcf9', border: '1px solid #e9ede8', borderRadius: 4, padding: '6px 10px', margin: '6px 0' }}>
          <h4 style={{ fontSize: 9, margin: '0 0 4px' }}>Internal block (projection entitlement path)</h4>
          {internalBlock ? (
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', margin: 0, fontSize: 9 }}>
              <dt style={{ color: '#8c9a8f' }}>Gate code:</dt>
              <dd style={{ margin: 0 }}>{internalBlock.gateCode}</dd>
              <dt style={{ color: '#8c9a8f' }}>Wiring notes:</dt>
              <dd style={{ margin: 0 }}>{internalBlock.wiringNotes}</dd>
            </dl>
          ) : (
            <p className="muted" style={{ fontSize: 9, margin: 0 }}>
              Engine allows the internal-field read but the projection withheld the block; nothing is rendered raw.
            </p>
          )}
        </div>
      )}
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Internal diagnostic streams with latest readings (engine verdict per stream).</caption>
        <thead>
          <tr>
            <th scope="col">Stream</th>
            <th scope="col">Latest</th>
            <th scope="col">Observed</th>
            <th scope="col">Flags</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {diagnosticStreams.map((stream) => {
            const record = station.datastreams.find((candidate) => candidate.id === stream.streamId);
            const last = streamSeries(stream.streamId).at(-1) ?? null;
            return (
              <tr key={stream.streamId}>
                <th scope="row">
                  {propertyName.get(record?.observedPropertyId ?? '') ?? stream.streamId}
                  <small style={SMALL_MUTED}>{stream.streamId}</small>
                </th>
                <td>{last ? formatFlow(last.best, last.unitId) : 'no readings'}</td>
                <td>{last ? `${formatDateMT(last.observedAt)} ${formatTimeMT(last.observedAt)}` : '—'}</td>
                <td>{last && last.flags.length > 0 ? last.flags.map((flag) => <FlagIndicator key={flag} value={flag} />) : <span className="muted">—</span>}</td>
                <td>{stream.allowed ? <span>Allowed ({stream.reason})</span> : <span className="muted">Denied ({stream.reason})</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Site rows
// ---------------------------------------------------------------------------

function AssignedSiteArticle({
  row,
  station,
  viewer,
  issues,
}: {
  readonly row: AssignedSiteRow;
  readonly station: StationRecord | undefined;
  readonly viewer: Viewer;
  readonly issues: readonly VisibleKnownIssue[];
}) {
  const freshness = station ? stationFreshness(station) : 'no-data';
  const latest = station ? latestReading(station) : null;
  const header = `${station?.displayName ?? row.stationId}`;
  return (
    <li style={{ borderBottom: '1px solid #e9ede8', padding: '12px 19px' }}>
      <article aria-label={`Assigned site ${header}`}>
        <h3 style={{ fontSize: 11, margin: '0 0 4px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span tabIndex={0}>{header}</span>
          <FreshnessIndicator value={freshness} />
          <span className="mini-pill" title="Row visibility of the station record">{row.visibility}</span>
          <span className="mini-pill" title="Lifecycle state">{row.status}</span>
        </h3>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0, fontSize: 10 }}>
          <dt style={{ color: '#8c9a8f' }}>System:</dt>
          <dd style={{ margin: 0 }}>{systemName(row.systemId)} ({row.systemId})</dd>
          <dt style={{ color: '#8c9a8f' }}>Site id:</dt>
          <dd style={{ margin: 0 }}>{row.stationId}{station ? ` · ${station.externalId}` : ''}</dd>
          <dt style={{ color: '#8c9a8f' }}>Latest discharge:</dt>
          <dd style={{ margin: 0 }}>
            {latest ? (
              <>
                {formatFlow(latest.value, latest.unitId)} at {formatDateMT(latest.observedAt)} {formatTimeMT(latest.observedAt)} ({latest.processingLevel})
                {latest.value === null ? ' — no value reported, never zero' : ''}
              </>
            ) : (
              'no discharge stream on this site'
            )}
          </dd>
          <dt style={{ color: '#8c9a8f' }}>Streams (engine verdicts):</dt>
          <dd style={{ margin: 0 }}>
            {row.streams.length === 0 ? 'none' : row.streams.map((stream) => `${stream.streamId}: ${stream.allowed ? 'allowed' : `denied (${stream.reason})`}`).join(' · ')}
          </dd>
          <dt style={{ color: '#8c9a8f' }}>Admitted by:</dt>
          <dd style={{ margin: 0 }}>
            {row.admittedBy.reason} via {row.admittedBy.via}
            {row.admittedBy.matchedAssignmentIds.length > 0 ? ` (${row.admittedBy.matchedAssignmentIds.join(', ')})` : ''}
          </dd>
        </dl>
        <DiagnosticsDetails row={row} station={station ?? ({ id: row.stationId, datastreams: [] } as unknown as StationRecord)} viewer={viewer} />
        <div style={{ marginTop: 8 }}>
          <h4 style={{ fontSize: 9, margin: '0 0 2px', fontWeight: 700 }}>Known issues (FR-038)</h4>
          <KnownIssueList issues={issues} />
        </div>
      </article>
    </li>
  );
}

function PublicBrowseArticle({ stationId, issues }: { readonly stationId: string; readonly issues: readonly VisibleKnownIssue[] }) {
  const station = stationById.get(stationId);
  const freshness = station ? stationFreshness(station) : 'no-data';
  const latest = station ? latestReading(station) : null;
  return (
    <li style={{ borderBottom: '1px solid #e9ede8', padding: '12px 19px' }}>
      <article aria-label={`Public site ${station?.displayName ?? stationId}`}>
        <h3 style={{ fontSize: 11, margin: '0 0 4px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span tabIndex={0}>{station?.displayName ?? stationId}</span>
          <FreshnessIndicator value={freshness} />
          <StatusIndicator spec={{ shape: '◇', label: 'Public projection', tone: 'neutral' }} />
        </h3>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0, fontSize: 10 }}>
          <dt style={{ color: '#8c9a8f' }}>System:</dt>
          <dd style={{ margin: 0 }}>{station ? systemName(station.systemId) : ''}</dd>
          <dt style={{ color: '#8c9a8f' }}>Latest discharge:</dt>
          <dd style={{ margin: 0 }}>{latest ? `${formatFlow(latest.value, latest.unitId)} at ${formatDateMT(latest.observedAt)} ${formatTimeMT(latest.observedAt)}` : 'no discharge stream'}</dd>
        </dl>
        <div style={{ marginTop: 8 }}>
          <h4 style={{ fontSize: 9, margin: '0 0 2px', fontWeight: 700 }}>Known issues (public visibility only)</h4>
          <KnownIssueList issues={issues} />
        </div>
      </article>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Tabs (WAI-ARIA tabs pattern)
// ---------------------------------------------------------------------------

function TabButton({
  keyName,
  active,
  onSelect,
  children,
  badge,
}: {
  readonly keyName: TabKey;
  readonly active: boolean;
  readonly onSelect: (tab: TabKey) => void;
  readonly children: React.ReactNode;
  readonly badge?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`ops-tab-${keyName}`}
      aria-selected={active}
      aria-controls={`ops-panel-${keyName}`}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(keyName)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const order: TabKey[] = ['assigned', 'public'];
          const current = order.indexOf(keyName);
          let next = current;
          if (event.key === 'ArrowRight') next = (current + 1) % order.length;
          if (event.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = order.length - 1;
          onSelect(order[next]!);
          document.getElementById(`ops-tab-${order[next]!}`)?.focus();
        }
      }}
      className="button small"
      style={active ? undefined : { opacity: 0.6 }}
    >
      {children}
      {badge !== undefined ? ` (${badge})` : ''}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The workspace panel
// ---------------------------------------------------------------------------

/**
 * The FR-019 operations workspace: assigned sites derived from live policy
 * grants (deputy delegation windows, engineer capability variants, immediate
 * revocation effects), a separate public browse tab (public projection
 * only), engineer diagnostics and known-issues context.
 */
export default function OperationsWorkspace({
  principalId = null,
  role,
  organizationId = null,
  world,
  policy,
  now,
  filters,
  onFiltersChange,
  status = 'ready',
  errorMessage,
  onRetry,
  cachedAssignmentVersion,
  defaultTab = 'assigned',
}: OperationsWorkspaceProps) {
  const port = fixturePolicyPort();
  const resolvedWorld = world ?? port.world;
  const resolvedPolicy = policy ?? port.evaluate;
  const resolvedNow = now ?? port.now;

  const [internalFilters, setInternalFilters] = useState<DiscoveryFilterSet>({});
  const effectiveFilters = filters ?? internalFilters;
  const setFilters = onFiltersChange ?? setInternalFilters;

  const [tab, setTab] = useState<TabKey>(defaultTab);

  const scope = useMemo(
    () => deriveAssignedScope({ principalId, world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow }),
    [principalId, resolvedWorld, resolvedPolicy, resolvedNow],
  );
  const browse = useMemo(() => publicBrowseRows(resolvedWorld, resolvedPolicy, resolvedNow), [resolvedWorld, resolvedPolicy, resolvedNow]);
  const issues = useMemo(
    () => knownIssuesForViewer({ principalId, world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow }),
    [principalId, resolvedWorld, resolvedPolicy, resolvedNow],
  );
  const viewer = useMemo(() => viewerFor(principalId, role, organizationId, resolvedWorld), [principalId, role, organizationId, resolvedWorld]);

  const filteredRows = useMemo(
    () =>
      scope.siteRows.filter((row) => {
        const station = stationById.get(row.stationId);
        return station !== undefined ? stationMatchesFilters(station, effectiveFilters) : true;
      }),
    [scope.siteRows, effectiveFilters],
  );
  const filteredBrowse = useMemo(
    () =>
      browse.filter((row) => {
        const station = stationById.get(row.stationId);
        return station !== undefined ? stationMatchesFilters(station, effectiveFilters) : true;
      }),
    [browse, effectiveFilters],
  );

  const issuesForStation = (stationId: string): readonly VisibleKnownIssue[] => issues.carried.filter((entry) => entry.issue.stationId === stationId);
  const stale = cachedAssignmentVersion !== undefined && cachedAssignmentVersion !== scope.assignmentVersion;

  return (
    <section className="panel" aria-label="Assigned operations workspace">
      <div className="panel-heading">
        <div>
          <h2>Assigned work</h2>
          <span>
            Sites within explicit assignment scope · deputy delegation windows · engineer diagnostics · known issues · separate public browse
          </span>
        </div>
        <span className="mini-pill">FR-019 · FR-036 · FR-038 · seed {FIXTURE_SEED}</span>
      </div>

      <div
        role="tablist"
        aria-label="Workspace tabs"
        style={{ padding: '12px 19px', borderBottom: '1px solid #e9ede8', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <TabButton keyName="assigned" active={tab === 'assigned'} onSelect={setTab} badge={String(scope.siteRows.length)}>
          Assigned sites
        </TabButton>
        <TabButton keyName="public" active={tab === 'public'} onSelect={setTab} badge={String(browse.length)}>
          Browse public
        </TabButton>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }} role="group" aria-label="Quick filters (discovery filter model)">
          <QuickFilterSelect keyName="siteStatusIds" label="Site status" filters={effectiveFilters} onChange={setFilters} />
          <QuickFilterSelect keyName="telemetry" label="Telemetry" filters={effectiveFilters} onChange={setFilters} />
        </div>
      </div>

      {tab === 'assigned' ? (
        <div role="tabpanel" id="ops-panel-assigned" aria-labelledby="ops-tab-assigned">
          {status === 'loading' && (
            <p role="status" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
              Deriving your assigned workspace…
            </p>
          )}
          {status === 'error' && (
            <div role="alert" style={{ padding: '14px 19px' }}>
              <p style={{ fontSize: 11, margin: '0 0 10px', color: '#8a4b3c' }}>{errorMessage ?? 'The assigned workspace is unavailable.'}</p>
              {onRetry !== undefined && (
                <button type="button" className="button small" onClick={onRetry}>
                  Retry
                </button>
              )}
            </div>
          )}
          {status === 'ready' && stale && (
            <p role="status" style={{ margin: 0, padding: '10px 19px', fontSize: 10, borderBottom: '1px solid #e9ede8' }}>
              Assignment version changed (cached {cachedAssignmentVersion} → authoritative {scope.assignmentVersion}). Rows below are re-derived from
              the authoritative grants; a previously cached view is invalid (revocation takes effect immediately).
            </p>
          )}
          {status === 'ready' && scope.siteRows.length === 0 && (
            <div style={{ padding: '16px 19px' }}>
              {DENIED_REASONS.includes(scope.emptyReason ?? 'no-sites-in-scope') ? (
                <p role="alert" style={{ fontSize: 11, margin: 0, color: '#8a4b3c' }}>
                  {deniedText(scope.emptyReason ?? 'no-sites-in-scope')}
                </p>
              ) : (
                <p role="note" style={{ fontSize: 11, margin: 0 }}>
                  {emptyNoticeText(scope.emptyReason ?? 'no-sites-in-scope')}
                </p>
              )}
              <ScopeNotice scope={scope} />
            </div>
          )}
          {status === 'ready' && scope.siteRows.length > 0 && (
            <>
              <p style={{ padding: '10px 19px 0', fontSize: 9, color: '#7b8982', margin: 0 }}>
                {scope.displayName ?? scope.principalId} · {scope.systems.length} system{scope.systems.length === 1 ? '' : 's'} ·{' '}
                {scope.siteRows.length} site{scope.siteRows.length === 1 ? '' : 's'} · derived at {scope.evaluatedAt} (assignment version{' '}
                {scope.assignmentVersion}) · quick filters narrow this list only; they never widen scope.
              </p>
              <ScopeNotice scope={scope} />
              {filteredRows.length === 0 ? (
                <p role="note" style={{ padding: '12px 19px', fontSize: 11, margin: 0 }}>
                  Every assigned site is excluded by the current quick filters.
                </p>
              ) : (
                scope.systems.map((group) => (
                  <div key={group.systemId}>
                    <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '10px 19px 4px' }}>
                      {systemName(group.systemId)} <span className="muted">({group.systemId})</span>
                    </h3>
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                      {group.siteRows
                        .filter((row) => filteredRows.some((candidate) => candidate.stationId === row.stationId))
                        .map((row) => (
                          <AssignedSiteArticle key={row.stationId} row={row} station={stationById.get(row.stationId)} viewer={viewer} issues={issuesForStation(row.stationId)} />
                        ))}
                    </ul>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="ops-panel-public" aria-labelledby="ops-tab-public">
          <p style={{ padding: '10px 19px 0', fontSize: 9, color: '#7b8982', margin: 0 }}>
            Strict public projection: every row below is published by the engine&rsquo;s public branch. Internal diagnostics and restricted
            streams never appear here, and public browsing needs no account.
          </p>
          {filteredBrowse.length === 0 ? (
            <p role="note" style={{ padding: '12px 19px', fontSize: 11, margin: 0 }}>
              No published station matches the current quick filters.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {filteredBrowse.map((row) => (
                <PublicBrowseArticle key={row.stationId} stationId={row.stationId} issues={issuesForStation(row.stationId)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
