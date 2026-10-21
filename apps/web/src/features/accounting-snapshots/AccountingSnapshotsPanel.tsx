/**
 * AccountingSnapshotsPanel - the WD-025-R2 accounting-snapshots UI
 * (FR-028 decision evidence, FR-029 immutable finalization, FR-030
 * flexible periods + advisory supplemental context).
 *
 * Renders:
 * - the flexible period builder with VISIBLE boundary rules (half-open
 *   [start, end), local-day and DST facts) - governed bases and custom
 *   windows with any boundary, including mid-month;
 * - the decision evidence view: EXACT pinned observation/revision ids,
 *   rating-curve lineage, calculation inputs and the evidence hash;
 * - the finalize flow with authority-aware controls (only principals
 *   holding review-data / statewide-administration may act; everyone else
 *   sees the denial), optimistic-concurrency conflicts surfaced as the
 *   typed FINALIZE_CONFLICT, and supersession that never rewrites prior
 *   bytes;
 * - the finalized record view: hash, actor, timestamp, superseded banner
 *   with explicit linkage, and the full supersession chain;
 * - the advisory supplemental comparison (approved inputs only; the
 *   advisory label is always present).
 *
 * Accessibility contract (mirrors the WD-011-R2 rating-curve panel): real
 * tables with caption and scope attributes, inputs with explicit label
 * associations, results in aria-live regions, denials as role=alert, and
 * lifecycle state always text + shape (● finalized, ✕ superseded), never
 * color alone.
 *
 * Read-only fixtures + local demo ledger: the server workflow
 * (services/api/src/workflows/accounting-snapshots) is authoritative; an
 * API-backed loader can replace the demo through props without touching
 * this component - see README.md for the pending wiring.
 */
import { useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { FIXTURE_CLOCK, FIXTURE_SEED } from '../../shell/data/fixtures';
import {
  ADVISORY_LABEL_MODEL,
  buildDecisionSnapshotDemo,
  buildSupplementalRowsModel,
  DEMO_SUPPLEMENTAL_INPUTS,
  finalizeAuthorities,
  formatHash,
  instantFromLocal,
  linkageText,
  periodKeyModel,
  resolvePeriodModel,
  statusBadge,
  supersededBanner,
  type FinalizeDemoOutcome,
  type PeriodKind,
  type PeriodSpecModel,
  type ProcessingBasisModel,
} from './snapshotModel';
import { DemoFinalizeLedger } from './snapshotModel';

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };
const SYSTEM_ID = 'sys-bear-river';

export interface AccountingSnapshotsPanelProps {
  /** Principal whose evidence/finalize actions are preselected; defaults to the Bear River commissioner. */
  readonly actorId?: string;
  /** Data status; the panel is synchronous and defaults to ready. */
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly now?: string;
}

const BASIS_OPTIONS: readonly { readonly id: ProcessingBasisModel; readonly label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'provisional', label: 'Provisional' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'best-available', label: 'Best available' },
];

const KIND_OPTIONS: readonly { readonly id: PeriodKind; readonly label: string }[] = [
  { id: 'calendar-year', label: 'Calendar year' },
  { id: 'water-year', label: 'Water year (Oct-Sep)' },
  { id: 'irrigation-season', label: 'Irrigation season (Apr 1-Oct 31)' },
  { id: 'custom', label: 'Custom (any boundary)' },
];

const DEMO_MEASURED = [
  { category: 'natural-channel-flow', volumeAcreFeet: 10299 / 121 },
  { category: 'canal-delivery', volumeAcreFeet: 267947 / 484 },
  { category: 'reservoir-release', volumeAcreFeet: 26978 / 121 },
];

