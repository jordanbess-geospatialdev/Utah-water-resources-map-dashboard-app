/**
 * Lexer for the WD-019 grammar (FR-003): turns an utterance into controlled
 * vocabulary matches, parsed date drafts, computed-question markers and
 * unknown-term runs. Deterministic: same utterance + same vocabulary + same
 * injected clock → same tokens, always.
 *
 * Pipeline (each stage consumes words so later stages never re-read them):
 *
 * 1. Truncate overlong input (security.ts bound) and scan for injection
 *    patterns; covered characters are dead to every later stage — they can
 *    never resurface as unknown terms, only as visible security findings.
 * 2. Date grammar (relative: "last week"; absolute-since: "since March 1";
 *    bare month/day windows; water-year phrasing is recognized but flagged
 *    unsupported-pending-owner WITHOUT computing instants — water-year
 *    semantics belong to the data owner).
 * 3. Computed-question markers ("rapidly declining flow", "current reservoir
 *    release", averages/totals) → UnsupportedRequest entries with honest
 *    limitations; the metadata fragments around them still parse.
 * 4. Longest-phrase-first matching over the vocabulary index; a phrase with
 *    several dimension candidates stays AMBIGUOUS (the parser asks).
 * 5. Remaining words: noise (grammar filler) dropped; contiguous non-noise
 *    leftovers become unknown-term runs (bounded to 8 words).
 *
 * Relative/absolute instants are computed in UTC from the INJECTED clock and
 * formatted as ISO-8601 instant strings (the stored time basis is UTC; local
 * presentation belongs to the UI).
 *
 * Pure module: no I/O; the clock arrives as a parameter.
 */
import { isCoveredBySecurity, scanUtterance, MAX_UTTERANCE_LENGTH } from './security';
import { normalizePhrase, NOISE_WORDS, maxPhraseLength, type TermCandidate, type VocabularyIndex } from './vocabulary';
import type { DateFilterDraft, SecurityFinding, UnsupportedRequest } from './types';

/** A controlled-vocabulary phrase occurrence. */
export interface TermMatch extends TermCandidate {
  readonly input: string;
  /** Index of the first matched word in the normalized word array. */
  readonly wordIndex: number;
  readonly wordCount: number;
  /** Competing candidates when the phrase maps to several dimensions (ambiguity). */
  readonly alternatives: readonly TermCandidate[];
}

export interface LexResult {
  readonly matches: readonly TermMatch[];
  readonly unknownRuns: readonly string[];
  readonly dateDrafts: readonly DateFilterDraft[];
  readonly unsupportedRequests: readonly UnsupportedRequest[];
  readonly securityFindings: readonly SecurityFinding[];
}

const DATE_LIMITATION =
  'Date filtering is declared in the contract but not governed at seed v0.1.0: the parsed range is shown for inspection only and does not change results. Whether a date selects sites with any data in the period, complete coverage, or availability since a date is a steward decision that will not be inferred from wording.';
const WATER_YEAR_LIMITATION =
  'Water-year phrasing is recognized but unsupported pending the data owner: water-year start/end semantics (and per-report definitions) are an open steward decision, so no range is computed and no values are fabricated.';
const COMPUTED_LIMITATION =
  'This asks for a computed or latest-value answer, which metadata filtering cannot produce. It routes to the separate analytics capability (Discovery scope, per S1 p.16); no values are fabricated here. The recognized metadata filters below can still be applied and inspected.';

// ---------------------------------------------------------------------------
// Date grammar
// ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const RELATIVE_UNITS: Readonly<Record<string, number>> = { day: 1, days: 1, week: 7, weeks: 7, month: 31, months: 31, year: 365, years: 365 };
const MONTH_MS = 31 * 24 * 3600 * 1000;

function iso(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word as (typeof MONTHS)[number]);
}

