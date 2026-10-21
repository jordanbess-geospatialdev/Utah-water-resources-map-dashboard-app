/**
 * Trend output visibility (WD-013-R2; FR-043 + the FR-010/FR-036 line):
 * recurring quality-incident trends NEVER become a visibility oracle for
 * restricted or internal sites.
 *
 * - The PUBLIC projection keeps public sites only, and among known issues
 *   only issues whose own visibility is public (an internal issue recorded
 *   on a public stream stays internal - the FR-038 rule). The byte-sweep
 *   suite serializes the projection and asserts the restricted owner site,
 *   the internal diagnostic site and their values are absent.
 * - The PROTECTED projection admits each stream through the SAME entitlement
 *   engine every other read uses (`admitStream` from WD-013: public ->
 *   browse-published, restricted -> view-restricted-details, internal ->
 *   view-internal-diagnostics), and additionally requires the internal read
 *   path for internal known issues. Anonymous callers therefore receive the
 *   public sites only; an assigned Bear engineer sees their whole Bear scope
 *   (restricted owner stream and internal voltage stream included); an
 *   out-of-scope engineer receives none of them.
 * - Aggregates (site x period counts, recurrence metrics) are RECOMPUTED
 *   from the surviving incidents, so every projected count still reconciles
 *   exactly to the records the viewer is allowed to see - filtering never
 *   fabricates partial incidents.
 *
 * Purity: no I/O; the policy world, evaluator and clock are injected.
 */
import { admitStream, type PolicyDeps } from '../workflows/qc/subscriptions.ts';
import { gateAct } from '../workflows/stewardship/gate.ts';
import {
  kindRecurrenceOfIncidents,
  sitePeriodTrendsOfIncidents,
  type TrendIncident,
  type TrendReport,
} from './trends.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Rebuild every aggregate from the surviving incident list. */
function recomputeReport(incidents: readonly TrendIncident[], report: TrendReport): TrendReport {
  return {
    incidents,
    sitePeriods: sitePeriodTrendsOfIncidents(incidents, report.options),
    kindRecurrence: kindRecurrenceOfIncidents(incidents, report.options),
    options: report.options,
  };
}

/**
 * May the caller see an INTERNAL known issue on this stream? The narrow
 * internal read path (view-internal-diagnostics / statewide administration),
 * mirroring the WD-013 known-issue visibility verdict.
 */
function maySeeInternalIssue(deps: PolicyDeps, principalId: string | null, streamId: string): boolean {
  const object = deps.world.objects[streamId];
  if (!object || object.kind !== 'datastream') return false;
  return gateAct(
    { world: deps.world, clock: deps.clock, policy: deps.policy },
    principalId,
    'view-internal-diagnostics',
    { kind: 'datastream', id: streamId },
  ).ok;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The PUBLIC trend output: public sites only, public known issues only.
 * Pure - no policy dependencies at all - so it can be serialized anywhere
 * (byte-swept by test/visibility.test.ts).
 */
export function publicTrendReport(report: TrendReport): TrendReport {
  const incidents = report.incidents.filter(
    (incident) =>
      incident.visibility === 'public' &&
      !(incident.kind === 'known-issue' && incident.recordVisibility === 'internal'),
  );
  return recomputeReport(incidents, report);
}

/**
 * The trend output for one acting persona: every incident stream admitted by
 * the entitlement engine, plus internal known issues only for callers who
 * hold the internal read path on that stream. Anonymous callers degrade to
 * exactly the public projection.
 */
export function trendReportFor(deps: PolicyDeps, principalId: string | null, report: TrendReport): TrendReport {
  const incidents = report.incidents.filter((incident) => {
    const admission = admitStream(deps, principalId, incident.streamId);
    if (!admission.ok) return false;
    if (incident.kind === 'known-issue' && incident.recordVisibility === 'internal') {
      return maySeeInternalIssue(deps, principalId, incident.streamId);
    }
    return true;
  });
  return recomputeReport(incidents, report);
}
