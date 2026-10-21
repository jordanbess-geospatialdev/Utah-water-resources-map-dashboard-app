/**
 * DataDictionaryPanel - the FR-060 maintained data map and dictionary for
 * the fixture vocabulary.
 *
 * "Users can find definitions of fields, units, processing levels,
 * qualifiers, lineage and dataset relationships; a vocabulary change
 * publishes a corresponding version or effective date and links API fields to
 * the same definitions."
 *
 * Rendered here, bounded:
 * - filter FIELD definitions: every discovery dimension with its governance
 *   status and governed values (the dictionary of the filter surface);
 * - observed PROPERTIES with dimension, canonical unit (the dataset
 *   relationship property → unit) and description; internal-diagnostic
 *   properties are marked not publicly selectable;
 * - UNITS, PROCESSING LEVELS and QUALIFIERS with ids, labels and definitions;
 * - UNKNOWN VALUES: values arriving from a shared link that the current
 *   vocabulary does not know, so they can be inspected instead of silently
 *   dropped (FR-060 + FR-008 interplay).
 *
 * The seed id and vocabulary version are shown with the definitions, because
 * "a vocabulary change publishes a corresponding version".
 *
 * Loading / empty / error states are props-driven so an API-backed loader can
 * replace the fixtures without touching this component.
 */
import type { CSSProperties } from 'react';
import { vocabulary as fixtureVocabulary, FIXTURE_SEED } from '../../shell/data/fixtures';
import type { VocabularyRecord } from '../../shell/data/types';
import { DISCOVERY_DIMENSIONS, type FilterDimensionKey } from './filters';

export interface UnknownValueEntry {
  readonly dimension: FilterDimensionKey;
  readonly value: string;
}

export interface DataDictionaryPanelProps {
  /** Vocabulary to render; defaults to the frozen contract fixtures (read-only shell reuse). */
  readonly vocabulary?: VocabularyRecord;
  /** Unknown filter values to inspect (from a shared link); rendered first. */
  readonly unknownValues?: readonly UnknownValueEntry[];
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Bound on rows per section; the fixture vocabulary is far below it. */
  readonly maxRows?: number;
}

/** Row bound: the listing is always finite even against a hostile vocabulary payload. */
export const MAX_DICTIONARY_ROWS = 100;

const PANEL_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, minWidth: 280 };
const SECTION_STYLE: CSSProperties = { border: '1px solid #e1e5dd', borderRadius: 6, padding: '6px 10px', margin: '0 0 10px' };
const TABLE_STYLE: CSSProperties = { borderCollapse: 'collapse', width: '100%' };
const CELL_STYLE: CSSProperties = { border: '1px solid #e1e5dd', padding: '2px 6px', textAlign: 'left', verticalAlign: 'top' };
const CODE_STYLE: CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 11 };
const MUTED: CSSProperties = { color: '#5a6355' };

function BoundedTable({ headers, rows, maxRows }: { headers: string[]; rows: readonly (readonly string[])[]; maxRows: number }) {
  const shown = rows.slice(0, maxRows);
  return (
    <>
      <table style={TABLE_STYLE}>
        <caption className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
          Data dictionary entries
        </caption>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" style={CELL_STYLE}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={cellIndex === 0 ? { ...CELL_STYLE, ...CODE_STYLE } : CELL_STYLE}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p style={{ ...MUTED, margin: '4px 0 0' }}>Showing first {shown.length} of {rows.length} — the listing is bounded.</p>
      )}
    </>
  );
}

