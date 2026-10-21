/**
 * CSV rendering for series exports (WD-008; FR-063).
 *
 * Technical specification, "Proposed application API":
 * "CSV output includes station/stream IDs, property/unit, observation
 * time/zone, value, processing level, qualifiers, source and revision
 * identifiers. Neutralize spreadsheet formula injection in user-controlled
 * text."
 *
 * - Line endings are CRLF (RFC 4180 section 2.1; also the encoding Excel
 *   expects). This choice is deliberate and documented here.
 * - Escaping is RFC 4180: a field is quoted when it contains a comma, a
 *   double quote, CR or LF; embedded double quotes are doubled. Numbers and
 *   identifiers are never re-formatted.
 * - Formula neutralization (OWASP CSV-injection guidance): a TEXT field
 *   whose first character is =, +, -, @, TAB or CR is prefixed with a single
 *   quote so spreadsheet applications render it as text instead of a
 *   formula. Applied to user-controlled/free-text columns (station display
 *   name, joined qualifier labels); NOT applied to numeric value columns
 *   (a legitimate negative like -1.2 must round-trip) or to system-generated
 *   identifier/timestamp columns, which cannot start with those characters
 *   and must stay machine-readable.
 * - A missing value renders as an EMPTY field, never 0 (missing is missing).
 * - Multi-stream ordering is documented: station_id, then stream_id, then
 *   observed_at_utc ascending (FR-063: "multi-site data uses documented
 *   ordering").
 */
import type { EffectivePoint } from '../series/types.ts';

export const CSV_COLUMNS = [
  'station_id',
  'station_name',
  'stream_id',
  'observed_property_id',
  'unit_id',
  'observed_at_utc',
  'source_utc_offset',
  'value',
  'value_type',
  'processing_level',
  'qualifier_ids',
  'revision_id',
  'source_id',
  'source_event_id',
  'received_at_utc',
] as const;

/** RFC 4180 field escaping. */
export function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Neutralize spreadsheet formula injection on user-controlled text (=, +, -, @, TAB, CR leads). */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function formatCsvValue(value: number | null): string {
  if (value === null) return '';
  return String(value);
}

export interface CsvStreamSelection {
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly streamId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  /** Effective points of the selection at the requested basis (already grant-gated). */
  readonly points: readonly EffectivePoint[];
}

export interface RenderedCsv {
  readonly csv: string;
  readonly rowCount: number;
  readonly byteLength: number;
}

function row(fields: readonly (string | number | null)[]): string {
  return fields.map((field) => csvEscape(field === null ? '' : String(field))).join(',');
}

/** Render one CSV document (header + data rows, CRLF, trailing newline after the last row). */
export function renderObservationCsv(selections: readonly CsvStreamSelection[]): RenderedCsv {
  const lines: string[] = [row(CSV_COLUMNS)];
  const ordered = [...selections].sort((a, b) =>
    a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0,
  );
  for (const selection of ordered) {
    const sortedPoints = [...selection.points].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
    for (const point of sortedPoints) {
      lines.push(
        row([
          selection.stationId,
          neutralizeFormula(selection.stationDisplayName),
          selection.streamId,
          selection.observedPropertyId,
          selection.unitId,
          point.observedAt,
          point.sourceOffset,
          formatCsvValue(point.value),
          point.valueType,
          point.processingLevel,
          neutralizeFormula(point.qualifierIds.join(';')),
          point.revisionId ?? '',
          point.sourceId,
          point.sourceEventId,
          point.receivedAt,
        ]),
      );
    }
  }
  const csv = `${lines.join('\r\n')}\r\n`;
  return { csv, rowCount: lines.length - 1, byteLength: new TextEncoder().encode(csv).byteLength };
}