export default function AccountingSnapshotsPanel({
  actorId = 'principal-cody-commissioner',
  status = 'ready',
  errorMessage,
  onRetry,
  now = FIXTURE_CLOCK,
}: AccountingSnapshotsPanelProps) {
  const [kind, setKind] = useState<PeriodKind>('calendar-year');
  const [yearText, setYearText] = useState('2026');
  const [customStart, setCustomStart] = useState('2026-03-07T19:00:00.000Z');
  const [customEnd, setCustomEnd] = useState('2026-03-08T18:00:00.000Z');
  const [customLabel, setCustomLabel] = useState('mid-season custom window');
  const [basis, setBasis] = useState<ProcessingBasisModel>('best-available');
  const [actor, setActor] = useState(actorId);
  const [supersedeReason, setSupersedeReason] = useState('authorized correction after a year-end measurement revision');
  const [correctionCount, setCorrectionCount] = useState(0);
  const [outcome, setOutcome] = useState<FinalizeDemoOutcome | null>(null);

  const ledgerRef = useRef<DemoFinalizeLedger | null>(null);
  if (ledgerRef.current === null) ledgerRef.current = new DemoFinalizeLedger();
  const ledger = ledgerRef.current;
  const [ledgerVersion, setLedgerVersion] = useState(0);

  const authorities = useMemo(() => finalizeAuthorities(now), [now]);
  const currentAuthority = authorities.find((candidate) => candidate.principalId === actor) ?? null;

  const periodSpec: PeriodSpecModel = useMemo(() => {
    const year = Number.parseInt(yearText, 10);
    if (kind === 'custom') return { kind, start: customStart.trim(), end: customEnd.trim(), label: customLabel.trim() };
    return { kind, year: Number.isNaN(year) ? 0 : year };
  }, [kind, yearText, customStart, customEnd, customLabel]);

  const resolved = useMemo(() => resolvePeriodModel(periodSpec), [periodSpec]);
  const evidence = useMemo(
    () => (resolved.ok ? buildDecisionSnapshotDemo({ period: periodSpec, processingBasis: basis, actorId: actor, now }) : null),
    [resolved, periodSpec, basis, actor, now],
  );

  const periodKey = periodKeyModel(SYSTEM_ID, periodSpec);
  const chain = useMemo(() => ledger.chain(periodKey), [ledger, periodKey, ledgerVersion]);
  const currentHead = chain.length > 0 ? chain[chain.length - 1]! : null;

  const supplementalRows = useMemo(() => buildSupplementalRowsModel(DEMO_MEASURED, DEMO_SUPPLEMENTAL_INPUTS), []);

  function applyResult(result: FinalizeDemoOutcome): void {
    setOutcome(result);
    setLedgerVersion((version) => version + 1);
  }

  function handleFinalize(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!resolved.ok || evidence === null || !evidence.ok) return;
    applyResult(
      ledger.finalize({
        actorId: actor,
        period: periodSpec,
        contentTag: `${evidence.value.evidenceHash}#${correctionCount}`,
        expectedCurrentId: currentHead?.record.id ?? null,
      }),
    );
  }

  function handleSupersede(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!resolved.ok || evidence === null || !evidence.ok || currentHead === null) return;
    applyResult(
      ledger.finalizeSuperseding({
        actorId: actor,
        period: periodSpec,
        contentTag: `${evidence.value.evidenceHash}#corrected-${correctionCount + 1}`,
        expectedCurrentId: currentHead.record.id,
        reason: supersedeReason,
      }),
    );
    setCorrectionCount((count) => count + 1);
  }

  function presetMarch15(): void {
    setKind('custom');
    setCustomStart(instantFromLocal(2026, 3, 15, 0, 0));
    setCustomEnd(instantFromLocal(2027, 3, 15, 0, 0));
    setCustomLabel('owner-configured water year starting March 15');
  }

  if (status === 'loading') {
    return (
      <section aria-busy="true" aria-label="Accounting snapshots">
        <p style={{ fontSize: 10, margin: 0, padding: '13px 19px' }}>Loading accounting snapshots…</p>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section aria-label="Accounting snapshots">
        <div style={{ padding: '13px 19px' }}>
          <p style={{ fontSize: 10, margin: '0 0 8px' }} role="alert">
            {errorMessage ?? 'Accounting snapshots could not be loaded.'}
          </p>
          {onRetry !== undefined && (
            <button type="button" onClick={onRetry} style={{ fontSize: 10 }}>
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  const actorMayFinalize = currentAuthority !== null && currentAuthority.canFinalizeSystemIds.includes(SYSTEM_ID);

  return (
    <section aria-label="Accounting snapshots">
      <div style={{ background: '#fafcf9', borderBottom: '1px solid #e9ede8', padding: '13px 19px' }}>
        <h2 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 4px' }}>Accounting snapshots — decision evidence and finalization</h2>
        <p id="as-intro" style={{ fontSize: 10, margin: 0, color: '#5d6a5f' }}>
          FR-028: a saved decision references the exact observation/revision versions used. FR-029: finalized accounting never
          changes in place — authorized corrections supersede with explicit linkage while measurement corrections continue
          independently. FR-030: flexible periods (incl. mid-month boundaries) and advisory-only supplemental context. Fixture seed{' '}
          {FIXTURE_SEED}; demo clock {now}. Finalize/reopen authority (review-data: steward or granted reviewer) is PENDING OWNER
          RATIFICATION.
        </p>
      </div>

      {/* --- flexible period builder ------------------------------------- */}
      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>Flexible period (boundary rules always visible)</h3>
        <form onSubmit={handleFinalize}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="as-kind" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Period kind
              </label>
              <select id="as-kind" value={kind} onChange={(event) => setKind(event.target.value as PeriodKind)} style={{ fontSize: 10 }}>
                {KIND_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {kind !== 'custom' ? (
              <div>
                <label htmlFor="as-year" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                  Year
                </label>
                <input id="as-year" type="number" min={1900} max={2100} value={yearText} onChange={(event) => setYearText(event.target.value)} style={{ fontSize: 10, width: 90 }} />
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="as-start" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                    Start instant (UTC, ISO 8601, inclusive)
                  </label>
                  <input id="as-start" type="text" value={customStart} onChange={(event) => setCustomStart(event.target.value)} aria-invalid={resolved.ok ? undefined : true} style={{ fontSize: 10, width: 200 }} />
                </div>
                <div>
                  <label htmlFor="as-end" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                    End instant (exclusive)
                  </label>
                  <input id="as-end" type="text" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} aria-invalid={resolved.ok ? undefined : true} style={{ fontSize: 10, width: 200 }} />
                </div>
                <div>
                  <label htmlFor="as-label" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                    Why this custom window
                  </label>
                  <input id="as-label" type="text" value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} style={{ fontSize: 10, width: 220 }} />
                </div>
                <button type="button" onClick={presetMarch15} style={{ fontSize: 10 }}>
                  Preset: water year from Mar 15
                </button>
              </>
            )}
            <div>
              <label htmlFor="as-basis" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Processing basis
              </label>
              <select id="as-basis" value={basis} onChange={(event) => setBasis(event.target.value as ProcessingBasisModel)} style={{ fontSize: 10 }}>
                {BASIS_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="as-actor" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Acting principal
              </label>
              <select id="as-actor" value={actor} onChange={(event) => setActor(event.target.value)} style={{ fontSize: 10, maxWidth: 220 }}>
                {authorities.map((candidate) => (
                  <option key={candidate.principalId} value={candidate.principalId}>
                    {candidate.displayName} ({candidate.role}){candidate.canFinalizeSystemIds.includes(SYSTEM_ID) ? ' — can finalize' : ' — no finalize authority'}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>
        <div aria-live="polite" style={{ marginTop: 8 }}>
          {resolved.ok ? (
            <p id="as-window" style={{ fontSize: 10, margin: 0 }}>
              Window {resolved.value.start} → {resolved.value.end} ({resolved.value.dateRule}).{' '}
              {resolved.value.dstDays.length === 0
                ? 'No DST transition day spanned.'
                : resolved.value.dstDays.map((day) => `${day.date}: ${day.daySeconds === 82_800 ? '23-hour' : day.daySeconds === 90_000 ? '25-hour' : `${day.daySeconds} s`} local day`).join('; ')}
              .
            </p>
          ) : (
            <p id="as-window" style={{ fontSize: 10, margin: 0 }} role="alert">
              Invalid period: {resolved.message}
            </p>
          )}
        </div>
      </div>

      {/* --- decision evidence (FR-028) ---------------------------------- */}
      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
          Decision evidence (exact versions; later corrections never alter it)
        </h3>
        {evidence !== null && evidence.ok ? (
          <>
            <p style={{ fontSize: 10, margin: '0 0 8px' }}>
              Decision <strong>{evidence.value.decisionId}</strong> recorded {evidence.value.decidedAt} by {evidence.value.decidedBy}. Method{' '}
              {evidence.value.aggregationMethod}; basis {evidence.value.processingBasis}. Evidence hash (demo digest){' '}
              <code style={{ fontSize: 9 }}>{formatHash(evidence.value.evidenceHash)}</code>.
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="site-table" aria-describedby="as-intro">
                <caption className="sr-only">
                  Pinned observation and revision evidence inside the selected half-open period. The pinned revision id is the exact
                  version the decision used; appended corrections never change these rows.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Observation</th>
                    <th scope="col">Observed at</th>
                    <th scope="col">Revision used</th>
                    <th scope="col">Used / chain version</th>
                    <th scope="col">Pinned value</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.value.evidence.map((row) => (
                    <tr key={row.observationId}>
                      <th scope="row" tabIndex={0} title={row.logicalKey}>
                        {row.observationId}
                        <small style={SMALL_MUTED}>{row.streamId}</small>
                      </th>
                      <td tabIndex={-1}>{row.observedAt}</td>
                      <td tabIndex={-1}>
                        {row.revisionId ?? 'raw original'}
                        <small style={SMALL_MUTED}>level {row.usedProcessingLevel}</small>
                      </td>
                      <td tabIndex={-1}>
                        v{row.usedVersion} / v{row.chainVersion}
                        <small style={SMALL_MUTED}>{row.belowSelectedBasis ? 'below selected basis (raw shown)' : `head ${row.headRevisionId ?? 'none'}`}</small>
                      </td>
                      <td tabIndex={-1}>{row.value === null ? 'null frame' : `${row.value} (raw units)`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 9, margin: '8px 0 0', color: '#5d6a5f' }}>
              Curve lineage:{' '}
              {evidence.value.curveLineage
                .map((entry) => `${entry.streamId} → ${entry.curveVersionIds.join(', ') || 'no curve versions'} (in force at start: ${entry.curveAtStart ?? 'none'})`)
                .join(' · ') || 'none in scope'}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 10, margin: 0, color: '#5d6a5f' }}>
            Fix the period above to record decision evidence.
          </p>
        )}
      </div>

      {/* --- finalize flow (FR-029) -------------------------------------- */}
      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
          Finalize (authority-aware; optimistic concurrency)
        </h3>
        <p style={{ fontSize: 9, margin: '0 0 8px', color: '#5d6a5f' }}>
          {currentAuthority === null
            ? 'Unknown principal.'
            : actorMayFinalize
              ? `${currentAuthority.displayName} may finalize ${SYSTEM_ID} via ${currentAuthority.via} (${currentAuthority.basis}). Rule pending owner ratification.`
              : `${currentAuthority.displayName} holds no finalize authority for ${SYSTEM_ID} (${currentAuthority.basis}); the server denies with 403.`}
        </p>
        <form onSubmit={handleFinalize} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <button type="submit" disabled={!resolved.ok || !actorMayFinalize} style={{ fontSize: 10 }} aria-disabled={!resolved.ok || !actorMayFinalize}>
            Finalize this period
          </button>
          <span style={{ fontSize: 9, color: '#a0aa99' }}>
            Guard: expected current record {currentHead?.record.id ?? '(empty slot)'}
          </span>
        </form>
        {currentHead !== null && (
          <form onSubmit={handleSupersede} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
            <div>
              <label htmlFor="as-reason" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Correction reason (retained verbatim on the superseding record)
              </label>
              <input id="as-reason" type="text" value={supersedeReason} onChange={(event) => setSupersedeReason(event.target.value)} style={{ fontSize: 10, width: 320 }} />
            </div>
            <button type="submit" disabled={!resolved.ok || !actorMayFinalize} style={{ fontSize: 10 }}>
              Supersede with corrected accounting
            </button>
          </form>
        )}
        <div aria-live="polite" style={{ marginTop: 8 }}>
          {outcome !== null && (
            <p style={{ fontSize: 10, margin: 0 }} role={outcome.outcome === 'denied' ? 'alert' : undefined}>
              {outcome.outcome === 'finalized' ? (
                <>
                  {outcome.replayed ? 'Replayed the finalized record (identical content; nothing superseded): ' : 'Finalized: '}
                  <strong>{outcome.record.id}</strong> · content {formatHash(outcome.record.contentHash)} (demo digest) · by{' '}
                  {outcome.record.finalizedBy} at {outcome.record.finalizedAt}
                  {outcome.record.supersedes !== null ? ` · supersedes ${outcome.record.supersedes}` : ''}
                </>
              ) : outcome.outcome === 'conflict' ? (
                <>
                  <strong>TYPED CONFLICT {outcome.code}</strong> — {outcome.message}
                  {outcome.currentFinalizedId !== null ? ` Retry against ${outcome.currentFinalizedId} or supersede it explicitly.` : ''}
                </>
              ) : (
                <>
                  <strong>Denied {outcome.status}</strong> — {outcome.message}
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* --- finalized record view (FR-029) ------------------------------ */}
      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
        <h3 id="as-chain-heading" style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
          Finalized records for this period slot ({chain.length} version{chain.length === 1 ? '' : 's'})
        </h3>
        {chain.length > 0 ? (
          <>
            {chain.map((view) => {
              const banner = supersededBanner(view);
              return banner === null ? null : (
                <p key={`banner-${view.record.id}`} style={{ fontSize: 10, margin: '0 0 6px' }} role="status">
                  {banner}
                </p>
              );
            })}
            <div style={{ overflowX: 'auto' }}>
              <table className="site-table" aria-describedby="as-chain-heading">
                <caption className="sr-only">
                  Supersession chain of this period slot. Each finalized record is frozen: authorized corrections append a linked
                  superseding version and never rewrite prior bytes or hashes.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">State</th>
                    <th scope="col">Content hash (demo)</th>
                    <th scope="col">Finalized by / at</th>
                    <th scope="col">Linkage</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.map((view) => {
                    const badge = statusBadge(view.status);
                    return (
                      <tr key={view.record.id}>
                        <th scope="row" tabIndex={0}>
                          v{view.ordinal} {view.record.id}
                        </th>
                        <td tabIndex={-1}>
                          <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
                            {badge.marker}
                          </span>
                          {badge.text}
                        </td>
                        <td tabIndex={-1}>
                          <code style={{ fontSize: 9 }}>{formatHash(view.record.contentHash)}</code>
                        </td>
                        <td tabIndex={-1}>
                          {view.record.finalizedBy}
                          <small style={SMALL_MUTED}>{view.record.finalizedAt}</small>
                        </td>
                        <td tabIndex={-1} style={{ maxWidth: 360, whiteSpace: 'normal' }}>
                          {linkageText(view)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 10, margin: 0, color: '#5d6a5f' }}>
            No finalized record occupies this period slot yet. Finalizing freezes the content hash; supersession is the only
            correction path.
          </p>
        )}
      </div>

      {/* --- supplemental advisory (FR-030) ------------------------------ */}
      <div style={{ padding: '13px 19px' }}>
        <h3 id="as-supp-heading" style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
          Supplemental water context (advisory)
        </h3>
        <p id="as-supp-note" style={{ fontSize: 10, margin: '0 0 8px', color: '#5d6a5f' }}>
          {ADVISORY_LABEL_MODEL}. Pending declarations are excluded from every number:{' '}
          {DEMO_SUPPLEMENTAL_INPUTS.filter((input) => input.status === 'pending').map((input) => input.label).join('; ') || 'none'}.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="site-table" aria-describedby="as-supp-note">
            <caption className="sr-only">Advisory supplemental comparison against approved inputs only. {ADVISORY_LABEL_MODEL}.</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Measured (acre-feet)</th>
                <th scope="col">Approved supplemental (acre-feet)</th>
                <th scope="col">Difference (acre-feet)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {supplementalRows.map((row) => (
                <tr key={row.category}>
                  <th scope="row" tabIndex={0}>
                    {row.category}
                  </th>
                  <td tabIndex={-1}>{row.measuredVolumeAcreFeet.toFixed(3)}</td>
                  <td tabIndex={-1}>{row.supplementalVolumeAcreFeet.toFixed(3)}</td>
                  <td tabIndex={-1}>{row.differenceAcreFeet.toFixed(3)}</td>
                  <td tabIndex={-1}>
                    <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
                      ≈
                    </span>
                    Advisory
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
