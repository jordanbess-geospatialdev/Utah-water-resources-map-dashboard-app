/**
 * AssetTransferPanel - the FR-048 asset inventory and transfer UI.
 *
 * "Equipment records preserve make, model, identifier and serial-number
 * evidence; transferring an asset closes the old site association and
 * opens a dated new association without moving historical inspections to
 * the wrong site."
 *
 * Three surfaces:
 * 1. EQUIPMENT LIST: evidence fields (make, model, identifier, serial,
 *    photo count) plus the current association;
 * 2. TRANSFER FORM: from-site locked to the current association, to-site
 *    picker within the acting persona's assignment scope (the shell passes
 *    the scope; the panel never guesses), a dated boundary instant, and
 *    the identifier/serial evidence the actor confirms on site;
 * 3. HISTORY VIEW: the association periods of the selected equipment
 *    (dated, half-open) and the site's visits, which STAY at the site
 *    where they occurred - the panel states the rule where the user can
 *    read it.
 *
 * Accessibility contract (mirrors the visits panel): real <table> elements
 * with caption, scope="col"/scope="row" headers, labelled form fields,
 * fieldset/legend grouping, keyboard-navigable controls, and first-class
 * loading / empty / error-with-retry / denied states (role=status /
 * role=alert). Mountable, shell-free: data arrives via props with a
 * deterministic demo seed; submission is an injected port.
 */
import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import {
  composeTransferBody,
  currentPeriodOf,
  DEMO_ASSOCIATIONS,
  DEMO_EQUIPMENT,
  DEMO_SITES,
  DEMO_VISITS,
  evidenceLabel,
  formatPeriod,
  periodsAtSite,
  associationPeriodsOf,
  siteOfAt,
  validateTransferForm,
  visitsOfSite,
  type AssociationPeriod,
  type EquipmentView,
  type SiteOption,
  type TransferFormValues,
  type VisitRow,
} from './transferModel';

export interface AssetTransferPanelProps {
  /** Equipment registry rows (already loaded). */
  readonly equipment?: readonly EquipmentView[];
  /** Association periods of every equipment row. */
  readonly associations?: readonly AssociationPeriod[];
  /** Sites the acting persona may transfer WITHIN (scope decided by the shell/policy). */
  readonly sites?: readonly SiteOption[];
  /** Visit rows for the history view (stays at the site where they occurred). */
  readonly visits?: readonly VisitRow[];
  /** Data status. */
  readonly status?: 'loading' | 'ready' | 'error' | 'denied';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly deniedMessage?: string;
  /** Submit port: the shell posts composeTransferBody() to the API. */
  readonly onTransfer?: (body: ReturnType<typeof composeTransferBody>) => void;
  /** Whether a submission is in flight (drives the submitting state). */
  readonly submitting?: boolean;
  /** Submission-level message from the shell (success/error confirmation). */
  readonly submitMessage?: string | null;
}

const MUTED: CSSProperties = { color: '#6b7566', fontSize: 11 };
const SECTION: CSSProperties = { marginTop: 16 };

const INPUT_STYLE: CSSProperties = { display: 'block', width: '100%', maxWidth: 320, padding: '6px 8px', fontSize: 13 };

function defaultForm(equipment: EquipmentView, periods: readonly AssociationPeriod[]): TransferFormValues {
  const current = currentPeriodOf(periods);
  return {
    equipmentId: equipment.id,
    fromSiteId: current?.siteId ?? '',
    toSiteId: '',
    effectiveAt: '',
    identifier: equipment.identifier,
    serial: equipment.serial,
  };
}