/** Try to lex a date expression starting at word `i`. Returns consumed words + draft, or null. */
function lexDateAt(words: readonly string[], i: number, now: Date): { count: number; draft: DateFilterDraft } | null {
  const w = words;

  // Water-year phrasing: never computed (pending owner).
  if ((w[i] === 'water' && w[i + 1] === 'year') || w[i] === 'wy') {
    let count = w[i] === 'wy' ? 1 : 2;
    if (/^\d{4}$/.test(w[i + count] ?? '')) count += 1;
    const phrase = w.slice(i, i + count).join(' ');
    return { count, draft: { input: phrase, kind: 'water-year', start: null, end: null, status: 'unsupported-pending-owner', limitation: WATER_YEAR_LIMITATION } };
  }

  // "last/past N days|weeks|months|years" and "last/past week|month|year"
  if ((w[i] === 'last' || w[i] === 'past') && w[i + 1]) {
    const next = w[i + 1]!;
    let spanDays: number | null = null;
    let count = 2;
    if (/^\d+$/.test(next) && RELATIVE_UNITS[w[i + 2] ?? ''] !== undefined) {
      spanDays = Number(next) * RELATIVE_UNITS[w[i + 2]!]!;
      count = 3;
    } else if (RELATIVE_UNITS[next] !== undefined) {
      spanDays = RELATIVE_UNITS[next]!;
    }
    if (spanDays !== null) {
      const end = now.getTime();
      const start = end - spanDays * 24 * 3600 * 1000;
      const phrase = w.slice(i, i + count).join(' ');
      return {
        count,
        draft: { input: phrase, kind: 'relative', start: iso(new Date(start)), end: iso(new Date(end)), status: 'pending-governance', limitation: DATE_LIMITATION },
      };
    }
  }

  // "this week|month|year", "today", "yesterday"
  if (w[i] === 'this' && ['week', 'month', 'year'].includes(w[i + 1] ?? '')) {
    const unit = w[i + 1]!;
    const span = unit === 'week' ? 7 : unit === 'month' ? 31 : 365;
    const end = now.getTime();
    const phrase = `this ${unit}`;
    return {
      count: 2,
      draft: { input: phrase, kind: 'relative', start: iso(new Date(end - span * 24 * 3600 * 1000)), end: iso(new Date(end)), status: 'pending-governance', limitation: DATE_LIMITATION },
    };
  }
  if (w[i] === 'today') {
    return { count: 1, draft: { input: 'today', kind: 'relative', start: iso(now), end: iso(now), status: 'pending-governance', limitation: DATE_LIMITATION } };
  }
  if (w[i] === 'yesterday') {
    const t = now.getTime() - 24 * 3600 * 1000;
    const stamp = iso(new Date(t));
    return { count: 1, draft: { input: 'yesterday', kind: 'relative', start: stamp, end: stamp, status: 'pending-governance', limitation: DATE_LIMITATION } };
  }

  // "since <month> <day>(, <year>)?" / "since <year>" — availability-since drafts.
  const sinceLike = w[i] === 'since' || w[i] === 'after';
  if (sinceLike) {
    const m = monthIndex(w[i + 1] ?? '');
    if (m >= 0 && /^\d{1,2}$/.test(w[i + 2] ?? '')) {
      const day = Number(w[i + 2]!);
      let year: number | null = null;
      let count = 3;
      if (/^\d{4}$/.test(w[i + 3] ?? '')) {
        year = Number(w[i + 3]!);
        count = 4;
      }
      const phrase = w.slice(i, i + count).join(' ');
      const start = absoluteInstant(m, day, year, now);
      if (start !== null && day >= 1 && day <= MONTH_LENGTHS[m]!) {
        return {
          count,
          draft: { input: phrase, kind: 'absolute-since', start: iso(start), end: iso(now), status: 'pending-governance', limitation: DATE_LIMITATION },
        };
      }
      return { count, draft: { input: phrase, kind: 'absolute-since', start: null, end: null, status: 'pending-governance', limitation: DATE_LIMITATION } };
    }
    if (/^\d{4}$/.test(w[i + 1] ?? '')) {
      const year = Number(w[i + 1]!);
      const phrase = w.slice(i, i + 2).join(' ');
      return {
        count: 2,
        draft: { input: phrase, kind: 'absolute-since', start: iso(new Date(Date.UTC(year, 0, 1))), end: iso(now), status: 'pending-governance', limitation: DATE_LIMITATION },
      };
    }
  }

  // Bare month-day / "in|during <month>" windows (day optional → whole month).
  const m2 = monthIndex(w[i]!);
  if (m2 >= 0) {
    const dayNext = w[i + 1] ?? '';
    const hasDay = /^\d{1,2}$/.test(dayNext) && Number(dayNext) >= 1 && Number(dayNext) <= MONTH_LENGTHS[m2]!;
    let year: number | null = null;
    let count = 1 + (hasDay ? 1 : 0);
    if (/^\d{4}$/.test(w[i + count] ?? '')) {
      year = Number(w[i + count]!);
      count += 1;
    }
    const phrase = w.slice(i, i + count).join(' ');
    const base = absoluteInstant(m2, hasDay ? Number(dayNext) : 1, year, now);
    if (base !== null) {
      const start = base.getTime();
      const end = hasDay ? start + 24 * 3600 * 1000 : start + (m2 === 1 && isLeap(base.getUTCFullYear()) ? 29 : MONTH_LENGTHS[m2]!) * 24 * 3600 * 1000;
      return { count, draft: { input: phrase, kind: 'absolute-window', start: iso(new Date(start)), end: iso(new Date(Math.min(end, now.getTime() + 24 * 3600 * 1000))), status: 'pending-governance', limitation: DATE_LIMITATION } };
    }
  }

  return null;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function absoluteInstant(month: number, day: number, year: number | null, now: Date): Date | null {
  const resolvedYear = year ?? now.getUTCFullYear();
  if (resolvedYear < 1970 || resolvedYear > 9999) return null;
  return new Date(Date.UTC(resolvedYear, month, day));
}

// ---------------------------------------------------------------------------
// Computed-question markers
// ---------------------------------------------------------------------------

const COMPUTED_MARKERS: readonly { phrase: string; capability: UnsupportedRequest['capability'] }[] = [
  { phrase: 'current reservoir release', capability: 'computed-analysis' },
  { phrase: 'current release', capability: 'computed-analysis' },
  { phrase: 'reservoir release', capability: 'computed-analysis' },
  { phrase: 'rapidly declining', capability: 'computed-analysis' },
  { phrase: 'rate of change', capability: 'computed-analysis' },
  { phrase: 'latest value', capability: 'computed-analysis' },
  { phrase: 'how much', capability: 'computed-analysis' },
  { phrase: 'how many', capability: 'computed-analysis' },
];
const COMPUTED_SINGLE_WORDS: ReadonlySet<string> = new Set<string>([
  'declining', 'decline', 'rising', 'falling', 'increasing', 'decreasing', 'trending', 'trend',
  'average', 'averages', 'mean', 'total', 'totals', 'sum', 'sums', 'aggregate',
]);

// ---------------------------------------------------------------------------
// Main lex
// ---------------------------------------------------------------------------

export interface LexInput {
  readonly utterance: string;
  readonly index: VocabularyIndex;
  readonly now: Date;
  readonly restrictedObjectIds: readonly string[];
}

export function lex({ utterance, index, now, restrictedObjectIds }: LexInput): LexResult {
  const truncated = typeof utterance === 'string' && utterance.length > MAX_UTTERANCE_LENGTH
    ? utterance.slice(0, MAX_UTTERANCE_LENGTH)
    : typeof utterance === 'string' ? utterance : '';
  const scan = scanUtterance(truncated, restrictedObjectIds);

  // Word stream with each word's character offset in the raw text. Each
  // non-alphanumeric character maps to exactly ONE space (no run collapsing),
  // so offsets stay 1:1 with the raw text the security scan covered.
  const normalized = truncated.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const words: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < normalized.length; ) {
    if (normalized[i] === ' ') {
      i += 1;
      continue;
    }
    const start = i;
    while (i < normalized.length && normalized[i] !== ' ') i += 1;
    words.push(normalized.slice(start, i));
    offsets.push(start);
  }

  const consumed = new Array<boolean>(words.length).fill(false);
  const dateDrafts: DateFilterDraft[] = [];
  const unsupportedRequests: UnsupportedRequest[] = [];

  const consume = (from: number, count: number): boolean => {
    for (let k = from; k < from + count; k += 1) {
      if (consumed[k]) return false;
    }
    for (let k = from; k < from + count; k += 1) consumed[k] = true;
    return true;
  };

  // Stage 2: dates (before vocabulary so "march" never becomes an unknown term).
  for (let i = 0; i < words.length; i += 1) {
    if (consumed[i]) continue;
    if (isCoveredBySecurity(scan, offsets[i]!)) {
      consumed[i] = true;
      continue;
    }
    const date = lexDateAt(words, i, now);
    if (date && consume(i, date.count)) dateDrafts.push(date.draft);
  }

  // Stage 3: computed-question markers (longest first).
  for (let i = 0; i < words.length; i += 1) {
    if (consumed[i]) continue;
    for (const marker of COMPUTED_MARKERS) {
      const parts = marker.phrase.split(' ');
      if (words.slice(i, i + parts.length).join(' ') === marker.phrase && consume(i, parts.length)) {
        unsupportedRequests.push({ input: marker.phrase, capability: marker.capability, limitation: COMPUTED_LIMITATION });
        break;
      }
    }
  }
  for (let i = 0; i < words.length; i += 1) {
    if (consumed[i]) continue;
    if (COMPUTED_SINGLE_WORDS.has(words[i]!)) {
      consumed[i] = true;
      unsupportedRequests.push({ input: words[i]!, capability: 'computed-analysis', limitation: COMPUTED_LIMITATION });
    }
  }

  // Stage 4: vocabulary phrases, longest-first.
  const window = maxPhraseLength(index);
  const matches: TermMatch[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (consumed[i]) continue;
    for (let length = Math.min(window, words.length - i); length >= 1; length -= 1) {
      const phrase = words.slice(i, i + length).join(' ');
      const candidates = index.get(phrase);
      if (!candidates || candidates.length === 0) continue;
      if (!consume(i, length)) continue; // overlap: a shorter phrase may still fit
      const primary = candidates[0]!;
      matches.push({
        ...primary,
        input: phrase,
        wordIndex: i,
        wordCount: length,
        alternatives: candidates.slice(1),
      });
      break;
    }
  }

  // Stage 5: leftovers → noise dropped, contiguous content runs become unknown terms.
  const unknownRuns: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    // Bounded echo: at most 8 words, 40 chars per word, 80 chars total, so a
    // hostile flood can never inflate the proposal or its display.
    const echo = run.slice(0, 8).map((word) => word.slice(0, 40)).join(' ');
    unknownRuns.push(echo.length > 80 ? echo.slice(0, 80) : echo);
    run = [];
  };
  for (let i = 0; i < words.length; i += 1) {
    if (consumed[i]) {
      flush();
      continue;
    }
    const word = words[i]!;
    if (NOISE_WORDS.has(word)) {
      flush();
      continue;
    }
    if (isCoveredBySecurity(scan, offsets[i]!)) {
      flush();
      continue;
    }
    run.push(word);
  }
  flush();

  return { matches, unknownRuns, dateDrafts, unsupportedRequests, securityFindings: scan.findings };
}

/** Re-exported for tests and callers that normalize phrases themselves. */
export { normalizePhrase };
