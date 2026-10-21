/**
 * Pure view models for the WD-023-R2 extensions feature (FR-044 as-of,
 * FR-047 voice drafts).
 *
 * Dependency-free and deterministic (no React, no fixtures, no clock, no
 * network): the panels render what these models decide, they decide
 * nothing themselves. `assembleTView` mirrors the server's recorded-time
 * as-of semantics (closed lower bound ON T; later revisions excluded and
 * counted; gaps where the observation was not yet received) over the
 * DEMO_* constants, which mirror the reviewed fixture outcomes in
 * services/integrations/r2/asof — an API-backed loader replaces the demo
 * data without touching these models or the panels.
 */

// ---------------------------------------------------------------------------
// As-of view models (FR-044)
// ---------------------------------------------------------------------------

export interface AsOfBasisView {
  readonly asOf: string;
  readonly latestConsideredRevisionId: string | null;
  readonly excludedLaterCount: number;
}

export type AsOfSeriesPointView =
  | {
      readonly state: 'known';
      readonly observedAt: string;
      readonly value: number | null;
      readonly unitId: string;
      readonly processingLevel: string;
      readonly qualifierIds: readonly string[];
      readonly revisionId: string | null;
      readonly basis: AsOfBasisView;
    }
  | { readonly state: 'gap'; readonly observedAt: string; readonly reason: 'observation-not-yet-received' };

export interface AsOfSeriesView {
  readonly outcome: 'ok';
  readonly streamId: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly AsOfSeriesPointView[];
  readonly knownCount: number;
  readonly gapCount: number;
  readonly basis: AsOfBasisView;
}

export interface AsOfDeniedView {
  readonly outcome: 'denied';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: string;
  readonly message: string;
}

export type AsOfDecisionView = AsOfSeriesView | AsOfDeniedView;

/** The FR-044 basis label (same format the server exports embed). */
export function asOfBasisLabel(basis: AsOfBasisView): string {
  return `as-of:${basis.asOf} | basis:${basis.latestConsideredRevisionId ?? 'raw-original'}`;
}

/** Live transparency note for the count of excluded later revisions. */
export function excludedLaterNote(basis: AsOfBasisView): string {
  return `${String(basis.excludedLaterCount)} later revision${basis.excludedLaterCount === 1 ? '' : 's'} excluded`;
}

export function formatInstantUtc(instant: string): string {
  return instant.replace('T', ' ').replace('.000', '').replace('Z', ' UTC');
}

/** One raw observation fact for the demo T-view assembly. */
export interface DemoObservation {
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly value: number | null;
  readonly unitId: string;
}

/** One revision fact: recorded-time semantics, applied to one observedAt. */
export interface DemoRevision {
  readonly id: string;
  readonly targetsObservedAt: string;
  readonly recordedAt: string;
  readonly value: number | null;
  readonly processingLevel: string;
  readonly qualifierIds: readonly string[];
}

