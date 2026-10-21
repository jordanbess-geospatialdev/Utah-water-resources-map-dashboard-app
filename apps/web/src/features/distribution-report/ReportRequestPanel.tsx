import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { systems, users } from '../../shell/data/fixtures';
import ReportView from './ReportView';
import {
  DEFAULT_INCLUDE,
  PERIOD_BASES,
  actorReportScope,
  buildFixtureReport,
  periodWindow,
  systemSiteOptions,
  type PeriodBasis,
  type ProcessingBasis,
  type ReportLike,
} from './reportModel';

/**
 * Distribution-report request panel (WD-025; FR-024): system/site selection
 * INSIDE the acting scope, a period + basis picker with the date rules
 * visible, processing basis and include flags, and a generate action.
 *
 * Assigned-scope enforcement is visible: only systems the acting principal
 * may generate for are selectable (Weber is shown disabled with its reason),
 * and a principal with no report authority gets a typed empty state. The
 * server re-evaluates the real entitlement engine on every request; the
 * picker restrictions are presentation, not the enforcement.
 *
 * Until the HTTP service lands, generation runs the deterministic local
 * mirror (buildFixtureReport, golden-pinned to the API domain); the panel
 * states this in the UI. Loading/empty/denied states included.
 */
export interface ReportRequestPanelProps {
  /** Server-resolved acting principal (default: the fixture Bear River commissioner). */
  actorId?: string;
  /** Called with the generated report instead of rendering it inline. */
  onGenerate?: (report: ReportLike) => void;
  /** Rendered instead of the form when the caller already knows the request is denied. */
  denial?: { status: number; code: string; message: string } | null;
}

const PROCESSING_BASES: readonly { id: ProcessingBasis; label: string }[] = [
  { id: 'raw', label: 'Raw (originals)' },
  { id: 'provisional', label: 'Provisional' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'best-available', label: 'Best available' },
] as const;

const FIELD_STYLE: CSSProperties = { margin: '0 0 10px' };
const LABEL_STYLE: CSSProperties = { display: 'block', fontWeight: 600, marginBottom: 2 };

