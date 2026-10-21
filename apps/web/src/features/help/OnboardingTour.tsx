/**
 * OnboardingTour - the FR-068 role-relevant first-visit tour.
 *
 * "A user can complete a short role-relevant tour and disable its automatic
 * return."
 *
 * Behavior:
 * - ROLE-RELEVANT: one tour per persona role (six personas of the fixture
 *   world, apps/web/src/shell/data/personas.ts), 5-7 steps each, tied to the
 *   training checklists in docs/training/tasks-public.md and
 *   docs/training/tasks-operational.md.
 * - FIRST-VISIT ONLY: `shouldAutoStart` reads the persisted tour record -
 *   true on the very first visit; afterwards only while the tour was neither
 *   completed nor opted out. The shell calls it once per visit.
 * - SKIPPABLE: Skip and Escape end the tour and persist `skipped`.
 * - DISABLE-AUTO-RETURN PERSISTED: the "Don't show this tour automatically
 *   again" choice is stored per persona account (versioned schema, corrupt
 *   records reset to a clean slate). A manual restart from Help is always
 *   allowed and never clears the user's opt-out.
 * - KEYBOARD NAVIGABLE: ArrowRight/ArrowLeft move between steps (plus
 *   Back/Next buttons, all real focusable buttons in tab order); Escape
 *   skips; the dialog is role=dialog with aria-modal and a labelled heading.
 * - FOCUS MANAGEMENT: opening the tour moves focus into the dialog; closing
 *   (finish or skip) returns focus to the anchor element.
 *
 * Mountable, shell-free component: persistence defaults to localStorage with
 * an in-memory fallback; the clock is injected for deterministic rendering.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { personas, personaById } from '../../shell/data/personas';

// ---------------------------------------------------------------------------
// Tour content (fixture world; step ids match the training checklist ids)
// ---------------------------------------------------------------------------

export interface TourStep {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export type Tour = readonly TourStep[];

const TOURS: Readonly<Record<string, Tour>> = {
  public: [
    { id: 'pub-welcome', title: 'Welcome to the Utah Water Measurement Dashboard', body: 'Public stations, freshness and shareable views - no account needed. This tour takes about a minute; skip anytime and restart it from Help.' },
    { id: 'pub-map-table', title: 'Map and table are the same data', body: 'Whatever the map shows, the table lists - and vice versa. Selecting a row highlights the site on the map.' },
    { id: 'pub-filter', title: 'Filter what you see', body: 'Filter by distribution system, site type or telemetry. Multiple values within one filter combine (OR); different filters narrow (AND).' },
    { id: 'pub-indicator', title: 'Read the freshness indicators', body: 'Shapes and words - not colors alone - tell you Reporting, Stale, Inactive or No data. A missing reading is never shown as a fake zero.' },
    { id: 'pub-share', title: 'Share exactly your view', body: 'The share link carries your filters, map extent and selected site - nothing personal, and never a restricted site.' },
    { id: 'pub-feedback', title: 'Something looks wrong?', body: 'Report it from Help. You will preview the exact context that ships with your report before you send it.' },
  ],
  'water-user': [
    { id: 'usr-welcome', title: 'Welcome', body: 'Published stations for everyone, plus your organization\'s restricted delivery stations when you are signed in.' },
    { id: 'usr-find', title: 'Find your delivery site', body: 'Filter by distribution system or search the table. Your organization\'s stations appear alongside the public ones you may read.' },
    { id: 'usr-latest', title: 'Read the latest value', body: 'The site card shows the newest value with its unit, the observation time and a freshness indicator.' },
    { id: 'usr-favorite', title: 'Keep your sites close', body: 'Favorite sites from My Sites and manage notification preferences. Favorites are yours only - they never grant access.' },
    { id: 'usr-share', title: 'Share public views', body: 'Share links carry public filters, extent and the selected public site. Restricted data never enters a link.' },
    { id: 'usr-access', title: 'Access problems?', body: 'Use Help and pick "Access problem". The report reaches the data steward with a reproducible link - no secrets attached.' },
  ],
  researcher: [
    { id: 'res-welcome', title: 'Welcome', body: 'The public projection with provenance, processing levels and reproducible extracts.' },
    { id: 'res-filter', title: 'Filter to your variables', body: 'Combine observed property, processing level and measurement method filters; unknown-but-valid values stay visible so vocabulary gaps are inspectable.' },
    { id: 'res-site', title: 'Inspect a site', body: 'Open a site for the chart and table, and switch raw versus best-available values.' },
    { id: 'res-dictionary', title: 'Check the data dictionary', body: 'Every governed term and identifier is defined; values a link carries that the vocabulary does not know are listed for review.' },
    { id: 'res-export', title: 'Export, then automate', body: 'Queue a CSV export of the filtered view; for programmatic access, request a scoped API token (revocable, never exceeding your grants).' },
    { id: 'res-repro', title: 'Reproducibility', body: 'Share links reproduce filters, extent and selected site exactly - provenance for every extract.' },
  ],
  commissioner: [
    { id: 'com-welcome', title: 'Welcome, commissioner', body: 'Your assigned system (Bear River in the fixture world) with readings, review and correction - nothing outside your assignment.' },
    { id: 'com-morning', title: 'Start with the morning review', body: 'The assigned workspace lists your stations with freshness and missing readings first, so late telemetry surfaces immediately.' },
    { id: 'com-enter', title: 'Enter a reading', body: 'Units, time zone and validity are checked before commit; row-level errors never block the rest of the form.' },
    { id: 'com-bulk', title: 'Bulk paste a season', body: 'Paste a table of readings, preview the parsed batch with row errors and duplicates, then commit once - the whole batch or a precise report.' },
    { id: 'com-correct', title: 'Correct with an audit trail', body: 'Corrections append a revision with a qualifier and a reason; originals are never overwritten and the history stays visible.' },
    { id: 'com-share', title: 'Share stays public', body: 'Support and share links carry public view state only - internal notes and restricted identifiers are excluded by design.' },
    { id: 'com-feedback', title: 'Route issues to the steward', body: 'Reports from Help land in the steward queue with reproducible context and a priority.' },
  ],
  engineer: [
    { id: 'eng-welcome', title: 'Welcome, engineer', body: 'Field engineering for your assigned system: diagnostics, QA review and equipment history.' },
    { id: 'eng-diagnose', title: 'Internal diagnostics', body: 'Where your grant allows it, internal streams (for example battery voltage) and internal site blocks are visible - clearly marked as internal.' },
    { id: 'eng-qa', title: 'QA review', body: 'Compare original and revised values on a point or interval, then append a correction with qualifier and reason; every actor and time is recorded.' },
    { id: 'eng-health', title: 'Connection health', body: 'Digests distinguish a failed provider from failed tasks, and link to a filtered authorized task view.' },
    { id: 'eng-field', title: 'Field documentation', body: 'Record inspections and visits with controlled attachment visibility; internal attachments stay internal.' },
    { id: 'eng-feedback', title: 'Report defects reproducibly', body: 'Help attaches your exact public view state - never credentials or internal notes.' },
  ],
  steward: [
    { id: 'stw-welcome', title: 'Welcome, steward', body: 'Statewide administration: users, assignments, vocabulary, systems, ingestion and QC - and this dashboard\'s feedback queue.' },
    { id: 'stw-assign', title: 'Assignments and delegations', body: 'Grant and revoke scoped assignments; deputy authority exists only through explicit, time-bounded delegations.' },
    { id: 'stw-vocab', title: 'Universal vocabulary', body: 'Govern the shared terms every filter, link and export depends on; unknown values in old links stay inspectable.' },
    { id: 'stw-qc', title: 'QC and connection health', body: 'Configure versioned QC rules and monitor ingestion; isolate failures by task.' },
    { id: 'stw-queue', title: 'Feedback triage', body: 'User reports arrive with redaction-verified context links; assign P1-P4 priorities and work the queue in order.' },
    { id: 'stw-consent', title: 'Analytics is opt-in', body: 'Usage analytics require explicit per-account consent, and the retention proposal is pending the agency owner\'s decision - nothing is collected by default.' },
  ],
};

/** The tour for a persona id (unknown ids fall back to the public tour). */
export function tourForPersona(personaId: string): Tour {
  const persona = personaById(personaId);
  return TOURS[persona.role] ?? TOURS.public!;
}

