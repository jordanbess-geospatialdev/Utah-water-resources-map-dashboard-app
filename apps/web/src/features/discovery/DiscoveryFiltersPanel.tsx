/**
 * DiscoveryFiltersPanel - the accessible account-free filter UI (FR-001,
 * FR-002; T-01).
 *
 * Semantics rendered here, per filter-set.json:
 * - one labeled <fieldset> per governed dimension; native checkboxes give OR
 *   within a dimension; dimensions AND together (the matching lives in
 *   filters.ts, the panel only edits the typed FilterSet);
 * - an ABSENT dimension is "no constraint": an unchecked group is not a
 *   filter. Where catalog records can carry an unset/unknown value, the
 *   sentinel option "Unknown (value not established)" is offered as an
 *   explicit checkbox — visibly distinct from "no value" (leaving the group
 *   unchecked). Contract-enum dimensions carry their governed values
 *   (telemetry includes its tri-state "unknown");
 * - values the current vocabulary does not know (from a shared link, say) are
 *   listed as inspectable options marked "unknown value" with a jump to the
 *   data dictionary (FR-060) — never silently dropped;
 * - applied filters appear as chips with individual remove buttons plus
 *   "Clear all"; unknown-value chips are visually and textually distinct;
 * - loading disables the groups; a zero-result state is announced politely
 *   with an offered reset.
 *
 * Accessibility: every control is a native input/button (keyboard operable by
 * construction); groups have legends and per-group help bound via
 * aria-describedby; result summaries use role="status" aria-live="polite".
 *
 * Mountable, shell-free: data and state arrive via props; see index.ts and
 * README.md for the one-line shell wiring point.
 */
import type { CSSProperties } from 'react';
import {
  appliedFilterChips,
  classifyFilterValue,
  DISCOVERY_DIMENSIONS,
  hasActiveFilters,
  publicDiscoveryStations,
  stationDimensionIsUnset,
  UNKNOWN_SENTINEL,
  withoutFilterValue,
  type DiscoveryFilterSet,
  type FilterDimension,
  type FilterDimensionKey,
  type FilterRedaction,
} from './filters';

export interface DiscoveryFiltersPanelProps {
  /** Current canonical filters (the single source of truth lives in the parent). */
  readonly filters: DiscoveryFilterSet;
  readonly onFiltersChange: (next: DiscoveryFilterSet) => void;
  /** Override the dimension registry (tests / vocabulary previews). Defaults to DISCOVERY_DIMENSIONS. */
  readonly dimensions?: readonly FilterDimension[];
  /** Matching public-site count, when the parent computed it; announced politely. */
  readonly resultCount?: number | null;
  readonly status?: 'loading' | 'ready';
  /** Open the data dictionary focused on an unknown value (FR-060 wiring). */
  readonly onInspectUnknownValue?: (dimension: FilterDimensionKey, value: string) => void;
  /** Redactions reported while canonicalizing (e.g. from a shared link); rendered as explainable notices. */
  readonly redactions?: readonly FilterRedaction[];
}

const GROUP_STYLE: CSSProperties = { border: '1px solid #d7dcd3', borderRadius: 6, margin: '0 0 10px', padding: '6px 10px 10px' };
const HELP_STYLE: CSSProperties = { margin: '2px 0 6px', fontSize: 11, color: '#5a6355' };
const CHIP_LIST_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '4px 0 10px', padding: 0 };
const CHIP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #9db3a8', borderRadius: 999, padding: '2px 8px', fontSize: 12 };
const UNKNOWN_CHIP_STYLE: CSSProperties = { ...CHIP_STYLE, borderStyle: 'dashed', borderColor: '#c98a2d', color: '#7a5313' };
const NOTICE_STYLE: CSSProperties = { fontSize: 11, color: '#7a5313', margin: '2px 0' };

/** Does any public catalog record carry an unset value for this dimension? Only then is the sentinel offered. */
function sentinelOfferedFor(dimension: FilterDimension): boolean {
  if (dimension.governance === 'contract-enum') return false; // enum dims carry "unknown" as a governed value already
  return publicDiscoveryStations.some((station) => stationDimensionIsUnset(station, dimension.key));
}

/** Values applied in the filters that the governed list does not show (kept from a link, inspectable). */
function extraUnknownOptions(dimension: FilterDimension, filters: DiscoveryFilterSet): string[] {
  const values = filters[dimension.key] ?? [];
  const governed = new Set(dimension.values.map((value) => value.id));
  return values.filter((value) => value !== UNKNOWN_SENTINEL && !governed.has(value));
}

