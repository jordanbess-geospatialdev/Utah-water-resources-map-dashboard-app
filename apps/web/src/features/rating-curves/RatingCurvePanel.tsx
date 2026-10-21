/**
 * RatingCurvePanel - the FR-045 versioned rating-curve UI (WD-011-R2).
 *
 * "Effective-dated curve and shift versions retain author, approval state
 * and provenance; computed values identify the version used, and a revised
 * curve does not erase earlier conversions or inspection evidence."
 *
 * The panel renders:
 * - the full version timeline (curves and shifts): every version with its
 *   half-open effective period, approval state, author, approver and
 *   provenance. History never collapses - superseded versions stay listed
 *   with their original coefficients and periods;
 * - a conversion tester: enter a stage and an instant; the result shows
 *   the discharge, the substituted formula and the FULL lineage (curve
 *   version id + shift version id) of the versions resolved at that
 *   instant.
 *
 * Accessibility contract (mirrors the WD-011 quality-history panel):
 * - a real <table> with caption, column headers (scope="col") and row
 *   headers (scope="row", the version id);
 * - approval state is ALWAYS text + shape (● approved, ○ draft,
 *   ✕ superseded), never color alone;
 * - the conversion result is an aria-live region; inputs have explicit
 *   <label htmlFor> associations; rejected conversions set aria-invalid.
 *
 * Read-only by construction: every mutation path lives in the API workflow
 * (services/api/src/workflows/rating-curves). The default data derives
 * from the frozen contract fixtures (ratingCurvePeriods of the stream plus
 * the documented working coefficients, pending owner approval); an
 * API-backed loader can replace it through props without touching this
 * component - see README.md for the pending wiring.
 */
import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { FIXTURE_SEED, stations, userById } from '../../shell/data/fixtures';
import {
  buildTimeline,
  convertStage,
  formatInterval,
  stateBadge,
  type ConversionResult,
  type CurveVersionView,
  type ShiftVersionView,
} from './curveModel';

/**
 * View-side mirror of the API seed coefficients (the fixture publishes
 * period ids/dates/method labels only). PENDING OWNER APPROVAL per the R2
 * convention; the API goldens pin the numbers.
 */
const SEED_COEFFICIENTS: Readonly<Record<string, { c: number; b: number; e: number; note: string }>> = {
  'rc-corinne-2019': { c: 38.0, b: 1.85, e: 1.7, note: 'Working log-linear fit for the 2019 device era; coefficients pending data-owner approval.' },
  'rc-corinne-2026': { c: 41.2, b: 1.92, e: 1.68, note: 'Working log-linear fit with high-flow extension for the RTU replacement era; coefficients pending data-owner approval.' },
};

const SEED_CURATOR = 'principal-diego-steward';

export interface RatingCurveData {
  readonly streamLabel: string;
  readonly curves: readonly CurveVersionView[];
  readonly shifts: readonly ShiftVersionView[];
  readonly actorNames?: Readonly<Record<string, string>>;
}

export interface RatingCurvePanelProps {
  /** Discharge stream to present; defaults to the Corinne telemetry stream. */
  readonly streamId?: string;
  /** Data source; defaults to the frozen contract fixtures for the stream. */
  readonly data?: RatingCurveData;
  /** Data status; the panel itself is synchronous and defaults to ready. */
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly defaultStageFt?: number;
  readonly defaultAt?: string;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

/** Fixture-backed default data (read-only shell reuse, WD-006 loaders). */
function fixtureDataFor(streamId: string): RatingCurveData {
  const stream = stations.flatMap((station) => station.datastreams).find((candidate) => candidate.id === streamId);
  const station = stream ? stations.find((candidate) => candidate.id === stream.stationId) : undefined;
  const curves: CurveVersionView[] = (stream?.ratingCurvePeriods ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))
    .map((period, index) => {
      const seed = SEED_COEFFICIENTS[period.id];
      return {
        id: period.id,
        version: index + 1,
        method: period.method,
        coefficients: { c: seed?.c ?? 0, b: seed?.b ?? 0, e: seed?.e ?? 0 },
        unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
        effectiveFrom: period.validFrom,
        effectiveTo: period.validTo,
        author: SEED_CURATOR,
        approvalState: period.validTo === null ? 'approved' : 'superseded',
        approvedBy: SEED_CURATOR,
        approvedAt: period.validFrom,
        provenanceNote: seed?.note ?? 'Fixture rating-curve period.',
      };
    });
  const actorNames: Record<string, string> = {};
  for (const user of userById.values()) actorNames[user.id] = user.displayName;
  return {
    streamLabel: station ? `${station.displayName} — ${stream?.id}` : streamId,
    curves,
    shifts: [],
    actorNames,
  };
}

