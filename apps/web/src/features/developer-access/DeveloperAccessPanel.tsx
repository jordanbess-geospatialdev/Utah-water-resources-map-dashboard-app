/**
 * DeveloperAccessPanel - the FR-064 scoped-credential account UI.
 *
 * "An authenticated researcher creates a scoped credential, copies its
 * secret at creation, and rotates or revokes it without a new account."
 *
 * Presentation rules this panel guarantees:
 * - COPY ONCE: the secret of a newly issued (or rotated) credential is shown
 *   exactly once, in a disclosure the user must acknowledge. Once dismissed
 *   it is dropped from component state - there is no re-show path, only
 *   "rotate to get a new secret" (PRD "Data lifecycle decisions"; see
 *   docs/api/TOKEN-POLICY.md). No secret is ever rendered in the token list,
 *   a URL, or a log.
 * - SCOPE PICKERS ARE BOUNDED: the create dialog offers only actions,
 *   streams, properties and levels the ACCOUNT can currently perform (the
 *   authority descriptor); validation rejects anything outside it.
 * - DESTRUCTIVE ACTIONS CONFIRM: rotate and revoke each ask once, naming the
 *   consequence ("the old secret stops working on its next request").
 * - KEYBOARD ACCESSIBLE: real buttons and checkboxes, a labelled modal dialog
 *   reachable and closable with the keyboard (Escape), focus moved into the
 *   dialog when it opens, visible focus outlines.
 * - States: loading, error (with retry), empty, and revoked rows kept
 *   visible for audit.
 *
 * Mountable, shell-free component: WD-016 must not edit persona_ui's
 * App.tsx; data and operations arrive through props. Defaults run the frozen
 * fixture world (Sarah) with an in-memory simulation of the token domain, so
 * the panel works standalone; an API-backed loader swaps `tokens`,
 * `onCreate`, `onRotate` and `onRevoke` without touching this file.
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  DEFAULT_DRAFT,
  buildScopeChoices,
  deriveTokenRows,
  draftToScopes,
  validateDraft,
  type AccountAuthority,
  type CreateDraft,
  type DerivedTokenRow,
  type TokenRecordView,
  type TokenScopes,
} from './derivation';

/** Issue result the operations return: the new record plus the one-time secret. */
export interface IssuedSecret {
  readonly token: TokenRecordView;
  readonly secret: string;
}

export interface DeveloperAccessPanelProps {
  /** Account shown; defaults to the fixture researcher. */
  readonly principalId?: string;
  /** The account's CURRENT authority bounding the scope pickers. */
  readonly authority?: AccountAuthority;
  /** Token records (public projection: never a secret or hash). */
  readonly tokens?: readonly TokenRecordView[];
  /** Data status; the panel is synchronous and defaults to ready. */
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Issue a credential; default: in-memory fixture simulation. */
  readonly onCreate?: (request: { label: string; scopes: TokenScopes; lifetimeDays: number }) => IssuedSecret;
  /** Rotate: revoke old + issue new atomically; default: simulation. */
  readonly onRotate?: (tokenId: string) => IssuedSecret;
  /** Revoke: authoritative for the next request; default: simulation. */
  readonly onRevoke?: (tokenId: string) => TokenRecordView;
  /** Fixed clock for derivable statuses (defaults to the fixture instant). */
  readonly now?: string;
}

// ---------------------------------------------------------------------------
// Fixture defaults (frozen fixture world, read-only): Sarah the researcher
// ---------------------------------------------------------------------------

const SARAH_AUTHORITY: AccountAuthority = {
  principalId: 'principal-sarah-researcher',
  displayName: 'Sarah Kimball',
  availableActions: ['catalog:read', 'sites:read', 'observations:read', 'history:read', 'exports:create'],
  readableStreams: [
    { id: 'str-corinne-q', label: 'Bear River near Corinne - discharge' },
    { id: 'str-corinne-stage', label: 'Bear River near Corinne - stage' },
    { id: 'str-hyrum-q-public', label: 'Little Bear Diversion (public) - discharge' },
    { id: 'str-summit-q', label: 'Summit Creek Restoration - discharge' },
  ],
  availableProperties: ['discharge', 'stage'],
  availableProcessingLevels: ['raw', 'provisional', 'reviewed', 'best-available'],
  maxLifetimeDays: 90,
};