export default function ReportRequestPanel({ actorId = 'principal-cody-commissioner', onGenerate, denial = null }: ReportRequestPanelProps) {
  const scope = useMemo(() => actorReportScope(actorId), [actorId]);
  const actorName = users.find((user) => user.id === actorId)?.displayName ?? actorId;
  const reportableSystems = useMemo(
    () => systems.filter((system) => scope?.reportableSystemIds.includes(system.id)),
    [scope],
  );

  const [systemId, setSystemId] = useState(reportableSystems[0]?.id ?? '');
  const [siteIds, setSiteIds] = useState<ReadonlySet<string>>(new Set());
  const [allSites, setAllSites] = useState(true);
  const [basis, setBasis] = useState<PeriodBasis>('calendar-year');
  const [year, setYear] = useState(2026);
  const [processingBasis, setProcessingBasis] = useState<ProcessingBasis>('raw');
  const [include, setInclude] = useState<{ dailyTable: boolean; qualityNotes: boolean; gapDetail: boolean }>(DEFAULT_INCLUDE);
  const [phase, setPhase] = useState<{ kind: 'empty' } | { kind: 'generating' } | { kind: 'done'; report: ReportLike } | { kind: 'denied'; status: number; code: string; message: string }>(
    denial ? { kind: 'denied', ...denial } : { kind: 'empty' },
  );

  const sites = useMemo(() => (systemId ? systemSiteOptions(systemId) : []), [systemId]);
  const windowModel = useMemo(() => periodWindow(basis, year), [basis, year]);
  const basisOption = PERIOD_BASES.find((option) => option.id === basis)!;

  if (!scope || reportableSystems.length === 0) {
    return (
      <div className="panel" data-feature="distribution-report">
        <div className="panel-heading">
          <h2>Annual distribution report</h2>
          <span>No report authority for this account</span>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <p role="status" style={{ color: '#8a3b2c' }}>
            {scope
              ? `${scope.displayName} cannot generate distribution reports: ${scope.basis}.`
              : `Unknown or inactive account ${actorId}: report generation requires an authenticated, active principal (401).`}
          </p>
          <p className="muted" style={{ fontSize: 11 }}>
            Report generation is commissioner-scoped (FR-024): it requires the generate-reports capability on an assigned system, or a delegated deputy window that carries it.
          </p>
        </div>
      </div>
    );
  }

  const toggleSite = (stationId: string, checked: boolean): void => {
    setSiteIds((current) => {
      const next = new Set(current);
      if (checked) next.add(stationId);
      else next.delete(stationId);
      return next;
    });
  };

  const generate = (): void => {
    if (denial) {
      setPhase({ kind: 'denied', ...denial });
      return;
    }
    setPhase({ kind: 'generating' });
    setTimeout(() => {
      const report = buildFixtureReport(
        {
          systemId,
          siteIds: allSites ? null : [...siteIds].sort(),
          period: { basis, year },
          processingBasis,
          include,
        },
        actorId,
      );
      if (onGenerate) onGenerate(report);
      setPhase({ kind: 'done', report });
    }, 350);
  };

  return (
    <div className="panel" data-feature="distribution-report-request">
      <div className="panel-heading">
        <h2>Annual distribution report</h2>
        <span>Commissioner-scoped · deterministic · provenance-labeled (FR-024)</span>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <p style={{ ...FIELD_STYLE, fontSize: 11 }}>
          Acting as <strong>{actorName}</strong> ({scope.role})
          {scope.delegation ? ` — deputy delegation ${scope.delegation.effectiveAt} to ${scope.delegation.expiresAt} (by ${scope.delegation.delegatedBy})` : ''}.
          Report authority: {scope.basis}. Systems outside this assignment do not exist for you (hidden-object denial, 404).
        </p>

        <div style={FIELD_STYLE}>
          <label htmlFor="report-system" style={LABEL_STYLE}>
            Distribution system
          </label>
          <select id="report-system" value={systemId} onChange={(event) => setSystemId(event.target.value)}>
            {reportableSystems.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
          {systems
            .filter((system) => !scope.reportableSystemIds.includes(system.id))
            .map((system) => (
              <p key={system.id} className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
                {system.name}: not selectable — outside your assignment (requesting it is denied 404)
              </p>
            ))}
        </div>

        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 10px', padding: '8px 10px' }}>
          <legend>Sites (optional subset — leave “all sites” for the full system)</legend>
          <label style={{ display: 'block', marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={allSites}
              onChange={(event) => setAllSites(event.target.checked)}
            />{' '}
            All in-scope reporting sites
          </label>
          {!allSites ? (
            sites.map((site) => (
              <label key={site.stationId} style={{ display: 'block', fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={siteIds.has(site.stationId)}
                  onChange={(event) => toggleSite(site.stationId, event.target.checked)}
                />{' '}
                {site.displayName} ({site.stationId}, {site.status}
                {site.flowStreamIds.length === 0 ? ', no flow stream' : ''})
              </label>
            ))
          ) : null}
        </fieldset>

        <div style={FIELD_STYLE}>
          <label htmlFor="report-basis" style={LABEL_STYLE}>
            Period basis
          </label>
          <select
            id="report-basis"
            value={basis}
            onChange={(event) => setBasis(event.target.value as PeriodBasis)}
          >
            {PERIOD_BASES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} — {option.months}
              </option>
            ))}
          </select>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
            {basisOption.dateRule}
          </p>
        </div>

        <div style={FIELD_STYLE}>
          <label htmlFor="report-year" style={LABEL_STYLE}>
            Period year
          </label>
          <input
            id="report-year"
            type="number"
            min={1900}
            max={2100}
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          />
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
            Window {windowModel.start} to {windowModel.end} (half-open, local America/Denver) · {windowModel.dayCount} local days
          </p>
        </div>

        <div style={FIELD_STYLE}>
          <label htmlFor="report-processing" style={LABEL_STYLE}>
            Processing basis
          </label>
          <select
            id="report-processing"
            value={processingBasis}
            onChange={(event) => setProcessingBasis(event.target.value as ProcessingBasis)}
          >
            {PROCESSING_BASES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset style={{ border: '1px solid #c9d6c9', margin: '0 0 10px', padding: '8px 10px' }}>
          <legend>Include</legend>
          <label style={{ display: 'block', fontSize: 11 }}>
            <input type="checkbox" checked={include.dailyTable} onChange={(event) => setInclude({ ...include, dailyTable: event.target.checked })} /> Daily flow/volume table
          </label>
          <label style={{ display: 'block', fontSize: 11 }}>
            <input type="checkbox" checked={include.qualityNotes} onChange={(event) => setInclude({ ...include, qualityNotes: event.target.checked })} /> Quality notes
          </label>
          <label style={{ display: 'block', fontSize: 11 }}>
            <input type="checkbox" checked={include.gapDetail} onChange={(event) => setInclude({ ...include, gapDetail: event.target.checked })} /> Declared-gap detail rows
          </label>
        </fieldset>

        <p role="status" aria-live="polite" style={{ margin: '4px 0 8px' }}>
          {phase.kind === 'empty' ? 'No report generated yet.' : null}
          {phase.kind === 'generating' ? 'Generating — aggregating daily volumes from the series domain…' : null}
          {phase.kind === 'done' ? `Generated ${phase.report.reportId} (extraction ${phase.report.extractionTime}).` : null}
          {phase.kind === 'denied' ? `Denied (${phase.status} ${phase.code}): ${phase.message}` : null}
        </p>

        <button type="button" className="button" onClick={generate} disabled={phase.kind === 'generating'}>
          Generate report
        </button>
        <p className="muted" style={{ fontSize: 10, margin: '8px 0 0' }}>
          Demo generation runs the deterministic local mirror of the server domain (golden-pinned to it); the HTTP service re-evaluates the entitlement engine and re-aggregates server-side when wired.
        </p>
      </div>
      {phase.kind === 'done' ? <ReportView report={phase.report} /> : null}
    </div>
  );
}