export function DiscoveryFiltersPanel({
  filters,
  onFiltersChange,
  dimensions = DISCOVERY_DIMENSIONS,
  resultCount = null,
  status = 'ready',
  onInspectUnknownValue,
  redactions = [],
}: DiscoveryFiltersPanelProps) {
  const disabled = status === 'loading';
  const chips = appliedFilterChips(filters);

  function toggle(dimension: FilterDimensionKey, value: string) {
    const current = filters[dimension] ?? [];
    const next = current.includes(value) ? current.filter((candidate) => candidate !== value) : [...current, value].sort();
    const patched: Record<string, unknown> = {};
    for (const candidate of dimensions) {
      const values = filters[candidate.key];
      if (values && values.length > 0) patched[candidate.key] = values;
    }
    if (next.length > 0) patched[dimension] = next;
    onFiltersChange(patched as unknown as DiscoveryFilterSet);
  }

  return (
    <section aria-label="Discovery filters" style={{ minWidth: 240 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>Filters</h3>
      <p style={HELP_STYLE}>Multiple values within a group combine (OR); groups combine with each other (AND).</p>

      {chips.length > 0 && (
        <>
          <h4 style={{ fontSize: 11, margin: '8px 0 0' }}>Applied filters</h4>
          <ul style={CHIP_LIST_STYLE}>
            {chips.map((chip) => (
              <li key={`${chip.dimension}:${chip.value}`} style={chip.known ? CHIP_STYLE : UNKNOWN_CHIP_STYLE}>
                <span>
                  <strong>{chip.dimensionLabel}:</strong> {chip.valueLabel}
                </span>
                <button
                  type="button"
                  onClick={() => onFiltersChange(withoutFilterValue(filters, chip.dimension, chip.value))}
                  aria-label={`Remove ${chip.dimensionLabel} filter ${chip.valueLabel}`}
                  disabled={disabled}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                >
                  ✕
                </button>
                {!chip.known && onInspectUnknownValue && (
                  <button
                    type="button"
                    onClick={() => onInspectUnknownValue(chip.dimension, chip.value)}
                    aria-label={`Inspect unknown ${chip.dimensionLabel} value ${chip.value} in the data dictionary`}
                    disabled={disabled}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                  >
                    Inspect
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => onFiltersChange({})} disabled={disabled}>
            Clear all filters
          </button>
        </>
      )}

      {redactions.length > 0 && (
        <div aria-label="Removed filter values">
          {redactions.map((redaction, index) => (
            <p key={index} style={NOTICE_STYLE} role="note">
              Removed one {redaction.dimension} value ({redaction.reason}). Links accept governed identifiers only.
            </p>
          ))}
        </div>
      )}

      <div role="status" aria-live="polite" style={{ margin: '10px 0', fontSize: 12 }}>
        {disabled && 'Loading filters…'}
        {!disabled && resultCount !== null && `${resultCount} public ${resultCount === 1 ? 'site' : 'sites'} match the current filters.`}
        {!disabled && resultCount === 0 && ' No sites match. Clear a filter or inspect unknown values in the data dictionary.'}
      </div>

      {dimensions.map((dimension) => {
        const helpId = `filter-help-${dimension.key}`;
        const selected = filters[dimension.key] ?? [];
        const unknownExtras = extraUnknownOptions(dimension, filters);
        return (
          <fieldset key={dimension.key} style={GROUP_STYLE} disabled={disabled}>
            <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>{dimension.label}</legend>
            <p id={helpId} style={HELP_STYLE}>
              {dimension.help}
              {dimension.governance === 'ungoverned' && ' (Awaiting steward vocabulary at seed v0.1.0.)'}
            </p>
            <div aria-describedby={helpId}>
              {dimension.values.map((value) => (
                <label key={value.id} style={{ display: 'block', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(value.id)}
                    onChange={() => toggle(dimension.key, value.id)}
                  />{' '}
                  {value.label}
                  {value.note && <span style={{ color: '#5a6355' }}> — {value.note}</span>}
                </label>
              ))}
              {unknownExtras.map((value) => (
                <label key={`unknown-${value}`} style={{ display: 'block', fontSize: 12, color: '#7a5313' }}>
                  <input type="checkbox" checked onChange={() => toggle(dimension.key, value)} /> {value} (unknown value — inspect in the
                  data dictionary)
                  {onInspectUnknownValue && (
                    <button
                      type="button"
                      onClick={() => onInspectUnknownValue(dimension.key, value)}
                      aria-label={`Inspect unknown ${dimension.label} value ${value}`}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 0 0 6px', font: 'inherit', textDecoration: 'underline', color: 'inherit' }}
                    >
                      Inspect
                    </button>
                  )}
                </label>
              ))}
              {sentinelOfferedFor(dimension) && (
                <label style={{ display: 'block', fontSize: 12, borderTop: '1px dotted #d7dcd3', marginTop: 4, paddingTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(UNKNOWN_SENTINEL)}
                    onChange={() => toggle(dimension.key, UNKNOWN_SENTINEL)}
                  />{' '}
                  Unknown (value not established)
                  <span style={{ color: '#5a6355' }}> — selects sites with no value; different from leaving this group unchecked</span>
                </label>
              )}
              {dimension.values.length === 0 && unknownExtras.length === 0 && !sentinelOfferedFor(dimension) && (
                <p style={{ ...HELP_STYLE, fontStyle: 'italic' }}>No governed values yet.</p>
              )}
            </div>
          </fieldset>
        );
      })}
    </section>
  );
}

/** Unknown-value classification is re-exported for parents rendering badges. */
export { classifyFilterValue, hasActiveFilters };

export default DiscoveryFiltersPanel;