const FIXTURE_NOW = '2026-03-09T07:00:00Z';

const DEFAULT_TOKENS: readonly TokenRecordView[] = [
  {
    id: 'tok-seed-sarah-001',
    label: 'Corinne discharge research extract',
    scopes: {
      actions: ['observations:read', 'history:read', 'exports:create'],
      streams: ['str-corinne-q'],
      properties: ['discharge'],
      processingLevels: ['raw', 'provisional', 'reviewed', 'best-available'],
      dateRange: { start: '2026-03-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
    },
    principalId: 'principal-sarah-researcher',
    createdAt: '2026-03-01T09:15:00Z',
    expiresAt: '2026-05-30T09:15:00Z',
    lastUsedAt: '2026-03-09T07:05:00Z',
    status: 'active',
    revokedAt: null,
    rotatedToId: null,
    rotatedFromId: null,
  },
];

/** Demo-only secret generator (browser crypto): format-accurate, never persisted. */
function demoSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const buffer = new Uint32Array(64);
  crypto.getRandomValues(buffer);
  for (const word of buffer) {
    const byte = word & 0xff;
    if (byte >= 248) continue; // rejection sampling, no modulo bias
    out += alphabet[byte % 62]!;
    if (out.length === 32) break;
  }
  return `uwdat_${out}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const PANEL: CSSProperties = { fontFamily: 'inherit', fontSize: 12, color: '#e8ecf4', maxWidth: 860 };
const CARD: CSSProperties = { border: '1px solid #2c3a4d', borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: '#131c28' };
const MUTED: CSSProperties = { color: '#a0aa99' };
const SMALL_MUTED: CSSProperties = { ...MUTED, fontSize: 11 };
const BUTTON: CSSProperties = {
  background: '#1d4ed8',
  border: 'none',
  borderRadius: 6,
  color: 'white',
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};
const BUTTON_DANGER: CSSProperties = { ...BUTTON, background: '#7f1d1d' };
const BUTTON_SECONDARY: CSSProperties = { ...BUTTON, background: '#243447' };
const DIALOG_BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(4, 8, 14, 0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 50,
};
const DIALOG: CSSProperties = {
  background: '#101823',
  border: '1px solid #3b4c61',
  borderRadius: 10,
  padding: 16,
  maxWidth: 560,
  width: '90vw',
  maxHeight: '85vh',
  overflow: 'auto',
};
const FIELD: CSSProperties = { display: 'block', marginBottom: 10 };
const INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#0b1119',
  border: '1px solid #3b4c61',
  borderRadius: 6,
  color: '#e8ecf4',
  padding: '6px 8px',
  fontSize: 12,
};
const ERROR_TEXT: CSSProperties = { color: '#f87171', fontSize: 11, marginTop: 2 };
const SECRET_BOX: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  background: '#0b1119',
  border: '1px dashed #4b6d8f',
  borderRadius: 6,
  padding: '8px 10px',
  margin: '8px 0',
  wordBreak: 'break-all',
};
const STATUS_COLORS: Readonly<Record<string, string>> = {
  active: '#4ade80',
  expiring: '#fbbf24',
  expired: '#94a3b8',
  revoked: '#f87171',
};

function TokenRow(props: {
  readonly row: DerivedTokenRow;
  readonly onRotate: () => void;
  readonly onRevoke: () => void;
}) {
  const { row } = props;
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <strong>{row.label}</strong>
        <span style={{ color: STATUS_COLORS[row.derivedStatus] ?? '#e8ecf4' }}>{row.statusText}</span>
      </div>
      <div style={SMALL_MUTED}>{row.id} · {row.scopesSummary}</div>
      <div style={SMALL_MUTED}>
        Created {row.createdAt} · {row.expiryText} · {row.lastUsedText}
        {row.rotatedFromId ? ` · replaced ${row.rotatedFromId}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={BUTTON_SECONDARY} onClick={props.onRotate} disabled={!row.canRotate} aria-label={`Rotate ${row.label}`}>
          Rotate
        </button>
        <button type="button" style={BUTTON_DANGER} onClick={props.onRevoke} disabled={!row.canRevoke} aria-label={`Revoke ${row.label}`}>
          Revoke
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog(props: {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      style={DIALOG_BACKDROP}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      ref={ref}
      tabIndex={-1}
      autoFocus
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') props.onCancel();
      }}
    >
      <div style={DIALOG}>
        <h3 id="confirm-title" style={{ marginTop: 0 }}>
          {props.title}
        </h3>
        <p style={{ ...SMALL_MUTED, whiteSpace: 'pre-line' }}>{props.body}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={BUTTON_SECONDARY} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" style={props.danger ? BUTTON_DANGER : BUTTON} onClick={props.onConfirm} autoFocus>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DeveloperAccessPanel(props: DeveloperAccessPanelProps) {
  const now = props.now ?? FIXTURE_NOW;
  const authority = props.authority ?? SARAH_AUTHORITY;
  const status = props.status ?? 'ready';

  // Local simulation state (defaults only; API-backed props bypass it).
  const [demoTokens, setDemoTokens] = useState<readonly TokenRecordView[]>(DEFAULT_TOKENS);
  const [demoSequence, setDemoSequence] = useState(1);

  const tokens = props.tokens ?? demoTokens;
  const rows = useMemo(() => deriveTokenRows(tokens, now), [tokens, now]);
  const choices = useMemo(() => buildScopeChoices(authority), [authority]);

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(DEFAULT_DRAFT);
  const [disclosure, setDisclosure] = useState<IssuedSecret | null>(null);
  const [disclosureClosed, setDisclosureClosed] = useState(false);
  const [pendingRotate, setPendingRotate] = useState<DerivedTokenRow | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<DerivedTokenRow | null>(null);

  const errors = useMemo(() => validateDraft(draft, authority), [draft, authority]);
  const canSubmit = createOpen && Object.keys(errors).length === 0;

  const createDialogRef = useRef<HTMLDivElement | null>(null);

  const demoIssue = useCallback(
    (label: string, scopes: TokenScopes, lifetimeDays: number, rotatedFromId: string | null): IssuedSecret => {
      const seq = demoSequence + 1;
      setDemoSequence(seq);
      const issued: TokenRecordView = {
        id: `tok-demo-${String(seq).padStart(3, '0')}`,
        label,
        scopes,
        principalId: authority.principalId,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + lifetimeDays * 86_400_000).toISOString(),
        lastUsedAt: null,
        status: 'active',
        revokedAt: null,
        rotatedToId: null,
        rotatedFromId,
      };
      return { token: issued, secret: demoSecret() };
    },
    [authority.principalId, demoSequence, now],
  );

  const openCreate = () => {
    setDraft(DEFAULT_DRAFT);
    setCreateOpen(true);
  };

  const submitCreate = () => {
    if (!canSubmit) return;
    const scopes = draftToScopes(draft, authority);
    const result = props.onCreate
      ? props.onCreate({ label: draft.label.trim(), scopes, lifetimeDays: draft.lifetimeDays })
      : (() => {
          const issued = demoIssue(draft.label.trim(), scopes, draft.lifetimeDays, null);
          setDemoTokens((current) => [...current, issued.token]);
          return issued;
        })();
    setCreateOpen(false);
    setDisclosure(result);
    setDisclosureClosed(false);
  };

  const submitRotate = () => {
    const row = pendingRotate;
    setPendingRotate(null);
    if (!row) return;
    const existing = tokens.find((token) => token.id === row.id);
    if (!existing) return;
    const result = props.onRotate
      ? props.onRotate(row.id)
      : (() => {
          const issued = demoIssue(existing.label, existing.scopes, 90, existing.id);
          setDemoTokens((current) => [
            ...current.map((token) =>
              token.id === existing.id ? { ...token, status: 'revoked' as const, revokedAt: now, rotatedToId: issued.token.id } : token,
            ),
            issued.token,
          ]);
          return issued;
        })();
    setDisclosure(result);
    setDisclosureClosed(false);
  };

  const submitRevoke = () => {
    const row = pendingRevoke;
    setPendingRevoke(null);
    if (!row) return;
    if (props.onRevoke) {
      props.onRevoke(row.id);
    } else {
      setDemoTokens((current) =>
        current.map((token) => (token.id === row.id ? { ...token, status: 'revoked' as const, revokedAt: now } : token)),
      );
    }
  };

  const copySecret = async () => {
    if (!disclosure) return;
    try {
      await navigator.clipboard.writeText(disclosure.secret);
    } catch {
      // Clipboard may be unavailable (insecure context); the visible text
      // remains selectable so the user can still copy manually - once.
    }
  };

  const closeDisclosure = () => {
    // THE copy-once rule: dropping the state destroys the only in-memory
    // copy; nothing can display it again.
    setDisclosure(null);
    setDisclosureClosed(true);
  };

  return (
    <section style={PANEL} aria-labelledby="developer-access-title">
      <h2 id="developer-access-title" style={{ fontSize: 15, marginBottom: 6 }}>
        Developer access
      </h2>
      <p style={SMALL_MUTED}>
        Scoped API credentials for {authority.displayName ?? authority.principalId}. A credential never exceeds this
        account&apos;s current authority; its secret is shown once at creation - store it somewhere safe immediately.
      </p>

      {status === 'loading' ? (
        <p style={MUTED} role="status">
          Loading credentials...
        </p>
      ) : status === 'error' ? (
        <div style={CARD} role="alert">
          <p style={{ margin: '0 0 8px' }}>{props.errorMessage ?? 'Could not load credentials.'}</p>
          {props.onRetry ? (
            <button type="button" style={BUTTON_SECONDARY} onClick={props.onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button type="button" style={BUTTON} onClick={openCreate} aria-label="Create a new API token">
              Create token
            </button>
          </div>

          {rows.length === 0 ? (
            <div style={CARD}>
              <p style={{ margin: 0, ...MUTED }}>
                No API credentials yet. Create one to query sites, bounded observations and exports programmatically -
                see the researcher API documentation under docs/api.
              </p>
            </div>
          ) : (
            rows.map((row) => (
              <TokenRow
                key={row.id}
                row={row}
                onRotate={() => setPendingRotate(row)}
                onRevoke={() => setPendingRevoke(row)}
              />
            ))
          )}
          <p style={SMALL_MUTED}>
            Revoked credentials stay listed for audit. Lifetime default and maximum: {choices.maxLifetimeDays} days
            (proposal, owner-ratifiable). Rate budget: 120 requests / 60 seconds per token.
          </p>
        </>
      )}

      {createOpen ? (
        <div
          style={DIALOG_BACKDROP}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-token-title"
          ref={createDialogRef}
          tabIndex={-1}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Escape') setCreateOpen(false);
          }}
        >
          <div style={DIALOG}>
            <h3 id="create-token-title" style={{ marginTop: 0 }}>
              Create a scoped credential
            </h3>
            <p style={SMALL_MUTED}>
              Scopes can only narrow this account&apos;s authority. The secret will be shown exactly once after you
              create the credential.
            </p>

            <label style={FIELD} htmlFor="new-token-label">
              Label
              <input
                id="new-token-label"
                style={INPUT}
                value={draft.label}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                placeholder="e.g. Corinne research extract"
                autoFocus
              />
            </label>
            {errors.label ? <div style={ERROR_TEXT}>{errors.label}</div> : null}

            <fieldset style={{ border: '1px solid #2c3a4d', borderRadius: 6, marginBottom: 10 }}>
              <legend style={SMALL_MUTED}>Actions</legend>
              {choices.actionChoices.map((choice) => (
                <label key={choice.value} style={{ display: 'block', marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={draft.actions.includes(choice.value)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        actions: event.target.checked
                          ? [...draft.actions, choice.value]
                          : draft.actions.filter((action) => action !== choice.value),
                      })
                    }
                  />{' '}
                  {choice.label} <span style={SMALL_MUTED}>({choice.value})</span>
                </label>
              ))}
            </fieldset>
            {errors.actions ? <div style={ERROR_TEXT}>{errors.actions}</div> : null}

            <fieldset style={{ border: '1px solid #2c3a4d', borderRadius: 6, marginBottom: 10 }}>
              <legend style={SMALL_MUTED}>Streams (optional - leave empty for any authorized stream)</legend>
              {choices.streamChoices.map((choice) => (
                <label key={choice.value} style={{ display: 'block', marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={draft.streams.includes(choice.value)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        streams: event.target.checked
                          ? [...draft.streams, choice.value]
                          : draft.streams.filter((stream) => stream !== choice.value),
                      })
                    }
                  />{' '}
                  {choice.label}
                </label>
              ))}
            </fieldset>
            {errors.streams ? <div style={ERROR_TEXT}>{errors.streams}</div> : null}

            <fieldset style={{ border: '1px solid #2c3a4d', borderRadius: 6, marginBottom: 10 }}>
              <legend style={SMALL_MUTED}>Properties and processing levels (optional narrowing)</legend>
              {choices.propertyChoices.map((property) => (
                <label key={property.value} style={{ display: 'inline-block', marginRight: 14 }}>
                  <input
                    type="checkbox"
                    checked={draft.properties.includes(property.value)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        properties: event.target.checked
                          ? [...draft.properties, property.value]
                          : draft.properties.filter((candidate) => candidate !== property.value),
                      })
                    }
                  />{' '}
                  {property.label}
                </label>
              ))}
              <br />
              {choices.processingLevelChoices.map((level) => (
                <label key={level.value} style={{ display: 'inline-block', marginRight: 14 }}>
                  <input
                    type="checkbox"
                    checked={draft.processingLevels.includes(level.value)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        processingLevels: event.target.checked
                          ? [...draft.processingLevels, level.value]
                          : draft.processingLevels.filter((candidate) => candidate !== level.value),
                      })
                    }
                  />{' '}
                  {level.label}
                </label>
              ))}
            </fieldset>

            <label style={FIELD} htmlFor="new-token-lifetime">
              Lifetime (days, at most {choices.maxLifetimeDays})
              <input
                id="new-token-lifetime"
                style={INPUT}
                type="number"
                min={1}
                max={choices.maxLifetimeDays}
                value={draft.lifetimeDays}
                onChange={(event) => setDraft({ ...draft, lifetimeDays: Number(event.target.value) })}
              />
            </label>
            {errors.lifetime ? <div style={ERROR_TEXT}>{errors.lifetime}</div> : null}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={BUTTON_SECONDARY} onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button type="button" style={BUTTON} onClick={submitCreate} disabled={!canSubmit}>
                Create and show secret once
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {disclosure ? (
        <div style={DIALOG_BACKDROP} role="dialog" aria-modal="true" aria-labelledby="secret-title" tabIndex={-1}>
          <div style={DIALOG}>
            <h3 id="secret-title" style={{ marginTop: 0 }}>
              Copy your secret now
            </h3>
            <p style={SMALL_MUTED}>
              <strong>{disclosure.token.label}</strong> ({disclosure.token.id}) was created. This is the ONLY time the
              secret is shown. It is stored nowhere else and cannot be displayed again.
            </p>
            <div style={SECRET_BOX}>{disclosure.secret}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={BUTTON_SECONDARY} onClick={copySecret}>
                Copy to clipboard
              </button>
              <button type="button" style={BUTTON} onClick={closeDisclosure} autoFocus>
                I have stored it - close
              </button>
            </div>
          </div>
        </div>
      ) : disclosureClosed ? (
        <p style={SMALL_MUTED} role="status">
          Secret discarded from the view. If you lost it, rotate the credential to receive a new one - the old secret
          stops working on its next request.
        </p>
      ) : null}

      {pendingRotate ? (
        <ConfirmDialog
          title={`Rotate "${pendingRotate.label}"?`}
          body={
            'A new secret is issued and the current one is revoked IMMEDIATELY - any script still using it fails on its next request.\n\nThe label stays the same and the lifetime restarts.'
          }
          confirmLabel="Rotate credential"
          onConfirm={submitRotate}
          onCancel={() => setPendingRotate(null)}
        />
      ) : null}

      {pendingRevoke ? (
        <ConfirmDialog
          title={`Revoke "${pendingRevoke.label}"?`}
          body={'Revocation is immediate and permanent for this credential: the next request using it is denied. You can always create a new one.'}
          confirmLabel="Revoke credential"
          danger
          onConfirm={submitRevoke}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </section>
  );
}
