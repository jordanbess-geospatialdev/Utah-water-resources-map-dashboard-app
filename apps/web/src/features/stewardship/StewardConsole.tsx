/**
 * StewardConsole - the FR-011..FR-014/FR-017 steward governance console UI
 * (technical specification screens table: "Users, assignments, universal
 * vocabulary, connection health and QC configuration").
 *
 * Tabs: vocabulary (create/retire with history), assignments (grant/revoke/
 * delegate with validity dates), ingestion (providers, configs, simulated
 * connection tests, the engineer request queue with steward promotion),
 * connection health (status board + weekday digest preview with the
 * Monday weekend rule visible) and usage analytics (aggregate counts with
 * the FR-017 exclusion note visible).
 *
 * Every access verdict comes from consoleModel.stewardConsoleAccess driven
 * by the injected policy evaluator - non-steward personas see the console
 * DENIED (403 for authenticated staff, 401 for identity failures), and this
 * component renders verdicts, it never decides them. All data arrives via
 * the StewardConsoleData bundle (the /admin endpoints once wired; the frozen
 * demo bundle until then). Mutations dispatch through optional callbacks -
 * with no callback the controls explain the pending shell wiring instead of
 * pretending to work.
 *
 * Accessibility contract (mirrors OperationsWorkspace):
 * - WAI-ARIA tabs with ArrowLeft/ArrowRight/Home/End and aria-selected;
 * - status is text + shape (✓/✕/⏱/●/○), never color alone;
 * - loading uses role=status, denials and errors use role=alert;
 * - tables carry caption + scope=col/scope=row.
 */
import { useId, useMemo, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { principalName, systemName } from '../../shell/data/fixtures';
import {
  assembleDigestPreview,
  assignmentRows,
  connectionTestLabel,
  DIGEST_RULES,
  healthRollup,
  healthStatusText,
  ingestionQueue,
  stewardConsoleAccess,
  termStatusBadge,
  usageTables,
  vocabularyChangeList,
  vocabularyRows,
  VOCABULARY_KIND_LABELS,
  type PolicyEvaluatorMirror,
  type PolicyWorldMirror,
  type StewardConsoleData,
  type VocabularyKindView,
} from './consoleModel';
import { demoConsoleData, demoPolicyPort } from './demoData';

export type StewardConsoleTab = 'vocabulary' | 'assignments' | 'ingestion' | 'health' | 'analytics';

export interface StewardConsoleActions {
  /** Steward vocabulary create (server: vocabulary.createTerm). */
  readonly onCreateTerm?: (input: { kind: VocabularyKindView; id: string; label: string; description?: string }) => void;
  /** Steward vocabulary retire - retirement preserves history (server: vocabulary.retireTerm). */
  readonly onRetireTerm?: (kind: VocabularyKindView, id: string) => void;
  /** Deputy delegation with effective/expiry dates (server: assignments.delegateDeputy). */
  readonly onDelegateDeputy?: (input: { principalId: string; scopeId: string; effectiveAt: string; expiresAt: string }) => void;
  /** Revocation - affects the next request (server: assignments.revoke). */
  readonly onRevokeAssignment?: (assignmentId: string) => void;
  /** Steward promotion of an engineer request (server: ingestion.promoteRequest). */
  readonly onPromoteRequest?: (configId: string) => void;
  /** Simulated staging connection test (server: ingestion.testConnection). */
  readonly onTestConnection?: (configId: string, mode: 'success' | 'auth-failure' | 'timeout') => void;
}

export interface StewardConsoleProps {
  /** Acting principal (session identity). Default null: anonymous - console denied. */
  readonly principalId?: string | null;
  readonly world?: PolicyWorldMirror;
  readonly policy?: PolicyEvaluatorMirror;
  readonly now?: Date | string;
  readonly data?: StewardConsoleData;
  readonly actions?: StewardConsoleActions;
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly defaultTab?: StewardConsoleTab;
}

type TabKey = StewardConsoleTab;

const TAB_ORDER: readonly TabKey[] = ['vocabulary', 'assignments', 'ingestion', 'health', 'analytics'];
const MUTED: CSSProperties = { color: '#8c9a8f' };
const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };
const PENDING_WIRING = 'Shell wiring pending - the server mutation endpoint is not connected yet (see README.md).';