function normalizeInstant(instant: string): string | null {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Demo mirror of the server's as-of reconstruction: for every observation in
 * [from, to), a gap when receivedAt > T, otherwise the latest revision with
 * recordedAt <= T (closed lower bound ON T) or the raw original. The
 * aggregate basis reports the latest considered revision and the total count
 * of excluded later revisions.
 */
export function assembleTView(
  observations: readonly DemoObservation[],
  revisions: readonly DemoRevision[],
  window: { streamId: string; from: string; to: string; asOf: string },
): AsOfDecisionView {
  const asOf = normalizeInstant(window.asOf);
  const from = normalizeInstant(window.from);
  const to = normalizeInstant(window.to);
  if (asOf === null || from === null || to === null) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: 'unparseable instant in the as-of query' };
  }
  if (Date.parse(from) >= Date.parse(to)) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: 'range must satisfy from < to' };
  }
  const asOfMs = Date.parse(asOf);
  const inWindow = observations
    .filter((observation) => Date.parse(observation.observedAt) >= Date.parse(from) && Date.parse(observation.observedAt) < Date.parse(to))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  const points: AsOfSeriesPointView[] = inWindow.map((observation) => {
    if (Date.parse(observation.receivedAt) > asOfMs) {
      return { state: 'gap', observedAt: observation.observedAt, reason: 'observation-not-yet-received' };
    }
    const considered = revisions
      .filter((revision) => revision.targetsObservedAt === observation.observedAt && Date.parse(revision.recordedAt) <= asOfMs)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id));
    const head = considered.at(-1);
    const excludedLaterCount = revisions.filter((revision) => revision.targetsObservedAt === observation.observedAt && Date.parse(revision.recordedAt) > asOfMs).length;
    return {
      state: 'known',
      observedAt: observation.observedAt,
      value: head ? head.value : observation.value,
      unitId: observation.unitId,
      processingLevel: head ? head.processingLevel : 'raw',
      qualifierIds: head ? head.qualifierIds : [],
      revisionId: head ? head.id : null,
      basis: { asOf, latestConsideredRevisionId: head ? head.id : null, excludedLaterCount },
    };
  });

  const known = points.filter((point): point is Extract<AsOfSeriesPointView, { state: 'known' }> => point.state === 'known');
  const latestConsidered = known
    .map((point) => point.basis.latestConsideredRevisionId)
    .filter((id): id is string => id !== null)
    .sort()
    .at(-1) ?? null;

  return {
    outcome: 'ok',
    streamId: window.streamId,
    from,
    to,
    points,
    knownCount: known.length,
    gapCount: points.length - known.length,
    basis: { asOf, latestConsideredRevisionId: latestConsidered, excludedLaterCount: known.reduce((sum, point) => sum + point.basis.excludedLaterCount, 0) },
  };
}

export interface AsOfRowModel {
  readonly key: string;
  readonly observedAt: string;
  /** Shape + text marker, never color alone (fixture-app a11y convention). */
  readonly marker: string;
  readonly stateText: string;
  readonly valueText: string;
  readonly levelText: string;
  readonly qualifierText: string;
  readonly revisionText: string;
  readonly isGap: boolean;
}