export function DataDictionaryPanel({
  vocabulary = fixtureVocabulary,
  unknownValues = [],
  status = 'ready',
  errorMessage,
  onRetry,
  maxRows = MAX_DICTIONARY_ROWS,
}: DataDictionaryPanelProps) {
  if (status === 'loading') {
    return (
      <section aria-label="Data dictionary" aria-busy="true" role="status" style={PANEL_STYLE}>
        <h3 style={{ fontSize: 13, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>Data dictionary</h3>
        <p style={MUTED}>Loading vocabulary…</p>
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section aria-label="Data dictionary" role="alert" style={PANEL_STYLE}>
        <h3 style={{ fontSize: 13, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>Data dictionary</h3>
        <p>{errorMessage ?? 'The vocabulary could not be loaded.'}</p>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </section>
    );
  }

  const propertyRows = vocabulary.observedProperties.map((property) => [
    property.id,
    property.name,
    property.dimension,
    property.canonicalUnitId,
    `${property.description}${property.id === 'voltage' ? ' (Internal diagnostic — not selectable on the public map.)' : ''}`,
  ]);
  const unitRows = vocabulary.units.map((unit) => [unit.id, unit.name, unit.dimension, unit.description ?? '—']);
  const levelRows = vocabulary.processingLevels.map((level) => [level.id, level.name, level.description]);
  const qualifierRows = vocabulary.qualifiers.map((qualifier) => [qualifier.id, qualifier.name, qualifier.description]);
  const totalEntries = propertyRows.length + unitRows.length + levelRows.length + qualifierRows.length;
  const dimensionName = new Map(DISCOVERY_DIMENSIONS.map((dimension) => [dimension.key, dimension.label]));

  return (
    <section aria-label="Data dictionary" style={PANEL_STYLE}>
      <h3 style={{ fontSize: 13, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>Data dictionary</h3>
      <p style={{ ...MUTED, margin: '0 0 10px' }}>
        Seed {FIXTURE_SEED} · vocabulary version {vocabulary.version} · {totalEntries} governed entries. A vocabulary change publishes a new
        version; API fields link to these same definitions.
      </p>

      {unknownValues.length > 0 && (
        <div style={{ ...SECTION_STYLE, borderColor: '#c98a2d' }}>
          <h4 style={{ margin: '0 0 4px' }}>Unknown filter values in this link</h4>
          <p style={{ ...MUTED, margin: '0 0 4px' }}>
            Values the current vocabulary does not know. They match no sites and stay listed here so they can be inspected, never silently
            dropped.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {unknownValues.map((entry) => (
              <li key={`${entry.dimension}:${entry.value}`}>
                <strong>{dimensionName.get(entry.dimension) ?? entry.dimension}</strong>:{' '}
                <code style={CODE_STYLE}>{entry.value}</code> — no definition in vocabulary version {vocabulary.version}.
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 4px' }}>Filter fields</h4>
        <p style={{ ...MUTED, margin: '0 0 4px' }}>Discovery filter dimensions, their governance status and governed values.</p>
        <BoundedTable
          headers={['Field', 'Governance', 'Values']}
          rows={DISCOVERY_DIMENSIONS.map((dimension) => [
            dimension.key,
            dimension.governance,
            dimension.values.length > 0 ? dimension.values.map((value) => value.id).join(', ') : 'none governed yet',
          ])}
          maxRows={maxRows}
        />
      </div>

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 4px' }}>Observed properties</h4>
        <BoundedTable headers={['Id', 'Name', 'Dimension', 'Canonical unit', 'Definition']} rows={propertyRows} maxRows={maxRows} />
      </div>

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 4px' }}>Units</h4>
        <BoundedTable headers={['Id', 'Name', 'Dimension', 'Definition']} rows={unitRows} maxRows={maxRows} />
      </div>

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 4px' }}>Processing levels</h4>
        <BoundedTable headers={['Id', 'Label', 'Definition']} rows={levelRows} maxRows={maxRows} />
      </div>

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 4px' }}>Qualifiers</h4>
        <BoundedTable headers={['Id', 'Label', 'Definition']} rows={qualifierRows} maxRows={maxRows} />
      </div>

      {totalEntries === 0 && (
        <p role="status" style={MUTED}>
          The vocabulary is empty for seed {FIXTURE_SEED}.
        </p>
      )}
    </section>
  );
}

export default DataDictionaryPanel;