// ---------------------------------------------------------------------------
// Persistence (versioned; corrupt records reset, never guessed)
// ---------------------------------------------------------------------------

export const TOUR_SCHEMA_VERSION = 1;

export type TourCompletionState = 'completed' | 'skipped';

export interface TourRecord {
  readonly version: 1;
  readonly personaId: string;
  readonly state: TourCompletionState | null;
  readonly disableAutoReturn: boolean;
  readonly updatedAt: string;
}

export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function inMemoryTourStorage(seed?: Readonly<Record<string, string>>): TourStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

export function localStorageTourAdapter(): TourStorage | null {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  if (candidate === undefined || candidate === null) return null;
  return {
    getItem: (key) => candidate.getItem(key),
    setItem: (key, value) => void candidate.setItem(key, value),
    removeItem: (key) => void candidate.removeItem(key),
  };
}

export function tourStorageKey(personaId: string): string {
  return `utah-water.tour.v${TOUR_SCHEMA_VERSION}.${personaId}`;
}

export function readTourRecord(storage: TourStorage, personaId: string): TourRecord | null {
  const raw = storage.getItem(tourStorageKey(personaId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TourRecord>;
    if (parsed.version !== TOUR_SCHEMA_VERSION || typeof parsed.personaId !== 'string') return null;
    if (typeof parsed.disableAutoReturn !== 'boolean') return null;
    const state = parsed.state === 'completed' || parsed.state === 'skipped' ? parsed.state : null;
    return { version: TOUR_SCHEMA_VERSION, personaId: parsed.personaId, state, disableAutoReturn: parsed.disableAutoReturn, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '' };
  } catch {
    return null;
  }
}

function writeTourRecord(storage: TourStorage, record: TourRecord): void {
  storage.setItem(tourStorageKey(record.personaId), JSON.stringify(record));
}

/**
 * FR-068 auto-return rule: auto-start on the FIRST visit; afterwards return
 * only for a tour that was skipped without opting out (a completed tour does
 * not nag). Checking "Don't show this tour automatically again" stops every
 * automatic return. A manual restart from Help is always allowed and is not
 * gated by this predicate.
 */
export function shouldAutoStart(storage: TourStorage, personaId: string): boolean {
  const record = readTourRecord(storage, personaId);
  if (record === null) return true; // first visit
  if (record.disableAutoReturn) return false;
  if (record.state === 'completed') return false;
  return true; // skipped without opt-out: the gentle return the user can disable
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface OnboardingTourProps {
  /** Persona id from the fixture world (donna/wiley/sarah/cody/fatima/diego). */
  readonly personaId: string;
  /** Whether the tour is showing (the shell owns mount timing via shouldAutoStart or a Help restart). */
  readonly open: boolean;
  /** Called with the completion state when the tour ends ('completed' or 'skipped'). */
  readonly onEnd: (state: TourCompletionState) => void;
  readonly storage?: TourStorage;
  readonly now?: Date | string;
  /** Element to return focus to on close; defaults to document.body. */
  readonly anchorRef?: { readonly current: HTMLElement | null };
}

const DIALOG: CSSProperties = {
  position: 'relative',
  maxWidth: 460,
  margin: '48px auto',
  padding: '18px 20px',
  background: '#ffffff',
  border: '1px solid #c9d1c4',
  borderRadius: 8,
};

export default function OnboardingTour({ personaId, open, onEnd, storage, now, anchorRef }: OnboardingTourProps) {
  const resolvedStorage = storage ?? localStorageTourAdapter() ?? inMemoryTourStorage();
  const persona = personaById(personaId);
  const tour = tourForPersona(personaId);
  const [stepIndex, setStepIndex] = useState(0);
  const [disableAutoReturn, setDisableAutoReturn] = useState(() => readTourRecord(resolvedStorage, personaId)?.disableAutoReturn ?? false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setStepIndex(0);
      setDisableAutoReturn(readTourRecord(resolvedStorage, personaId)?.disableAutoReturn ?? false);
      dialogRef.current?.focus();
    }
  }, [open, personaId, resolvedStorage]);

  const persistEnd = useCallback(
    (state: TourCompletionState) => {
      const updatedAt = now ? (typeof now === 'string' ? now : new Date(now.getTime()).toISOString()) : new Date().toISOString();
      const existing = readTourRecord(resolvedStorage, personaId);
      // The opt-out flag the user set during this run wins; a completed tour
      // also stops auto-returning (first-visit-only rule).
      writeTourRecord(resolvedStorage, {
        version: TOUR_SCHEMA_VERSION,
        personaId,
        state,
        disableAutoReturn: disableAutoReturn || state === 'completed',
        updatedAt,
      });
      onEnd(state);
      const restore = anchorRef?.current ?? previousFocusRef.current;
      restore?.focus();
    },
    [anchorRef, disableAutoReturn, now, onEnd, personaId, resolvedStorage],
  );

  const goNext = useCallback((): void => {
    if (stepIndex < tour.length - 1) setStepIndex((index) => index + 1);
    else persistEnd('completed');
  }, [persistEnd, stepIndex, tour.length]);

  const goBack = useCallback((): void => {
    setStepIndex((index) => (index > 0 ? index - 1 : 0));
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        persistEnd('skipped');
      }
    },
    [goBack, goNext, persistEnd],
  );

  if (!open) return null;

  const step = tour[stepIndex]!;
  const isLast = stepIndex === tour.length - 1;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20, 26, 18, 0.45)', zIndex: 60 }} data-testid="onboarding-tour-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        aria-describedby="onboarding-tour-body"
        tabIndex={-1}
        style={DIALOG}
        onKeyDown={onKeyDown}
      >
        <p style={{ fontSize: 10, margin: '0 0 6px', color: '#5a6553' }}>
          {persona.name} · {persona.title}
        </p>
        <h2 id="onboarding-tour-title" style={{ fontSize: 13, margin: '0 0 8px' }}>
          {step.title}
        </h2>
        <p id="onboarding-tour-body" style={{ fontSize: 11, margin: '0 0 12px', lineHeight: 1.5 }}>
          {step.body}
        </p>
        <p style={{ fontSize: 10, margin: '0 0 10px', color: '#5a6553' }} role="status">
          Step {stepIndex + 1} of {tour.length}
        </p>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, margin: '0 0 12px' }}>
          <input type="checkbox" checked={disableAutoReturn} onChange={(event) => setDisableAutoReturn(event.target.checked)} />
          Don&apos;t show this tour automatically again
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="button small" onClick={() => persistEnd('skipped')}>
            Skip tour
          </button>
          <button type="button" className="button small" onClick={goBack} disabled={stepIndex === 0}>
            Back
          </button>
          <button type="button" className="button small primary" onClick={goNext} autoFocus>
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
        <p style={{ fontSize: 9, color: '#a0aa99', margin: '10px 0 0' }}>
          Keyboard: Arrow keys move between steps, Escape skips. Full task checklists: docs/training.
        </p>
      </div>
    </div>
  );
}

/** The persona ids that carry a tour (all six fixture personas). */
export const TOUR_PERSONA_IDS: readonly string[] = personas.map((persona) => persona.id);