/** Table rows for the T-view series: one row per point, gaps marked. */
export function asOfRows(series: AsOfSeriesView): readonly AsOfRowModel[] {
  return series.points.map((point) => {
    if (point.state === 'gap') {
      return {
        key: point.observedAt,
        observedAt: formatInstantUtc(point.observedAt),
        marker: '○',
        stateText: 'gap',
        valueText: '—',
        levelText: '—',
        qualifierText: '—',
        revisionText: '—',
        isGap: true,
      };
    }
    return {
      key: point.observedAt,
      observedAt: formatInstantUtc(point.observedAt),
      marker: '●',
      stateText: 'known',
      valueText: point.value === null ? '—' : `${String(point.value)} ${point.unitId}`,
      levelText: point.processingLevel,
      qualifierText: point.qualifierIds.length === 0 ? '—' : point.qualifierIds.join(', '),
      revisionText: point.revisionId ?? 'raw original',
      isGap: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Voice draft view models (FR-047)
// ---------------------------------------------------------------------------

export type VoiceDraftState = 'requested' | 'reviewed' | 'saved';

export interface VoiceDraftView {
  readonly state: VoiceDraftState;
  readonly text: string;
  readonly providerPending: boolean;
  readonly providerLabel: string;
  readonly correlationId: string;
  readonly reviewedBy: string | null;
  readonly savedAt: string | null;
  readonly retentionClass: string;
  readonly visibility: 'internal' | 'public';
}

export interface VoiceBadgeModel {
  readonly marker: string;
  readonly text: string;
}

/** Draft lifecycle badge: text + shape, never color alone. */
export function voiceStateBadge(state: VoiceDraftState): VoiceBadgeModel {
  switch (state) {
    case 'requested':
      return { marker: '○', text: 'requested' };
    case 'reviewed':
      return { marker: '◐', text: 'reviewed' };
    case 'saved':
      return { marker: '●', text: 'saved' };
  }
}

/** The provider-pending label for stub drafts (no provider approved yet). */
export function providerPendingLabel(draft: Pick<VoiceDraftView, 'providerPending' | 'providerLabel'>): string {
  return draft.providerPending ? `provider pending · ${draft.providerLabel}` : draft.providerLabel;
}

export interface VoiceReviewStatus {
  readonly draftAttached: boolean;
  readonly reviewedConfirmed: boolean;
  readonly reviewerRecorded: boolean;
}

/**
 * The review-wall blockers, in order: SAVE stays disabled (and no attachment
 * path exists) until this list is empty. Mirrors the server's
 * ReviewRequiredError conditions.
 */
export function voiceReviewBlockers(status: VoiceReviewStatus): readonly string[] {
  const blockers: string[] = [];
  if (!status.draftAttached) blockers.push('No transcript draft attached yet');
  if (!status.reviewedConfirmed) blockers.push('You must review the transcript before saving');
  if (!status.reviewerRecorded) blockers.push('The reviewing actor must be recorded');
  return blockers;
}

// ---------------------------------------------------------------------------
// Demo constants (mirror the reviewed fixture outcomes; see file header)
// ---------------------------------------------------------------------------

export interface DemoStream {
  readonly id: string;
  readonly label: string;
  readonly visibility: 'public' | 'restricted';
  readonly systemId: string;
  readonly window: { readonly from: string; readonly to: string };
}

export interface DemoPersona {
  readonly id: string;
  readonly label: string;
  readonly systemId: string;
}

export const DEMO_STREAMS: readonly DemoStream[] = [
  { id: 'str-corinne-q', label: 'Corinne discharge (public)', visibility: 'public', systemId: 'sys-bear-river', window: { from: '2026-03-08T00:00:00Z', to: '2026-03-09T00:00:00Z' } },
  { id: 'str-hyrum-q-owner', label: 'Hyrum owner diversion (restricted)', visibility: 'restricted', systemId: 'sys-bear-river', window: { from: '2026-03-04T00:00:00Z', to: '2026-03-09T00:00:00Z' } },
];

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  { id: 'principal-fatima-engineer', label: 'Fatima (Bear River engineer)', systemId: 'sys-bear-river' },
  { id: 'principal-priya-engineer', label: 'Priya (Weber River engineer)', systemId: 'sys-weber-river' },
];

/** Raw observation facts of str-corinne-q on 2026-03-08 (fixtures/contracts/observations.json, obs-q-030..047). */
export const DEMO_CORINNE_OBSERVATIONS: readonly DemoObservation[] = [
  { observedAt: '2026-03-08T00:00:00Z', receivedAt: '2026-03-08T00:00:47Z', value: 20.6, unitId: 'cfs' },
  { observedAt: '2026-03-08T01:00:00Z', receivedAt: '2026-03-08T01:00:50Z', value: 20.8, unitId: 'cfs' },
  { observedAt: '2026-03-08T02:00:00Z', receivedAt: '2026-03-08T02:00:48Z', value: -1.2, unitId: 'cfs' },
  { observedAt: '2026-03-08T03:00:00Z', receivedAt: '2026-03-08T03:00:51Z', value: 21, unitId: 'cfs' },
  { observedAt: '2026-03-08T04:00:00Z', receivedAt: '2026-03-08T04:00:49Z', value: 21.2, unitId: 'cfs' },
  { observedAt: '2026-03-08T05:00:00Z', receivedAt: '2026-03-08T05:00:52Z', value: 21.1, unitId: 'cfs' },
  { observedAt: '2026-03-08T06:00:00Z', receivedAt: '2026-03-08T06:00:48Z', value: 21.4, unitId: 'cfs' },
  { observedAt: '2026-03-08T07:00:00Z', receivedAt: '2026-03-08T07:00:50Z', value: 21.3, unitId: 'cfs' },
  { observedAt: '2026-03-08T08:00:00Z', receivedAt: '2026-03-08T08:00:49Z', value: 21.6, unitId: 'cfs' },
  { observedAt: '2026-03-08T09:00:00Z', receivedAt: '2026-03-08T09:00:51Z', value: 21.8, unitId: 'cfs' },
  { observedAt: '2026-03-08T10:00:00Z', receivedAt: '2026-03-08T10:00:50Z', value: 22, unitId: 'cfs' },
  { observedAt: '2026-03-08T11:00:00Z', receivedAt: '2026-03-08T11:00:48Z', value: 22.1, unitId: 'cfs' },
  { observedAt: '2026-03-08T18:00:00Z', receivedAt: '2026-03-08T18:00:53Z', value: 23.5, unitId: 'cfs' },
  { observedAt: '2026-03-08T19:00:00Z', receivedAt: '2026-03-08T19:00:49Z', value: 23.8, unitId: 'cfs' },
  { observedAt: '2026-03-08T20:00:00Z', receivedAt: '2026-03-08T20:00:52Z', value: 9500, unitId: 'cfs' },
  { observedAt: '2026-03-08T21:00:00Z', receivedAt: '2026-03-08T21:00:50Z', value: 24.2, unitId: 'cfs' },
  { observedAt: '2026-03-08T22:00:00Z', receivedAt: '2026-03-08T22:00:48Z', value: 24.5, unitId: 'cfs' },
  { observedAt: '2026-03-08T23:00:00Z', receivedAt: '2026-03-08T23:00:51Z', value: 24.7, unitId: 'cfs' },
];

/** Restricted owner-diversion facts (obs-ho-001/002): reconstructs only in scope. */
export const DEMO_HYRUM_OBSERVATIONS: readonly DemoObservation[] = [
  { observedAt: '2026-03-04T16:00:00Z', receivedAt: '2026-03-04T16:04:00Z', value: 9.8, unitId: 'cfs' },
  { observedAt: '2026-03-08T17:00:00Z', receivedAt: '2026-03-08T17:05:00Z', value: 10.4, unitId: 'cfs' },
];

/** Revision facts of the Corinne chain (rev-corinne-2001/2004, recorded-time). */
export const DEMO_CORINNE_REVISIONS: readonly DemoRevision[] = [
  {
    id: 'rev-corinne-2001',
    targetsObservedAt: '2026-03-08T02:00:00Z',
    recordedAt: '2026-03-08T15:30:00Z',
    value: 20.9,
    processingLevel: 'provisional',
    qualifierIds: ['ice-affected'],
  },
  {
    id: 'rev-corinne-2004',
    targetsObservedAt: '2026-03-08T02:00:00Z',
    recordedAt: '2026-03-09T06:20:00Z',
    value: 20.9,
    processingLevel: 'best-available',
    qualifierIds: ['ice-affected'],
  },
];

/** The reviewable stub draft the demo voice flow starts from (FR-047 stub). */
export const DEMO_VOICE_DRAFT: VoiceDraftView = {
  state: 'requested',
  text: '',
  providerPending: true,
  providerLabel: 'deterministic stub',
  correlationId: 'stub-voice-note-1001',
  reviewedBy: null,
  savedAt: null,
  retentionClass: 'extended',
  visibility: 'internal',
};

/**
 * Demo authorization mirror (the server is authoritative): public streams
 * reconstruct for anyone; restricted streams reconstruct only for a persona
 * whose system covers the stream, and stay HIDDEN (404) otherwise.
 */
export function demoAsOfAuthorize(stream: DemoStream, persona: DemoPersona): AsOfDeniedView | null {
  if (stream.visibility === 'public') return null;
  if (persona.systemId === stream.systemId) return null;
  return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'object not found (restricted stream stays hidden cross-scope)' };
}

/** Demo loader: assemble the T-view for the picked stream/persona/instant. */
export function demoAsOfLoad(streamId: string, personaId: string, asOf: string): AsOfDecisionView {
  const stream = DEMO_STREAMS.find((candidate) => candidate.id === streamId);
  const persona = DEMO_PERSONAS.find((candidate) => candidate.id === personaId);
  if (!stream || !persona) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: 'unknown stream or persona' };
  }
  const denial = demoAsOfAuthorize(stream, persona);
  if (denial) return denial;
  const observations = stream.id === 'str-corinne-q' ? DEMO_CORINNE_OBSERVATIONS : DEMO_HYRUM_OBSERVATIONS;
  const revisions = stream.id === 'str-corinne-q' ? DEMO_CORINNE_REVISIONS : [];
  return assembleTView(observations, revisions, { streamId: stream.id, from: stream.window.from, to: stream.window.to, asOf });
}