function StateCell({ marker, text }: { readonly marker: string; readonly text: string }) {
  return (
    <td tabIndex={-1}>
      <span aria-hidden style={{ marginRight: 5, fontWeight: 700 }}>
        {marker}
      </span>
      {text}
    </td>
  );
}

function VersionTable({ rows, describedBy }: { readonly rows: ReturnType<typeof buildTimeline>; readonly describedBy: string }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="site-table" aria-describedby={describedBy}>
        <caption className="sr-only">
          Rating-curve and shift version history. Effective periods are half-open [from, to). Superseded versions remain
          listed with their original coefficients, author and approval provenance.
        </caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">State</th>
            <th scope="col">Effective period</th>
            <th scope="col">Method / reason</th>
            <th scope="col">Author</th>
            <th scope="col">Approved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.kind}:${row.id}`}>
              <th scope="row" tabIndex={0} title={`Version ${row.version} (${row.id})`}>
                {row.kind === 'curve' ? 'Curve' : 'Shift'} v{row.version}
                <small style={SMALL_MUTED}>{row.id}</small>
              </th>
              <StateCell marker={row.stateMarker} text={row.stateText} />
              <td tabIndex={-1}>{row.periodLabel}</td>
              <td tabIndex={-1} style={{ maxWidth: 320, whiteSpace: 'normal' }}>
                {row.title}
                <small style={SMALL_MUTED}>{row.detail}</small>
              </td>
              <td tabIndex={-1}>{row.author}</td>
              <td tabIndex={-1}>
                {row.approvalLabel}
                {row.superseded && <small style={SMALL_MUTED}>approval evidence retained</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConversionResultView({ result, streamLabel }: { readonly result: ConversionResult; readonly streamLabel: string }) {
  if (result.kind === 'rejected') {
    return (
      <p style={{ margin: '8px 0 0', fontSize: 10 }} role="alert">
        Cannot convert on {streamLabel}: {result.message} ({result.code})
      </p>
    );
  }
  return (
    <div style={{ margin: '8px 0 0', fontSize: 10 }}>
      <p style={{ margin: 0, fontWeight: 700 }}>
        {result.value.toFixed(3)} {result.unitId}
      </p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px', margin: '6px 0 0' }}>
        <dt style={{ color: '#8c9a8f' }}>Stage:</dt>
        <dd style={{ margin: 0 }}>
          {result.stageFt.toFixed(2)} ft{result.shiftVersionId !== null ? ` (effective ${result.effectiveStageFt.toFixed(2)} ft after shift)` : ''}
        </dd>
        <dt style={{ color: '#8c9a8f' }}>Formula:</dt>
        <dd style={{ margin: 0 }}>{result.formula}</dd>
        <dt style={{ color: '#8c9a8f' }}>Curve period:</dt>
        <dd style={{ margin: 0 }}>{result.periodLabel}</dd>
        <dt style={{ color: '#8c9a8f' }}>Lineage:</dt>
        <dd style={{ margin: 0 }}>{result.lineage}</dd>
      </dl>
    </div>
  );
}

export default function RatingCurvePanel({
  streamId = 'str-corinne-q',
  data,
  status = 'ready',
  errorMessage,
  onRetry,
  defaultStageFt = 2.52,
  defaultAt = '2026-03-09T06:00:00Z',
}: RatingCurvePanelProps) {
  const resolvedData = useMemo(() => data ?? fixtureDataFor(streamId), [data, streamId]);
  const [stageText, setStageText] = useState(defaultStageFt.toFixed(2));
  const [atText, setAtText] = useState(defaultAt);
  const [submitted, setSubmitted] = useState<{ stage: number; at: string } | null>(null);

  const rows = useMemo(() => buildTimeline(resolvedData.curves, resolvedData.shifts), [resolvedData]);
  const result = useMemo<ConversionResult | null>(() => {
    if (submitted === null) return null;
    return convertStage(resolvedData.curves, resolvedData.shifts, submitted.stage, submitted.at);
  }, [resolvedData, submitted]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const stage = Number.parseFloat(stageText);
    setSubmitted({ stage, at: atText.trim() });
  }

  if (status === 'loading') {
    return (
      <section aria-busy="true" aria-label={`Rating curves for ${resolvedData.streamLabel}`}>
        <p style={{ fontSize: 10, margin: 0, padding: '13px 19px' }}>Loading rating curves…</p>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section aria-label={`Rating curves for ${resolvedData.streamLabel}`}>
        <div style={{ padding: '13px 19px' }}>
          <p style={{ fontSize: 10, margin: '0 0 8px' }} role="alert">
            {errorMessage ?? 'Rating curves could not be loaded.'}
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

  const stageInvalid = submitted !== null && result?.kind === 'rejected' && (result.code === 'STAGE_INVALID' || result.code === 'STAGE_BELOW_DATUM');
  const atInvalid = submitted !== null && result?.kind === 'rejected' && (result.code === 'AT_INVALID' || result.code === 'NO_CURVE' || result.code === 'NOT_APPROVED');

  return (
    <section aria-label={`Rating curves for ${resolvedData.streamLabel}`}>
      <div style={{ background: '#fafcf9', borderBottom: '1px solid #e9ede8', padding: '13px 19px' }}>
        <h2 style={{ fontSize: 11, fontWeight: 700, margin: '0 0 4px' }}>
          Rating curves and shifts — {resolvedData.streamLabel}
        </h2>
        <p id="rc-intro" style={{ fontSize: 10, margin: 0, color: '#5d6a5f' }}>
          Versioned, effective-dated curves and shifts (fixture seed {FIXTURE_SEED}). Effective periods are half-open
          [from, to); a revised curve never erases earlier conversions — every computed value names the version it used.
        </p>
      </div>

      <div style={{ padding: '13px 19px', borderBottom: '1px solid #e9ede8' }}>
        <h3 style={{ fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>Conversion tester</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="rc-stage" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Stage (ft)
              </label>
              <input
                id="rc-stage"
                type="number"
                step="0.01"
                min="0"
                value={stageText}
                onChange={(event) => setStageText(event.target.value)}
                aria-invalid={stageInvalid || undefined}
                style={{ fontSize: 10, width: 110 }}
              />
            </div>
            <div>
              <label htmlFor="rc-at" style={{ display: 'block', fontSize: 9, color: '#8c9a8f', marginBottom: 3 }}>
                Instant (UTC, ISO 8601)
              </label>
              <input
                id="rc-at"
                type="text"
                value={atText}
                onChange={(event) => setAtText(event.target.value)}
                aria-invalid={atInvalid || undefined}
                style={{ fontSize: 10, width: 210 }}
              />
            </div>
            <button type="submit" style={{ fontSize: 10 }}>
              Convert stage → discharge
            </button>
          </div>
        </form>
        <div aria-live="polite">
          {result !== null && <ConversionResultView result={result} streamLabel={resolvedData.streamLabel} />}
        </div>
      </div>

      <h3 id="rc-history-heading" style={{ fontSize: 10, fontWeight: 700, margin: '13px 19px 6px' }}>
        Version history (superseded versions retained)
      </h3>
      {rows.length > 0 ? (
        <VersionTable rows={rows} describedBy="rc-intro" />
      ) : (
        <p style={{ fontSize: 10, margin: '0 19px 13px', color: '#5d6a5f' }}>
          No rating-curve or shift versions are recorded for this stream yet.
        </p>
      )}
      {resolvedData.shifts.length === 0 && resolvedData.curves.length > 0 && (
        <p style={{ fontSize: 9, margin: '6px 19px 13px', color: '#a0aa99' }}>
          No shift versions effective in the fixture period; conversions resolve to the curve version alone.
        </p>
      )}
      <p style={{ fontSize: 9, margin: '6px 19px 13px', color: '#a0aa99' }}>
        Current open period: {resolvedData.curves.length > 0 ? formatInterval(resolvedData.curves[resolvedData.curves.length - 1]!.effectiveFrom, resolvedData.curves[resolvedData.curves.length - 1]!.effectiveTo) : '—'}
        {' '}· approval state {resolvedData.curves.length > 0 ? stateBadge(resolvedData.curves[resolvedData.curves.length - 1]!.approvalState).text : '—'}
      </p>
    </section>
  );
}
