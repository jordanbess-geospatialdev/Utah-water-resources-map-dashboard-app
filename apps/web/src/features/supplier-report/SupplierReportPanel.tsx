import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  BOUNDARY_SECTIONS_V1,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  EMPTY_SECTIONS,
  HISTORICAL_YEARS,
  PERIOD_RULES,
  RETURN_TYPES,
  SOURCE_TYPES,
  approveBoundaryMirror,
  canOpenNewVersion,
  demoActor,
  freezeDemoSubmission,
  historicalDischargeOf,
  issuesForField,
  makeBoundaryProposal,
  parseImportText,
  previewImportRows,
  applyPreviewToSections,
  scopeOfActor,
  validateSections,
  type BoundaryProposalModel,
  type BoundarySectionModel,
  type DemoSubmittedReport,
  type PeriodBasis,
  type ReportSections,
  type ValidationIssue,
} from './reportModel';

/**
 * Supplier report panel (WD-017; FR-053..FR-057): the assigned organization's
 * system view with historical discharge, the seven category form sections
 * with INLINE TEXT validation plus an accessible summary panel, the file
 * import preview (mapped units/periods, invalid rows, idempotent retry), the
 * submit flow with confirmation and the frozen submitted view (version,
 * submitter, content hash visible), and the boundary proposal UI with
 * section comments (approval shown as the reviewer-only distinct transition).
 *
 * Scope enforcement is visible: the panel renders ONLY the acting
 * organization's system (the other supplier's system does not exist for this
 * account - hidden-object 404 server-side). Until the HTTP service lands,
 * submit/import run the deterministic local mirror (reportModel.ts,
 * golden-pinned to the API domain); the panel says so in the UI.
 */
export interface SupplierReportPanelProps {
  /** Acting account (default: the Wiley demo synthesis for org-cache-water). */
  actorId?: string;
  /** Called with the frozen submission instead of rendering it inline. */
  onSubmit?: (submission: DemoSubmittedReport) => void;
}

const FIELD_STYLE: CSSProperties = { margin: '0 0 10px' };
const LABEL_STYLE: CSSProperties = { display: 'block', fontWeight: 600, marginBottom: 2 };
const ISSUE_STYLE: CSSProperties = { margin: '2px 0 6px', fontSize: 11 };

type PeriodBasisOption = { readonly id: PeriodBasis; readonly label: string };
const PERIOD_OPTIONS: readonly PeriodBasisOption[] = [
  { id: 'calendar-year', label: 'Calendar year' },
  { id: 'water-year', label: 'Water year (Oct-Sep)' },
  { id: 'irrigation-season', label: 'Irrigation season (Apr 1 - Oct 31)' },
];

function IssueText({ issues }: { issues: readonly ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div style={ISSUE_STYLE}>
      {issues.map((issue) => (
        <p key={issue.fieldPath + issue.code} style={{ margin: '2px 0', color: issue.severity === 'error' ? '#8a3b2c' : '#6b5321' }}>
          {issue.severity === 'error' ? 'Error: ' : 'Warning: '}
          {issue.message}
        </p>
      ))}
    </div>
  );
}

