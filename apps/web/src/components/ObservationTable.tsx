import type { SeriesPoint } from '../shell/data/observations';
import { processingLevelName } from '../shell/data/fixtures';
import { formatFlow, formatTimeMT } from './Chart';
import { FlagIndicator } from './StatusIndicator';

/**
 * Data-table alternative to the chart (FR-005, FR-062): the same points, the
 * same selected index and the same formatting helpers, so the table always
 * carries the same selected values as the chart. Missing readings render as
 * "Unavailable", never as zero; duplicate timestamps keep both rows; suspect
 * and out-of-range values keep their true value plus a flag.
 */
export interface ObservationTableProps {
  points: SeriesPoint[];
  unitId: string;
  selectedIndex: number | null;
  onSelectIndex: (index: number | null) => void;
}

export default function ObservationTable({ points, unitId, selectedIndex, onSelectIndex }: ObservationTableProps) {
  return (
    <div className="obs-table-wrap">
      <table className="obs-table">
        <caption className="sr-only">
          Observation values for the selected window; select a row to inspect it in the chart
        </caption>
        <thead>
          <tr>
            <th scope="col">Observation time (MT)</th>
            <th scope="col">Raw</th>
            <th scope="col">Best available</th>
            <th scope="col">Processing level</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => {
            const selected = selectedIndex === index;
            return (
              <tr key={point.id} className={selected ? 'active-row' : ''}>
                <td>
                  <button
                    type="button"
                    className="obs-select"
                    aria-pressed={selected}
                    onClick={() => onSelectIndex(selected ? null : index)}
                  >
                    {formatTimeMT(point.observedAt)}
                  </button>
                </td>
                <td className="numeric">{formatFlow(point.raw, unitId)}</td>
                <td className="numeric strong">{formatFlow(point.best, unitId)}</td>
                <td>{processingLevelName.get(point.processingLevel) ?? point.processingLevel}</td>
                <td>
                  <span className="flag-list">
                    {point.flags.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      point.flags.map((flag) => <FlagIndicator key={flag} value={flag} />)
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
