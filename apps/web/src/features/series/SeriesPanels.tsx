import ComparisonPanel from './ComparisonPanel';
import ExportPanel from './ExportPanel';
import SeriesChart from './SeriesChart';

/**
 * Composite workspace for the site-detail series tab: chart, site
 * comparison and export panels stacked. Kept in its own module because the
 * feature barrel (index.ts) stays JSX-free like the other feature barrels.
 */
export default function SeriesPanels({ streamId = 'str-corinne-q' }: { streamId?: string }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <SeriesChart streamId={streamId} />
      <ComparisonPanel />
      <ExportPanel />
    </div>
  );
}