function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export default function SupplierReportPanel({ actorId = 'demo-wiley-cache-water', onSubmit }: SupplierReportPanelProps) {
  const actor = demoActor(actorId);
  const scope = scopeOfActor(actorId);
  const history = useMemo(() => (scope ? historicalDischargeOf(scope.orgId) : []), [scope]);

  const [basis, setBasis] = useState<PeriodBasis>('calendar-year');
  const [year, setYear] = useState(2026);
  const [sections, setSections] = useState<ReportSections>(EMPTY_SECTIONS);
  const [submission, setSubmission] = useState<DemoSubmittedReport | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [appliedImports, setAppliedImports] = useState<string[]>([]);

  const [importText, setImportText] = useState('');
  const [fileBasis, setFileBasis] = useState<PeriodBasis>('calendar-year');
  const [fileYear, setFileYear] = useState(2026);
  const [preview, setPreview] = useState<ReturnType<typeof previewImportRows> | null>(null);
  const [previewImportId, setPreviewImportId] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState('');

  const [boundary, setBoundary] = useState<readonly BoundarySectionModel[]>(BOUNDARY_SECTIONS_V1);
  const [boundaryVersion, setBoundaryVersion] = useState(1);
  const [proposal, setProposal] = useState<BoundaryProposalModel | null>(null);
  const [proposalSection, setProposalSection] = useState('service-area');
  const [proposalSummary, setProposalSummary] = useState('');
  const [proposalReason, setProposalReason] = useState('');
  const [commentSection, setCommentSection] = useState('service-area');
  const [commentText, setCommentText] = useState('');
  const [boundaryMessage, setBoundaryMessage] = useState('');

  const period = { basis, year };
  const validation = useMemo(() => validateSections(sections, period), [sections, period]);
  const locked = submission !== null && submission.status === 'submitted';

  if (!actor || !scope || actor.role !== 'supplier') {
    const name = actor?.displayName ?? actorId;
    return (
      <div className="panel" data-feature="supplier-report">
        <div className="panel-heading">
          <h2>Supplier annual report</h2>
          <span>No supplier assignment for this account</span>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <p role="status" style={{ color: '#8a3b2c' }}>
            {actor && actor.role === 'reviewer'
              ? `${name} is a Water Use reviewer account: reviews and approvals are a separate console (future work). Supplier drafts are entered by the assigned organization's members.`
              : `Account ${name || actorId} has no verified supplier organization assignment: the supplier system view requires one (403 server-side).`}
          </p>
          <p className="muted" style={{ fontSize: 11 }}>
            Supplier reports and boundaries need a verified organization assignment (FR-053). The fixture principals hold no supplier-reporting grant - notably the statewide steward does not satisfy it.
          </p>
        </div>
      </div>
    );
  }

  const scalarInput = (
    id: string,
    label: string,
    value: number | string | null,
    unit: string,
    onSet: (next: string) => void,
    issues: readonly ValidationIssue[],
    required: boolean,
  ) => (
    <div style={FIELD_STYLE}>
      <label htmlFor={id} style={LABEL_STYLE}>
        {label} ({unit}){required ? ' — required' : ''}
      </label>
      <input id={id} value={value === null ? '' : String(value)} onChange={(event) => onSet(event.target.value)} aria-describedby={issues.length > 0 ? `${id}-issue` : undefined} />
      {issues.length > 0 ? (
        <div id={`${id}-issue`}>
          <IssueText issues={issues} />
        </div>
      ) : null}
    </div>
  );

  const setCulinary = (key: 'populationServed' | 'activeConnections' | 'annualCulinaryVolumeGallons' | 'meteredPercent', text: string): void =>
    setSections((current) => ({ ...current, culinaryUse: { ...current.culinaryUse, [key]: numberOrNull(text) } }));
  const setPeak = (key: 'peakDayVolumeGallons' | 'peakHourDemandGpm', text: string): void =>
    setSections((current) => ({ ...current, sourcePeakDemand: { ...current.sourcePeakDemand, [key]: numberOrNull(text) } }));
  const setSecondary = (key: 'irrigatedAcres' | 'secondaryConnections' | 'annualSecondaryVolumeGallons', text: string): void =>
    setSections((current) => ({ ...current, secondaryUse: { ...current.secondaryUse, [key]: numberOrNull(text) } }));

  const doImportPreview = (): void => {
    const parsed = parseImportText(importText);
    if (parsed.parseErrors.length > 0) {
      setPreview(null);
      setPreviewImportId(null);
      setImportMessage(parsed.parseErrors.join(' '));
      return;
    }
    // The import id is minted per PREVIEW: retrying the same file (same
    // preview) carries the same id and can never apply twice (FR-056).
    setPreviewImportId(`imp-${appliedImports.length + 1}`);
    setPreview(previewImportRows(parsed.rows, period, fileBasis, fileYear));
    setImportMessage('');
  };

  const doImportApply = (): void => {
    if (!preview || !previewImportId) return;
    if (appliedImports.includes(previewImportId)) {
      setImportMessage(`Import ${previewImportId} already applied: nothing re-applied (a retried file creates no duplicates).`);
      return;
    }
    if (!preview.applicable) {
      setImportMessage('The preview is not applicable: fix the file period or the invalid rows first.');
      return;
    }
    setSections((current) => applyPreviewToSections(current, preview.mappings));
    setAppliedImports((current) => [...current, previewImportId]);
    setImportMessage(`Import ${previewImportId} applied: ${preview.mappings.length} mapped value(s) written into the same validated model. Retrying this import changes nothing.`);
  };

  const doSubmit = (): void => {
    if (validation.summary.errorCount > 0) return;
    const version = (submission?.version ?? 0) + 1;
    const frozen = freezeDemoSubmission({ sections, validation, actorId, orgId: scope.orgId, systemId: scope.systemId, period, version });
    if (onSubmit) onSubmit(frozen);
    setSubmission(frozen);
    setConfirming(false);
  };

  const simulateReviewerApproval = (): void => {
    if (!submission || submission.status !== 'submitted') return;
    setSubmission({ ...submission, status: 'resubmission-approved' });
  };

  const createProposal = (): void => {
    const result = makeBoundaryProposal({
      actorId,
      sequence: proposal ? 2 : 1,
      approved: boundary,
      changes: [{ sectionId: proposalSection, proposedSummary: proposalSummary, changeReason: proposalReason }],
    });
    if ('error' in result) {
      setBoundaryMessage(result.error);
      return;
    }
    setProposal(result);
    setProposalSummary('');
    setProposalReason('');
    setBoundaryMessage(`Proposal ${result.proposalId} created (status: proposed). The approved boundary stays at its current version until the reviewer approval transition.`);
  };

  const addComment = (): void => {
    if (!proposal || commentText.trim().length === 0) return;
    setProposal({
      ...proposal,
      comments: [
        ...proposal.comments,
        { commentId: `c-${proposal.proposalId}-${proposal.comments.length + 1}`, sectionId: commentSection, authorId: actorId, authorRole: 'supplier', text: commentText, at: '2026-04-02T15:30:00Z' },
      ],
    });
    setCommentText('');
  };

  const approveProposal = (): void => {
    if (!proposal || proposal.status !== 'review') return;
    const result = approveBoundaryMirror(proposal, boundary, actorId, '2026-04-02T15:30:00Z');
    setProposal(result.proposal);
    setBoundary(result.boundary);
    setBoundaryVersion((current) => current + 1);
    setBoundaryMessage(`Approved: boundary version ${result.proposal.resultingBoundaryVersion} derived from ${proposal.proposalId}. The prior version stays queryable. (Demo: performed by the assigned supplier account; the server gate requires the reviewer role.)`);
  };

  return (
    <div className="panel" data-feature="supplier-report">
      <div className="panel-heading">
        <h2>Supplier annual report</h2>
        <span>
          {scope.orgName} · {scope.systemName} · organization-scoped (FR-053..057)
        </span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <p style={{ ...FIELD_STYLE, fontSize: 11 }}>
          Acting as <strong>{actor.displayName}</strong>, a verified member of {scope.orgName}. Only {scope.systemName} exists for this account; the other supplier's
          system, drafts and proposals are hidden (404) and never listed here.
        </p>

        {/* ---------------------------------------------------------------- */}
        {/* FR-053 assigned system view */}
        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 12px', padding: '8px 10px' }}>
          <legend>Assigned system view (FR-053)</legend>
          <h3 style={{ margin: '4px 0 6px', fontSize: 13 }}>Area sources</h3>
          <ul style={{ margin: '0 0 8px 16px', fontSize: 11 }}>
            {scope.stations.map((station) => (
              <li key={station.stationId}>
                {station.displayName} ({station.stationId}, {station.status}, {station.visibility})
                {station.dischargeStreams.length === 0 ? ' — no discharge stream' : ` — ${station.dischargeStreams.map((stream) => stream.streamId).join(', ')}`}
              </li>
            ))}
          </ul>
          <h3 style={{ margin: '8px 0 6px', fontSize: 13 }}>Historical discharge (calendar-year totals, acre-feet)</h3>
          <table style={{ fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', paddingRight: 12 }}>Stream</th>
                {HISTORICAL_YEARS.map((historicalYear) => (
                  <th key={historicalYear} style={{ paddingRight: 12 }}>
                    {historicalYear}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.streamId}>
                  <td style={{ paddingRight: 12 }}>{row.streamId}</td>
                  {row.years.map((yearRow) => (
                    <td key={yearRow.year} style={{ paddingRight: 12 }}>
                      {yearRow.volumeAcreFeet === null ? 'No covered data' : `${yearRow.volumeAcreFeet.toFixed(1)} (${row.unitId})`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 10, margin: '6px 0 0' }}>
            Unavailable years are shown as “No covered data”, never as zero (missing is missing). Owner streams only; discharge numerics mirror the WD-008 aggregation domain and are golden-pinned.
          </p>
        </fieldset>

        {/* ---------------------------------------------------------------- */}
        {/* FR-055 category sections with inline text validation + summary */}
        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 12px', padding: '8px 10px' }} disabled={locked}>
          <legend>Annual report draft (FR-055 categories)</legend>
          <div style={FIELD_STYLE}>
            <label htmlFor="supplier-period-basis" style={LABEL_STYLE}>
              Period basis
            </label>
            <select id="supplier-period-basis" value={basis} onChange={(event) => setBasis(event.target.value as PeriodBasis)}>
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
              {PERIOD_RULES[basis]}
            </p>
          </div>
          <div style={FIELD_STYLE}>
            <label htmlFor="supplier-period-year" style={LABEL_STYLE}>
              Period year
            </label>
            <input id="supplier-period-year" type="number" min={1900} max={2100} value={year} onChange={(event) => setYear(Number(event.target.value))} />
          </div>

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{CATEGORY_LABELS['culinary-use']}</h3>
          {scalarInput('f-population', 'Population served', sections.culinaryUse.populationServed, 'persons', (text) => setCulinary('populationServed', text), issuesForField(validation, 'culinaryUse.populationServed'), true)}
          {scalarInput('f-connections', 'Active connections', sections.culinaryUse.activeConnections, 'connections', (text) => setCulinary('activeConnections', text), issuesForField(validation, 'culinaryUse.activeConnections'), true)}
          {scalarInput('f-culinary-volume', 'Annual culinary volume', sections.culinaryUse.annualCulinaryVolumeGallons, 'gallons', (text) => setCulinary('annualCulinaryVolumeGallons', text), issuesForField(validation, 'culinaryUse.annualCulinaryVolumeGallons'), true)}
          {scalarInput('f-metered', 'Metered share', sections.culinaryUse.meteredPercent, 'percent', (text) => setCulinary('meteredPercent', text), issuesForField(validation, 'culinaryUse.meteredPercent'), false)}

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{CATEGORY_LABELS['source-inventory']}</h3>
          {issuesForField(validation, 'sourceInventory').length > 0 ? <IssueText issues={issuesForField(validation, 'sourceInventory')} /> : null}
          {sections.sourceInventory.map((entry, index) => (
            <fieldset key={entry.sourceId || index} style={{ border: '1px dashed #c9d6c9', margin: '0 0 6px', padding: '6px 8px', fontSize: 11 }}>
              <legend style={{ fontSize: 11 }}>{entry.name || entry.sourceId || `Source ${index + 1}`}</legend>
              <label style={{ display: 'block' }}>
                Identifier:{' '}
                <input
                  value={entry.sourceId}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, sourceId: event.target.value } : candidate)),
                    }))
                  }
                />
              </label>
              <label style={{ display: 'block' }}>
                Name:{' '}
                <input
                  value={entry.name}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, name: event.target.value } : candidate)),
                    }))
                  }
                />
              </label>
              <label style={{ display: 'block' }}>
                Type:{' '}
                <select
                  value={entry.sourceType}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, sourceType: event.target.value as (typeof SOURCE_TYPES)[number] } : candidate)),
                    }))
                  }
                >
                  {SOURCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                Pump capacity (gpm):{' '}
                <input
                  value={entry.pumpCapacityGpm ?? ''}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, pumpCapacityGpm: numberOrNull(event.target.value) } : candidate)),
                    }))
                  }
                />
              </label>
              <label style={{ display: 'block' }}>
                Annual withdrawal (gallons):{' '}
                <input
                  value={entry.annualWithdrawalGallons ?? ''}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, annualWithdrawalGallons: numberOrNull(event.target.value) } : candidate)),
                    }))
                  }
                />
              </label>
              <label style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={entry.metered}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      sourceInventory: current.sourceInventory.map((candidate, i) => (i === index ? { ...candidate, metered: event.target.checked } : candidate)),
                    }))
                  }
                />{' '}
                Metered
              </label>
              <IssueText issues={validation.issues.filter((issue) => issue.fieldPath.startsWith(`sourceInventory[${index}]`))} />
              <button
                type="button"
                style={{ fontSize: 11 }}
                onClick={() => setSections((current) => ({ ...current, sourceInventory: current.sourceInventory.filter((_, i) => i !== index) }))}
              >
                Remove source
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            style={{ fontSize: 11 }}
            onClick={() => setSections((current) => ({ ...current, sourceInventory: [...current.sourceInventory, { sourceId: '', sourceType: 'well', name: '', pumpCapacityGpm: null, annualWithdrawalGallons: null, metered: false }] }))}
          >
            Add source
          </button>

          {(['purchase-inventory', 'wholesale-inventory', 'return-inventory'] as const).map((category) => (
            <div key={category}>
              <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{CATEGORY_LABELS[category]}</h3>
              <p className="muted" style={{ fontSize: 10, margin: '0 0 4px' }}>
                Optional category: leave empty when nothing to report. Entries added below or by import.
              </p>
              {category === 'purchase-inventory' ? (
                <button
                  type="button"
                  style={{ fontSize: 11 }}
                  onClick={() => setSections((current) => ({ ...current, purchaseInventory: [...current.purchaseInventory, { sellerName: '', annualPurchasedGallons: null }] }))}
                >
                  Add purchase
                </button>
              ) : category === 'wholesale-inventory' ? (
                <button
                  type="button"
                  style={{ fontSize: 11 }}
                  onClick={() => setSections((current) => ({ ...current, wholesaleInventory: [...current.wholesaleInventory, { buyerName: '', annualSoldGallons: null }] }))}
                >
                  Add wholesale sale
                </button>
              ) : (
                <button
                  type="button"
                  style={{ fontSize: 11 }}
                  onClick={() => setSections((current) => ({ ...current, returnInventory: [...current.returnInventory, { returnType: 'treated-effluent', receivingBody: '', annualReturnedGallons: null }] }))}
                >
                  Add return
                </button>
              )}
              <ul style={{ margin: '6px 0 0 16px', fontSize: 11 }}>
                {category === 'purchase-inventory' &&
                  sections.purchaseInventory.map((entry, index) => (
                    <li key={index}>
                      Seller{' '}
                      <input
                        value={entry.sellerName}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            purchaseInventory: current.purchaseInventory.map((candidate, i) => (i === index ? { ...candidate, sellerName: event.target.value } : candidate)),
                          }))
                        }
                      />
                      , annual gallons{' '}
                      <input
                        value={entry.annualPurchasedGallons ?? ''}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            purchaseInventory: current.purchaseInventory.map((candidate, i) => (i === index ? { ...candidate, annualPurchasedGallons: numberOrNull(event.target.value) } : candidate)),
                          }))
                        }
                      />
                      <button type="button" style={{ fontSize: 11 }} onClick={() => setSections((current) => ({ ...current, purchaseInventory: current.purchaseInventory.filter((_, i) => i !== index) }))}>
                        Remove
                      </button>
                      <IssueText issues={validation.issues.filter((issue) => issue.fieldPath.startsWith(`purchaseInventory[${index}]`))} />
                    </li>
                  ))}
                {category === 'wholesale-inventory' &&
                  sections.wholesaleInventory.map((entry, index) => (
                    <li key={index}>
                      Buyer{' '}
                      <input
                        value={entry.buyerName}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            wholesaleInventory: current.wholesaleInventory.map((candidate, i) => (i === index ? { ...candidate, buyerName: event.target.value } : candidate)),
                          }))
                        }
                      />
                      , annual gallons{' '}
                      <input
                        value={entry.annualSoldGallons ?? ''}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            wholesaleInventory: current.wholesaleInventory.map((candidate, i) => (i === index ? { ...candidate, annualSoldGallons: numberOrNull(event.target.value) } : candidate)),
                          }))
                        }
                      />
                      <button type="button" style={{ fontSize: 11 }} onClick={() => setSections((current) => ({ ...current, wholesaleInventory: current.wholesaleInventory.filter((_, i) => i !== index) }))}>
                        Remove
                      </button>
                      <IssueText issues={validation.issues.filter((issue) => issue.fieldPath.startsWith(`wholesaleInventory[${index}]`))} />
                    </li>
                  ))}
                {category === 'return-inventory' &&
                  sections.returnInventory.map((entry, index) => (
                    <li key={index}>
                      Type{' '}
                      <select
                        value={entry.returnType}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            returnInventory: current.returnInventory.map((candidate, i) => (i === index ? { ...candidate, returnType: event.target.value as (typeof RETURN_TYPES)[number] } : candidate)),
                          }))
                        }
                      >
                        {RETURN_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      , receiving body{' '}
                      <input
                        value={entry.receivingBody}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            returnInventory: current.returnInventory.map((candidate, i) => (i === index ? { ...candidate, receivingBody: event.target.value } : candidate)),
                          }))
                        }
                      />
                      , annual gallons{' '}
                      <input
                        value={entry.annualReturnedGallons ?? ''}
                        onChange={(event) =>
                          setSections((current) => ({
                            ...current,
                            returnInventory: current.returnInventory.map((candidate, i) => (i === index ? { ...candidate, annualReturnedGallons: numberOrNull(event.target.value) } : candidate)),
                          }))
                        }
                      />
                      <button type="button" style={{ fontSize: 11 }} onClick={() => setSections((current) => ({ ...current, returnInventory: current.returnInventory.filter((_, i) => i !== index) }))}>
                        Remove
                      </button>
                      <IssueText issues={validation.issues.filter((issue) => issue.fieldPath.startsWith(`returnInventory[${index}]`))} />
                    </li>
                  ))}
              </ul>
            </div>
          ))}

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{CATEGORY_LABELS['source-peak-demand']}</h3>
          <div style={FIELD_STYLE}>
            <label htmlFor="f-peak-date" style={LABEL_STYLE}>
              Peak day (YYYY-MM-DD) — required, inside the reported period
            </label>
            <input
              id="f-peak-date"
              value={sections.sourcePeakDemand.peakDayDate ?? ''}
              onChange={(event) => setSections((current) => ({ ...current, sourcePeakDemand: { ...current.sourcePeakDemand, peakDayDate: event.target.value } }))}
              aria-describedby={issuesForField(validation, 'sourcePeakDemand.peakDayDate').length > 0 ? 'f-peak-date-issue' : undefined}
            />
            <div id="f-peak-date-issue">
              <IssueText issues={issuesForField(validation, 'sourcePeakDemand.peakDayDate')} />
            </div>
          </div>
          {scalarInput('f-peak-volume', 'Peak-day volume', sections.sourcePeakDemand.peakDayVolumeGallons, 'gallons', (text) => setPeak('peakDayVolumeGallons', text), issuesForField(validation, 'sourcePeakDemand.peakDayVolumeGallons'), true)}
          {scalarInput('f-peak-hour', 'Peak-hour demand', sections.sourcePeakDemand.peakHourDemandGpm, 'gpm', (text) => setPeak('peakHourDemandGpm', text), issuesForField(validation, 'sourcePeakDemand.peakHourDemandGpm'), false)}

          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{CATEGORY_LABELS['secondary-use']}</h3>
          <p className="muted" style={{ fontSize: 10, margin: '0 0 4px' }}>
            Optional as a whole; once any value is reported, every secondary field is required.
          </p>
          {scalarInput('f-acres', 'Irrigated acres', sections.secondaryUse.irrigatedAcres, 'acres', (text) => setSecondary('irrigatedAcres', text), issuesForField(validation, 'secondaryUse.irrigatedAcres'), false)}
          {scalarInput('f-secondary-connections', 'Secondary connections', sections.secondaryUse.secondaryConnections, 'connections', (text) => setSecondary('secondaryConnections', text), issuesForField(validation, 'secondaryUse.secondaryConnections'), false)}
          {scalarInput('f-secondary-volume', 'Annual secondary volume', sections.secondaryUse.annualSecondaryVolumeGallons, 'gallons', (text) => setSecondary('annualSecondaryVolumeGallons', text), issuesForField(validation, 'secondaryUse.annualSecondaryVolumeGallons'), false)}
          <label style={{ display: 'block', fontSize: 11, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={sections.secondaryUse.metered === true}
              onChange={(event) => setSections((current) => ({ ...current, secondaryUse: { ...current.secondaryUse, metered: event.target.checked } }))}
            />{' '}
            Secondary use metered
          </label>
        </fieldset>

        {/* Error summary panel (accessible, text-first; color is redundant) */}
        <div
          role="alert"
          aria-live="polite"
          style={{ border: `2px solid ${validation.summary.errorCount > 0 ? '#8a3b2c' : validation.summary.warningCount > 0 ? '#6b5321' : '#c9d6c9'}`, padding: '8px 10px', margin: '0 0 12px' }}
        >
          <strong>Validation summary ({CATEGORY_ORDER.length} categories):</strong> {validation.summary.headline}
          {validation.summary.lines.length > 0 ? (
            <ol style={{ margin: '6px 0 0 18px', fontSize: 11 }}>
              {validation.summary.lines.map((line) => (
                <li key={line}>{line.replace(/^\d+\.\s*/, '')}</li>
              ))}
            </ol>
          ) : null}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* FR-056 import */}
        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 12px', padding: '8px 10px' }} disabled={locked}>
          <legend>File import (FR-056)</legend>
          <p className="muted" style={{ fontSize: 10, margin: '0 0 6px' }}>
            Documented row format: <code>category,field,entryKey,value,unit</code> (blank entryKey for scalar fields; units gal / ac-ft / MG / persons / connections / gpm / acres / percent / date). Imports populate the SAME validated model as manual entry.
          </p>
          <div style={FIELD_STYLE}>
            <label htmlFor="import-file-basis" style={LABEL_STYLE}>
              File period basis
            </label>
            <select id="import-file-basis" value={fileBasis} onChange={(event) => setFileBasis(event.target.value as PeriodBasis)}>
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>{' '}
            <label htmlFor="import-file-year" style={{ ...LABEL_STYLE, display: 'inline' }}>
              year
            </label>{' '}
            <input id="import-file-year" type="number" min={1900} max={2100} value={fileYear} onChange={(event) => setFileYear(Number(event.target.value))} />
          </div>
          <div style={FIELD_STYLE}>
            <label htmlFor="import-text" style={LABEL_STYLE}>
              File rows
            </label>
            <textarea
              id="import-text"
              rows={4}
              style={{ width: '100%' }}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={'culinary-use,populationServed,,52400,persons\nsource-inventory,annualWithdrawalGallons,W-1,3700,ac-ft'}
            />
          </div>
          <button type="button" className="button" onClick={doImportPreview}>
            Preview import
          </button>{' '}
          <button type="button" className="button" onClick={doImportApply} disabled={!preview}>
            Apply preview
          </button>
          <p role="status" aria-live="polite" style={{ fontSize: 11, margin: '6px 0 0' }}>
            {importMessage}
          </p>
          {preview ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 11, margin: '0 0 4px' }}>{preview.periodNote}</p>
              <table style={{ fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', paddingRight: 10 }}>Row</th>
                    <th style={{ textAlign: 'left', paddingRight: 10 }}>Raw</th>
                    <th style={{ textAlign: 'left', paddingRight: 10 }}>Mapped</th>
                    <th style={{ textAlign: 'left' }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.mappings.map((mapping) => (
                    <tr key={`m-${mapping.rowIndex}`}>
                      <td style={{ paddingRight: 10 }}>{mapping.rowIndex}</td>
                      <td style={{ paddingRight: 10 }}>
                        {mapping.rawValue} {mapping.rawUnit}
                      </td>
                      <td style={{ paddingRight: 10 }}>
                        {typeof mapping.mappedValue === 'number' ? mapping.mappedValue.toLocaleString('en-US') : mapping.mappedValue} {mapping.mappedUnit}
                      </td>
                      <td>{mapping.note}</td>
                    </tr>
                  ))}
                  {preview.invalidRows.map((invalid) => (
                    <tr key={`i-${invalid.rowIndex}`}>
                      <td style={{ paddingRight: 10 }}>{invalid.rowIndex}</td>
                      <td colSpan={3} style={{ color: '#8a3b2c' }}>
                        Error: {invalid.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </fieldset>

        {/* ---------------------------------------------------------------- */}
        {/* FR-057 submit flow + frozen view */}
        {locked && submission ? (
          <div style={{ border: '2px solid #3a5a3a', padding: '10px 12px', margin: '0 0 12px' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>
              Submitted — version {submission.version} (frozen)
            </h3>
            <p style={{ fontSize: 12, margin: '0 0 4px' }}>
              Submitter: <strong>{submission.submitter}</strong> · Submitted at: {submission.submittedAt} · Status: {submission.status}
            </p>
            <p style={{ fontSize: 12, margin: '0 0 4px' }}>
              Content hash (demo digest of the frozen content): <code>{submission.contentHash}</code>
            </p>
            <p style={{ fontSize: 12, margin: '0 0 6px' }}>
              PDF manifest matches the submitted version (content hash equality); acknowledged warnings recorded: {submission.acknowledgedWarnings.length}. PDF rendering itself is the export pipeline's transport concern.
            </p>
            <details>
              <summary>PDF manifest content model ({submission.pdfManifest.blocks.length} blocks)</summary>
              <ul style={{ margin: '6px 0 0 18px', fontSize: 11 }}>
                {submission.pdfManifest.blocks.map((block, index) => (
                  <li key={index}>{block.text}</li>
                ))}
              </ul>
            </details>
            <p style={{ fontSize: 11, margin: '8px 0 4px' }}>
              The draft is locked. A new version requires the reviewer-approved resubmission transition (FR-057 state machine).
            </p>
            <button type="button" className="button" onClick={simulateReviewerApproval}>
              Reviewer approves resubmission (demo transition)
            </button>
          </div>
        ) : confirming ? (
          <div role="dialog" aria-label="Confirm submission" style={{ border: '2px solid #3a5a3a', padding: '10px 12px', margin: '0 0 12px' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Confirm submission</h3>
            <p style={{ fontSize: 12, margin: '0 0 6px' }}>
              This freezes the draft as version {(submission?.version ?? 0) + 1} under your name ({actorId}) with the content hash below. Retrying the submission returns the SAME record; corrections afterwards need the reviewer-approved resubmission path.
              {validation.summary.warningCount > 0 ? ` ${validation.summary.warningCount} warning(s) will be recorded with the submission.` : ''}
            </p>
            <button type="button" className="button" onClick={doSubmit}>
              Confirm submission
            </button>{' '}
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ margin: '0 0 12px' }}>
            <button
              type="button"
              className="button"
              onClick={() => setConfirming(true)}
              disabled={validation.summary.errorCount > 0 || !canOpenNewVersion(submission?.status ?? null)}
            >
              Submit annual report
            </button>
            <p role="status" aria-live="polite" style={{ fontSize: 11, margin: '4px 0 0' }}>
              {validation.summary.errorCount > 0
                ? 'Submission disabled until every validation error is resolved.'
                : !canOpenNewVersion(submission?.status ?? null)
                  ? 'Submission locked: the current version is submitted; a reviewer must approve a resubmission first.'
                  : 'Ready to submit: no blocking errors.'}
            </p>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* FR-054 boundary proposals */}
        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 12px', padding: '8px 10px' }}>
          <legend>Boundary proposal (FR-054)</legend>
          <h3 style={{ fontSize: 13, margin: '4px 0 6px' }}>Approved boundary (version {boundaryVersion})</h3>
          <dl style={{ fontSize: 11, margin: '0 0 10px' }}>
            {boundary.map((section) => (
              <div key={section.sectionId}>
                <dt>
                  <strong>{section.title}</strong> ({section.sectionId})
                </dt>
                <dd style={{ margin: '0 0 6px' }}>{section.summary}</dd>
              </div>
            ))}
          </dl>
          {!proposal ? (
            <div>
              <div style={FIELD_STYLE}>
                <label htmlFor="bp-section" style={LABEL_STYLE}>
                  Section to change
                </label>
                <select id="bp-section" value={proposalSection} onChange={(event) => setProposalSection(event.target.value)}>
                  {boundary.map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </div>
              <div style={FIELD_STYLE}>
                <label htmlFor="bp-summary" style={LABEL_STYLE}>
                  Proposed summary (with reason)
                </label>
                <input id="bp-summary" value={proposalSummary} onChange={(event) => setProposalSummary(event.target.value)} style={{ width: '60%' }} />
              </div>
              <div style={FIELD_STYLE}>
                <label htmlFor="bp-reason" style={LABEL_STYLE}>
                  Change reason
                </label>
                <input id="bp-reason" value={proposalReason} onChange={(event) => setProposalReason(event.target.value)} style={{ width: '60%' }} />
              </div>
              <button type="button" className="button" onClick={createProposal}>
                Propose boundary change
              </button>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 12, margin: '0 0 6px' }}>
                Proposal <code>{proposal.proposalId}</code> — status: <strong>{proposal.status}</strong>
                {proposal.decidedBy ? ` (decided by ${proposal.decidedBy} at ${proposal.decidedAt})` : ''}. A proposal never replaces the approved boundary before the approval transition.
              </p>
              <ul style={{ fontSize: 11, margin: '0 0 8px 16px' }}>
                {proposal.sections.map((section) => (
                  <li key={section.sectionId}>
                    <strong>{section.title}</strong>: “{section.currentSummary}” → “{section.proposedSummary}” (reason: {section.changeReason})
                  </li>
                ))}
              </ul>
              <div style={FIELD_STYLE}>
                <label htmlFor="bp-comment-section" style={LABEL_STYLE}>
                  Comment on section
                </label>
                <select id="bp-comment-section" value={commentSection} onChange={(event) => setCommentSection(event.target.value)}>
                  {proposal.sections.map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>{' '}
                <label htmlFor="bp-comment" style={{ ...LABEL_STYLE, display: 'inline' }}>
                  comment
                </label>{' '}
                <input id="bp-comment" value={commentText} onChange={(event) => setCommentText(event.target.value)} style={{ width: '50%' }} />{' '}
                <button type="button" className="button" onClick={addComment}>
                  Add comment
                </button>
              </div>
              {proposal.comments.length > 0 ? (
                <ul style={{ fontSize: 11, margin: '0 0 8px 16px' }}>
                  {proposal.comments.map((comment) => (
                    <li key={comment.commentId}>
                      [{comment.authorRole}] {comment.text} <span className="muted">({comment.sectionId}, {comment.at})</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {proposal.status === 'proposed' ? (
                <button type="button" className="button" onClick={() => setProposal({ ...proposal, status: 'review' })}>
                  Submit for review
                </button>
              ) : null}
              {proposal.status === 'review' ? (
                <>
                  <button type="button" className="button" onClick={approveProposal}>
                    Approve (distinct reviewer transition — demo)
                  </button>
                  <p className="muted" style={{ fontSize: 10, margin: '4px 0 0' }}>
                    Server-side this transition is denied to the supplier account (REVIEWER_REQUIRED) and allowed only to the Water Use reviewer role; the demo performs it locally for demonstration.
                  </p>
                </>
              ) : null}
            </div>
          )}
          <p role="status" aria-live="polite" style={{ fontSize: 11, margin: '6px 0 0' }}>
            {boundaryMessage}
          </p>
        </fieldset>

        <p className="muted" style={{ fontSize: 10, margin: '8px 0 0' }}>
          Demo surface: validation, import mapping, the submission freeze and the boundary model are the deterministic local mirrors of services/api/src/workflows/supplier-report (golden-pinned). The demo content hash is an FNV-style digest, not the server's sha256; the HTTP service re-evaluates the entitlement engine server-side when wired.
        </p>
      </div>
    </div>
  );
}