export default function AssetTransferPanel({
  equipment,
  associations,
  sites,
  visits,
  status = 'ready',
  errorMessage,
  onRetry,
  deniedMessage,
  onTransfer,
  submitting = false,
  submitMessage = null,
}: AssetTransferPanelProps) {
  // Deterministic demo seed by default (the shell wires live data later);
  // explicit props always win, including an explicit empty array.
  const rows = equipment ?? DEMO_EQUIPMENT;
  const periods = associations ?? DEMO_ASSOCIATIONS;
  const siteOptions = sites ?? DEMO_SITES;
  const visitRows = visits ?? DEMO_VISITS;
  const [selectedId, setSelectedId] = useState<string>('');
  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? rows[0] ?? null, [rows, selectedId]);
  const selectedPeriods = useMemo(() => periods.filter((period) => period.equipmentId === selected?.id), [periods, selected]);
  const [form, setForm] = useState<TransferFormValues | null>(null);
  const activeForm = form && form.equipmentId === selected?.id ? form : selected ? defaultForm(selected, selectedPeriods) : null;

  const errors = useMemo(
    () =>
      selected && activeForm
        ? validateTransferForm(activeForm, selected, selectedPeriods, { allowedSiteIds: siteOptions.map((site) => site.id) })
        : [],
    [activeForm, selected, selectedPeriods, siteOptions],
  );
  const errorByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const error of errors) map.set(error.fieldPath, error.message);
    return map;
  }, [errors]);

  const currentSiteId = currentPeriodOf(selectedPeriods)?.siteId ?? null;
  const historySitePeriods = useMemo(
    () => (currentSiteId ? periodsAtSite(periods, currentSiteId) : []),
    [periods, currentSiteId],
  );
  const historyVisits = useMemo(() => (currentSiteId ? visitsOfSite(visitRows, currentSiteId) : []), [visitRows, currentSiteId]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!selected || !activeForm || errors.length > 0 || submitting || !onTransfer) return;
    onTransfer(composeTransferBody(activeForm));
    setForm(defaultForm(selected, selectedPeriods));
  }

  if (status === 'loading') {
    return (
      <section aria-busy="true" role="status" style={SECTION}>
        <h3>Asset inventory</h3>
        <p style={MUTED}>Loading equipment records...</p>
      </section>
    );
  }
  if (status === 'denied') {
    return (
      <section role="alert" style={SECTION}>
        <h3>Asset inventory</h3>
        <p>{deniedMessage ?? 'You are not permitted to view asset inventory for this scope.'}</p>
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section role="alert" style={SECTION}>
        <h3>Asset inventory</h3>
        <p>{errorMessage ?? 'Asset inventory could not be loaded.'}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </section>
    );
  }
  if (rows.length === 0) {
    return (
      <section style={SECTION}>
        <h3>Asset inventory</h3>
        <p style={MUTED}>No equipment records yet. Registered assets appear here with their make, model, identifier, serial and photo evidence.</p>
      </section>
    );
  }

  return (
    <section style={SECTION}>
      <h3>Asset inventory and transfers</h3>

      {/* 1. Equipment list with evidence fields */}
      <table>
        <caption>Equipment records with site evidence</caption>
        <thead>
          <tr>
            <th scope="col">Equipment</th>
            <th scope="col">Evidence (make / model / identifier / serial)</th>
            <th scope="col">Photos</th>
            <th scope="col">Current site</th>
            <th scope="col">Select</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = currentPeriodOf(periods.filter((period) => period.equipmentId === row.id));
            return (
              <tr key={row.id}>
                <th scope="row">{row.id}</th>
                <td>
                  {row.make} {row.model} / {row.identifier} / s/n {row.serial}
                </td>
                <td>{row.photoRefs.length}</td>
                <td>{current ? `${current.siteId} (${formatPeriod(current)})` : '(none)'}</td>
                <td>
                  <button type="button" aria-pressed={selected?.id === row.id} onClick={() => setSelectedId(row.id)}>
                    {selected?.id === row.id ? 'Selected' : 'Select'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selected ? (
        <>
          {/* 2. Transfer flow: from locked, to within scope, dated */}
          <form onSubmit={handleSubmit} aria-label={`Transfer ${selected.id}`}>
            <fieldset>
              <legend>
                Transfer {evidenceLabel(selected)}
              </legend>
              <p style={MUTED}>
                A transfer closes the current site association and opens a dated new one at the chosen instant. Historical inspections stay
                attached to the site where they occurred.
              </p>
              <label>
                From site (current association, locked)
                <input style={INPUT_STYLE} type="text" readOnly value={activeForm?.fromSiteId ?? ''} />
              </label>
              <label>
                To site (within your assignment scope)
                <select
                  style={INPUT_STYLE}
                  value={activeForm?.toSiteId ?? ''}
                  onChange={(event) => setForm({ ...(activeForm ?? defaultForm(selected, selectedPeriods)), toSiteId: event.target.value })}
                >
                  <option value="">Choose destination site...</option>
                  {siteOptions
                    .filter((site) => site.id !== activeForm?.fromSiteId)
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.displayName} ({site.id})
                      </option>
                    ))}
                </select>
              </label>
              {errorByField.has('toSiteId') ? (
                <p role="alert" style={{ color: '#8c3b2e', fontSize: 12 }}>
                  {errorByField.get('toSiteId')}
                </p>
              ) : null}
              <label>
                Effective instant (ISO 8601 with offset)
                <input
                  style={INPUT_STYLE}
                  type="text"
                  placeholder="2026-04-01T00:00:00Z"
                  value={activeForm?.effectiveAt ?? ''}
                  onChange={(event) => setForm({ ...(activeForm ?? defaultForm(selected, selectedPeriods)), effectiveAt: event.target.value })}
                />
              </label>
              {errorByField.has('effectiveAt') ? (
                <p role="alert" style={{ color: '#8c3b2e', fontSize: 12 }}>
                  {errorByField.get('effectiveAt')}
                </p>
              ) : null}
              <label>
                Identifier evidence (confirmed on site)
                <input
                  style={INPUT_STYLE}
                  type="text"
                  value={activeForm?.identifier ?? ''}
                  onChange={(event) => setForm({ ...(activeForm ?? defaultForm(selected, selectedPeriods)), identifier: event.target.value })}
                />
              </label>
              <label>
                Serial-number evidence (confirmed on site)
                <input
                  style={INPUT_STYLE}
                  type="text"
                  value={activeForm?.serial ?? ''}
                  onChange={(event) => setForm({ ...(activeForm ?? defaultForm(selected, selectedPeriods)), serial: event.target.value })}
                />
              </label>
              {errorByField.has('serial') ? (
                <p role="alert" style={{ color: '#8c3b2e', fontSize: 12 }}>
                  {errorByField.get('serial')}
                </p>
              ) : null}
              <button type="submit" disabled={errors.length > 0 || submitting}>
                {submitting ? 'Transferring...' : 'Record transfer'}
              </button>
              {submitMessage ? (
                <p role="status" style={{ fontSize: 12 }}>
                  {submitMessage}
                </p>
              ) : null}
            </fieldset>
          </form>

          {/* 3. History view: association periods + site visits */}
          <h4>Association history of {selected.id}</h4>
          <table>
            <caption>Site association periods (dated; the boundary instant belongs to the new site)</caption>
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Period</th>
                <th scope="col">Opened by</th>
              </tr>
            </thead>
            <tbody>
              {associationPeriodsOf(selectedPeriods).map((period) => (
                <tr key={`${period.siteId}-${period.effectiveFrom}`}>
                  <th scope="row">{period.siteId}</th>
                  <td>{formatPeriod(period)}</td>
                  <td>{period.openedByTransferId ?? 'initial registration'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {currentSiteId ? (
            <>
              <h4>Equipment at {currentSiteId}</h4>
              <table>
                <caption>Association periods at the current site</caption>
                <thead>
                  <tr>
                    <th scope="col">Equipment</th>
                    <th scope="col">Period</th>
                  </tr>
                </thead>
                <tbody>
                  {historySitePeriods.map((period) => (
                    <tr key={`${period.equipmentId}-${period.effectiveFrom}`}>
                      <th scope="row">{period.equipmentId}</th>
                      <td>{formatPeriod(period)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h5>Visits recorded at {currentSiteId} (never re-filed by transfers)</h5>
              {historyVisits.length === 0 ? (
                <p style={MUTED}>No visits recorded at this site.</p>
              ) : (
                <ul>
                  {historyVisits.map((visit) => (
                    <li key={visit.id}>
                      {visit.visitTime.slice(0, 10)} - {visit.type} - {visit.notes}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
          <p style={MUTED}>
            {selected.id} was at {siteOfAt(selectedPeriods, selected.registeredAt) ?? '(unregistered)'} at registration
            ({selected.registeredAt.slice(0, 10)}).
          </p>
        </>
      ) : null}
    </section>
  );
}