function TabButton({ keyName, active, onSelect, badge }: { keyName: TabKey; active: boolean; onSelect: (tab: TabKey) => void; badge?: number | undefined }): React.JSX.Element {
  const labels: Readonly<Record<TabKey, string>> = {
    vocabulary: 'Vocabulary',
    assignments: 'Assignments',
    ingestion: 'Ingestion',
    health: 'Connection health',
    analytics: 'Usage analytics',
  };
  return (
    <button
      type="button"
      role="tab"
      id={`steward-tab-${keyName}`}
      aria-selected={active}
      aria-controls={`steward-panel-${keyName}`}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(keyName)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const current = TAB_ORDER.indexOf(keyName);
          let next = current;
          if (event.key === 'ArrowRight') next = (current + 1) % TAB_ORDER.length;
          if (event.key === 'ArrowLeft') next = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = TAB_ORDER.length - 1;
          onSelect(TAB_ORDER[next]!);
          document.getElementById(`steward-tab-${TAB_ORDER[next]!}`)?.focus();
        }
      }}
      className="button small"
      style={active ? undefined : { opacity: 0.6 }}
    >
      {labels[keyName]}
      {badge !== undefined && badge > 0 ? ` (${badge})` : ''}
    </button>
  );
}

function PendingWiringNote(): React.JSX.Element {
  return (
    <p className="muted" style={{ fontSize: 9, margin: '4px 0 0' }} role="note">
      {PENDING_WIRING}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Vocabulary tab
// ---------------------------------------------------------------------------

function VocabularyTab({ data, actions }: { data: StewardConsoleData; actions: StewardConsoleActions }): React.JSX.Element {
  const [kind, setKind] = useState<VocabularyKindView | 'all'>('all');
  const [termId, setTermId] = useState('');
  const [label, setLabel] = useState('');
  const [newKind, setNewKind] = useState<VocabularyKindView>('qualifier');
  const formId = useId();
  const rows = vocabularyRows(data.terms, kind);
  const changes = vocabularyChangeList(data.vocabularyChanges, principalName);
  const kinds = Object.keys(VOCABULARY_KIND_LABELS) as readonly VocabularyKindView[];

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    if (actions.onCreateTerm && termId.trim() && label.trim()) actions.onCreateTerm({ kind: newKind, id: termId.trim(), label: label.trim() });
  };

  return (
    <div>
      <h3 style={{ fontSize: 11, margin: '0 0 6px' }}>Governed vocabulary (registry v{data.registryVersion})</h3>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Retirement never deletes: retired terms stay resolvable so historical records keep rendering. New records cannot reference retired terms (FR-012).
      </p>
      <label style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
        <span style={{ fontWeight: 650 }}>Filter by kind</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as VocabularyKindView | 'all')}>
          <option value="all">All kinds</option>
          {kinds.map((candidate) => (
            <option key={candidate} value={candidate}>{VOCABULARY_KIND_LABELS[candidate]}</option>
          ))}
        </select>
      </label>
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Governed terms with lifecycle status and version stamps</caption>
        <thead>
          <tr>
            <th scope="col">Term</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Registry v</th>
            <th scope="col">Retire</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={5} className="muted">No terms in this kind yet.</td></tr>
          ) : (
            rows.map((term) => (
              <tr key={`${term.kind}:${term.id}`}>
                <th scope="row">
                  {term.label}
                  <small style={SMALL_MUTED}>{term.id}{term.canonicalUnitId ? ` · unit ${term.canonicalUnitId}` : ''}</small>
                </th>
                <td>{VOCABULARY_KIND_LABELS[term.kind]}</td>
                <td>{termStatusBadge(term.status)}</td>
                <td>v{term.registryVersion}</td>
                <td>
                  {term.status === 'active' && actions.onRetireTerm ? (
                    <button type="button" className="button small" onClick={() => actions.onRetireTerm!(term.kind, term.id)}>Retire (keeps history)</button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h4 style={{ fontSize: 10, margin: '14px 0 4px' }}>Create a term (steward only)</h4>
      <form onSubmit={submitCreate} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', fontSize: 10 }} aria-labelledby={formId}>
        <span id={formId} className="sr-only">Create a governed term</span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Kind</span>
          <select value={newKind} onChange={(event) => setNewKind(event.target.value as VocabularyKindView)}>
            {kinds.map((candidate) => (
              <option key={candidate} value={candidate}>{VOCABULARY_KIND_LABELS[candidate]}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Id</span>
          <input value={termId} onChange={(event) => setTermId(event.target.value)} placeholder="estimated" size={12} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Label</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Estimated" size={16} />
        </label>
        <button type="submit" className="button small" disabled={!actions.onCreateTerm || termId.trim().length === 0 || label.trim().length === 0}>
          Create (v{data.registryVersion + 1})
        </button>
      </form>
      {actions.onCreateTerm ? null : <PendingWiringNote />}

      <h4 style={{ fontSize: 10, margin: '14px 0 4px' }}>Change history</h4>
      {changes.length === 0 ? (
        <p className="muted" style={{ fontSize: 9, margin: 0 }}>No vocabulary changes recorded yet.</p>
      ) : (
        <ul style={{ fontSize: 9, margin: 0, paddingLeft: 18 }}>
          {changes.map((change) => {
            const event = data.vocabularyChanges.find((candidate) => candidate.id === change.key);
            return (
              <li key={change.key}>
                {change.text} — by {change.actorLabel}{event ? ` at ${event.at}` : ''} [{change.versionLabel}]
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments tab
// ---------------------------------------------------------------------------

function AssignmentsTab({ world, actions }: { world: PolicyWorldMirror; actions: StewardConsoleActions }): React.JSX.Element {
  const rows = assignmentRows(world.assignments, principalName);
  const [deputyId, setDeputyId] = useState('principal-ana-deputy');
  const [scopeId, setScopeId] = useState('sys-bear-river');
  const [effectiveAt, setEffectiveAt] = useState('2026-04-01T07:00');
  const [expiresAt, setExpiresAt] = useState('2026-04-30T17:59');
  const formId = useId();

  const submitDelegation = (event: FormEvent): void => {
    event.preventDefault();
    if (!actions.onDelegateDeputy) return;
    actions.onDelegateDeputy({
      principalId: deputyId,
      scopeId,
      effectiveAt: new Date(`${effectiveAt}:00Z`).toISOString(),
      expiresAt: new Date(`${expiresAt}:00Z`).toISOString(),
    });
  };

  return (
    <div>
      <h3 style={{ fontSize: 11, margin: '0 0 6px' }}>Assignments (authoritative version v{world.assignmentVersion})</h3>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Delegations are explicit and time-bounded (half-open window); revocation affects the NEXT authorized request; deactivated actors stay identifiable in history (FR-011).
      </p>
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Current assignments with scope, validity window, delegation and grant version</caption>
        <thead>
          <tr>
            <th scope="col">Principal</th>
            <th scope="col">Role / scope</th>
            <th scope="col">Validity</th>
            <th scope="col">v</th>
            <th scope="col">Revoke</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                {row.principalLabel}
                <small style={SMALL_MUTED}>{row.statusLabel}{row.delegationLabel ? ` · ${row.delegationLabel}` : ''}</small>
              </th>
              <td>{row.role} · {row.scopeLabel}</td>
              <td>{row.windowLabel}</td>
              <td>v{row.grantVersion}</td>
              <td>
                {row.statusLabel.startsWith('●') && actions.onRevokeAssignment ? (
                  <button type="button" className="button small" onClick={() => actions.onRevokeAssignment!(row.key)}>Revoke</button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ fontSize: 10, margin: '14px 0 4px' }}>Delegate a deputy (with expiry)</h4>
      <form onSubmit={submitDelegation} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', fontSize: 10 }} aria-labelledby={formId}>
        <span id={formId} className="sr-only">Delegate a deputy commissioner</span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Deputy principal id</span>
          <input value={deputyId} onChange={(event) => setDeputyId(event.target.value)} size={24} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>System scope</span>
          <input value={scopeId} onChange={(event) => setScopeId(event.target.value)} size={14} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Effective (UTC)</span>
          <input type="datetime-local" value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontWeight: 650 }}>Expiry (UTC)</span>
          <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <button type="submit" className="button small" disabled={!actions.onDelegateDeputy}>Delegate (never statewide)</button>
      </form>
      {actions.onDelegateDeputy ? null : <PendingWiringNote />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ingestion tab
// ---------------------------------------------------------------------------

function IngestionTab({ data, actions }: { data: StewardConsoleData; actions: StewardConsoleActions }): React.JSX.Element {
  const queue = ingestionQueue(data.configs, data.providers);
  const [mode, setMode] = useState<'success' | 'auth-failure' | 'timeout'>('success');

  return (
    <div>
      <h3 style={{ fontSize: 11, margin: '0 0 6px' }}>Provider and site ingestion configuration</h3>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Monitoring only: configuration plus simulated staging tests (no real network, no new ingestion platform). Engineers submit requests; only a steward promotes them (FR-013). Secrets are redacted everywhere.
      </p>
      <h4 style={{ fontSize: 10, margin: '0 0 4px' }}>Providers ({queue.providers})</h4>
      <ul style={{ fontSize: 9, margin: '0 0 10px', paddingLeft: 18 }}>
        {data.providers.map((provider) => (
          <li key={provider.id}>
            {provider.name} ({provider.kind}) — parameters: {provider.parameterSchema.map((spec) => `${spec.key}:${spec.type}${spec.required ? '*' : ''}`).join(', ') || 'none'}
          </li>
        ))}
      </ul>
      <h4 style={{ fontSize: 10, margin: '0 0 4px' }}>Site configurations ({queue.configured} configured)</h4>
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Site ingestion configurations with the latest simulated staging connection test</caption>
        <thead>
          <tr>
            <th scope="col">Config</th>
            <th scope="col">Status</th>
            <th scope="col">Connection test</th>
            <th scope="col">Test</th>
          </tr>
        </thead>
        <tbody>
          {data.configs.map((config) => (
            <tr key={config.id}>
              <th scope="row">
                {config.stationId} via {config.providerId}
                <small style={SMALL_MUTED}>{config.id} · {systemName(config.systemId)} · params: {Object.entries(config.params).map(([key, value]) => `${key}=${value}`).join(' ') || 'none'}</small>
              </th>
              <td>{config.status === 'configured' ? '● Configured' : `◐ Requested by ${principalName(config.requestedBy)}`}</td>
              <td>{connectionTestLabel(config)}</td>
              <td>
                <button
                  type="button"
                  className="button small"
                  disabled={!actions.onTestConnection}
                  onClick={() => actions.onTestConnection?.(config.id, mode)}
                  title="Simulated staging test - no real network"
                >
                  Run staging test ({mode})
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3, margin: '6px 0 0' }}>
        <span style={{ fontWeight: 650 }}>Simulated outcome for the next test</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as 'success' | 'auth-failure' | 'timeout')}>
          <option value="success">success</option>
          <option value="auth-failure">auth failure</option>
          <option value="timeout">timeout</option>
        </select>
      </label>
      {actions.onTestConnection ? null : <PendingWiringNote />}

      <h4 style={{ fontSize: 10, margin: '14px 0 4px' }}>Engineer requests awaiting promotion ({queue.pendingRequests.length})</h4>
      {queue.pendingRequests.length === 0 ? (
        <p className="muted" style={{ fontSize: 9, margin: 0 }}>No pending requests.</p>
      ) : (
        <ul style={{ fontSize: 9, margin: 0, paddingLeft: 18 }}>
          {queue.pendingRequests.map((config) => (
            <li key={config.id}>
              {config.stationId} ({systemName(config.systemId)}) requested by {principalName(config.requestedBy)} at {config.requestedAt} —{' '}
              {actions.onPromoteRequest ? (
                <button type="button" className="button small" onClick={() => actions.onPromoteRequest!(config.id)}>Promote to configured</button>
              ) : (
                <span className="muted">promote endpoint not wired</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection health tab
// ---------------------------------------------------------------------------

function HealthTab({ data }: { data: StewardConsoleData }): React.JSX.Element {
  const rollup = healthRollup(data.healthRows);
  const digestDates = Object.keys(data.digests).sort();
  const [digestDate, setDigestDate] = useState(digestDates.at(-1) ?? '');
  const digest = data.digests[digestDate];
  const preview = digest ? assembleDigestPreview(digest, systemName) : [];

  return (
    <div>
      <h3 style={{ fontSize: 11, margin: '0 0 6px' }}>Connection health - distinct from task failures</h3>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Status derives ONLY from staging connection tests. Failed tasks are counted separately and never flip a connection's status (FR-014): {rollup.total} connections, {rollup.totalFailedTasks} failed tasks.
      </p>
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Connection status board with separate failed-task counts and filtered task links</caption>
        <thead>
          <tr>
            <th scope="col">Connection</th>
            <th scope="col">Status (test-derived)</th>
            <th scope="col">Failed tasks</th>
            <th scope="col">Filtered task list</th>
          </tr>
        </thead>
        <tbody>
          {rollup.attentionOrder.map((row) => (
            <tr key={row.connectionId}>
              <th scope="row">
                {row.stationId}
                <small style={SMALL_MUTED}>{row.connectionId} · {systemName(row.systemId)} · last test {row.lastTestedAt ?? 'never'}</small>
              </th>
              <td>{healthStatusText(row.status)}</td>
              <td>{row.failedTaskCount}{row.openConnectionIncidents > 0 ? ` (+${row.openConnectionIncidents} connection incident${row.openConnectionIncidents === 1 ? '' : 's'})` : ''}</td>
              <td>{row.taskListQuery}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ fontSize: 10, margin: '14px 0 4px' }}>Weekday digest preview</h4>
      <label style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
        <span style={{ fontWeight: 650 }}>Digest date (America/Denver)</span>
        <select value={digestDate} onChange={(event) => setDigestDate(event.target.value)}>
          {digestDates.map((date) => (
            <option key={date} value={date}>{date}</option>
          ))}
        </select>
      </label>
      {preview.length === 0 ? (
        <p className="muted" style={{ fontSize: 9, margin: 0 }}>No digest for this date.</p>
      ) : (
        <ol style={{ fontSize: 9, margin: 0, paddingLeft: 18 }}>
          {preview.map((line) => (
            <li key={line.key} style={line.kind === 'notice' || line.kind === 'footer' ? MUTED : undefined}>{line.text}</li>
          ))}
        </ol>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 10 }}>Digest rules (as implemented)</summary>
        <ul style={{ fontSize: 9, margin: '4px 0 0', paddingLeft: 18 }}>
          {DIGEST_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics tab
// ---------------------------------------------------------------------------

function AnalyticsTab({ data }: { data: StewardConsoleData }): React.JSX.Element {
  const tables = usageTables(data.usage);
  return (
    <div>
      <h3 style={{ fontSize: 11, margin: '0 0 6px' }}>Usage analytics (consent-gated aggregates)</h3>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 4px' }} role="note">
        {tables.exclusionNote}
      </p>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Excluded events (no consent, stale consent, or unallowable fields): {tables.excludedEvents}.
      </p>
      <table className="site-table" style={{ fontSize: 9 }}>
        <caption className="sr-only">Consent-gated usage counts by day with per-kind split (program zone America/Denver)</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Sessions</th>
            <th scope="col">Exports</th>
            <th scope="col">Token verifications</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {tables.dayRows.length === 0 ? (
            <tr><td colSpan={5} className="muted">No consented usage recorded yet.</td></tr>
          ) : (
            tables.dayRows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  {row.label}
                  <span aria-hidden="true" style={{ display: 'block', height: 4, width: `${Math.round(row.share * 100)}%`, minWidth: 2, background: '#7aa5c4', marginTop: 2 }} />
                </th>
                <td>{row.sessions}</td>
                <td>{row.exports}</td>
                <td>{row.apiTokenVerifications}</td>
                <td>{row.total}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p style={{ fontSize: 9, margin: '8px 0 0' }}>
        {tables.monthRows.map((row) => `Month ${row.label}: ${row.total}`).join(' · ')} —{' '}
        {tables.yearRows.map((row) => `Year ${row.label}: ${row.total}`).join(' · ')}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/**
 * The steward governance console. Denied for every non-steward persona by
 * policy verdict; loading/empty/error states per the network-view contract.
 */
export default function StewardConsole({
  principalId = null,
  world,
  policy,
  now,
  data,
  actions = {},
  status = 'ready',
  errorMessage,
  onRetry,
  defaultTab = 'vocabulary',
}: StewardConsoleProps): React.JSX.Element {
  const port = useMemo(() => demoPolicyPort(), []);
  const resolvedWorld = world ?? port.world;
  const resolvedPolicy = policy ?? port.evaluate;
  const resolvedNow = now ?? port.now;
  const resolvedData = data ?? demoConsoleData();

  const [tab, setTab] = useState<TabKey>(defaultTab);
  const access = stewardConsoleAccess({ principalId, world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow });

  const heading = 'Steward console';
  if (status === 'loading') {
    return (
      <section aria-label={heading}>
        <h2 style={{ fontSize: 12, margin: '0 0 6px' }}>{heading}</h2>
        <p role="status" className="muted" style={{ fontSize: 10 }}>Loading governance data…</p>
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section aria-label={heading}>
        <h2 style={{ fontSize: 12, margin: '0 0 6px' }}>{heading}</h2>
        <p role="alert" style={{ fontSize: 10 }}>{errorMessage ?? 'The governance data could not be loaded.'}</p>
        {onRetry ? <button type="button" className="button small" onClick={onRetry}>Retry</button> : null}
      </section>
    );
  }
  if (!access.allowed) {
    return (
      <section aria-label={heading}>
        <h2 style={{ fontSize: 12, margin: '0 0 6px' }}>{heading}</h2>
        <p role="alert" style={{ fontSize: 10 }}>
          {access.message}
          {principalId !== null ? ` (Signed in as ${principalName(principalId)}; ${access.status} ${access.reason}.)` : ''}
        </p>
      </section>
    );
  }

  const queue = ingestionQueue(resolvedData.configs, resolvedData.providers);
  const badges: Partial<Record<TabKey, number>> = { ingestion: queue.pendingRequests.length };

  return (
    <section aria-label={heading}>
      <h2 style={{ fontSize: 12, margin: '0 0 6px' }}>{heading}</h2>
      <p className="muted" style={{ fontSize: 9, margin: '0 0 8px' }}>
        Statewide governance for {principalName(principalId ?? '')} — vocabulary, assignments, ingestion, connection health and usage analytics. Monitoring only: no ingestion platform is implemented here.
      </p>
      <div role="tablist" aria-label="Steward console sections" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {TAB_ORDER.map((keyName) => (
          <TabButton key={keyName} keyName={keyName} active={tab === keyName} onSelect={setTab} badge={badges[keyName]} />
        ))}
      </div>
      <div role="tabpanel" id="steward-panel-vocabulary" aria-labelledby="steward-tab-vocabulary" hidden={tab !== 'vocabulary'}>
        <VocabularyTab data={resolvedData} actions={actions} />
      </div>
      <div role="tabpanel" id="steward-panel-assignments" aria-labelledby="steward-tab-assignments" hidden={tab !== 'assignments'}>
        <AssignmentsTab world={resolvedWorld} actions={actions} />
      </div>
      <div role="tabpanel" id="steward-panel-ingestion" aria-labelledby="steward-tab-ingestion" hidden={tab !== 'ingestion'}>
        <IngestionTab data={resolvedData} actions={actions} />
      </div>
      <div role="tabpanel" id="steward-panel-health" aria-labelledby="steward-tab-health" hidden={tab !== 'health'}>
        <HealthTab data={resolvedData} />
      </div>
      <div role="tabpanel" id="steward-panel-analytics" aria-labelledby="steward-tab-analytics" hidden={tab !== 'analytics'}>
        <AnalyticsTab data={resolvedData} />
      </div>
    </section>
  );
}
