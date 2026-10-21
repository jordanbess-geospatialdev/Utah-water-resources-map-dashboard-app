/**
 * SitePopup - the FR-004 quick site card shown when a public map site is
 * selected.
 *
 * "Clicking a map site displays site and station identifiers, latest
 * available value, unit, observation time and freshness, and a working detail
 * link; missing readings render as unavailable rather than zero."
 *
 * Freshness semantics (NFR-004): stale readings stay visible WITH their
 * timestamp rather than implying a live connection; status is always text +
 * shape (● current, ◆ stale, ■ inactive/no data), never color alone. A null
 * value is "unavailable (reported empty)" and a station without any reading
 * is "no reading reported" — neither is ever rendered as 0.
 *
 * The popup consumes the PUBLIC projection only (WD-006 shell/data/projection
 * read-only reuse): whatever the caller passes must already be the public
 * field set; restricted operational fields have no representation here.
 *
 * Profile navigation is injected, because WD-007 must not edit the shell:
 * pass `onOpenProfile` (button) or `profileHref` (link). The documented mount
 * path for the site profile view is the shell's 'sites' view with the station
 * selected (`view=sites&station=<id>` in viewState vocabulary) — see README.
 */
import type { CSSProperties } from 'react';
import { formatDateMT, formatTimeMT } from '../../components/Chart';
import { systemName, vocabulary } from '../../shell/data/fixtures';
import type { StationProjection } from '../../shell/data/projection';
import type { Freshness } from '../../shell/data/observations';

export interface SitePopupModel {
  readonly stationId: string;
  readonly displayName: string;
  readonly externalId: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly siteTypeId: string;
  readonly status: StationProjection['status'];
  readonly telemetry: StationProjection['telemetry'];
  readonly latest: {
    readonly value: number | null;
    readonly unitId: string;
    readonly observedAt: string;
    readonly processingLevel: string;
    readonly flags: readonly string[];
  } | null;
  readonly freshness: Freshness;
}

export interface SitePopupProps {
  /** The public projection of the selected station (restricted fields are not representable). */
  readonly station: StationProjection;
  /** Button navigation to the site profile view (shell wiring; see README). */
  readonly onOpenProfile?: (stationId: string) => void;
  /** Link navigation to the site profile view, when the shell exposes a route. */
  readonly profileHref?: (stationId: string) => string;
}

const UNIT_NAMES: ReadonlyMap<string, string> = new Map(vocabulary.units.map((unit) => [unit.id, unit.name]));
const PROCESSING_NAMES: ReadonlyMap<string, string> = new Map(vocabulary.processingLevels.map((level) => [level.id, level.name]));

const FRESHNESS_PRESENTATION: Readonly<Record<Freshness, { shape: string; label: string; detail: string }>> = {
  current: { shape: '●', label: 'Current', detail: 'reporting within cadence' },
  stale: { shape: '◆', label: 'Stale', detail: 'last reading shown with its time — does not imply a live connection' },
  inactive: { shape: '■', label: 'Inactive', detail: 'site is not active' },
  'no-data': { shape: '■', label: 'No data', detail: 'no reading on the public streams' },
};

/** Derive the popup model from a public projection (pure; systemName falls back to the id). */
export function sitePopupModel(station: StationProjection): SitePopupModel {
  return {
    stationId: station.id,
    displayName: station.displayName,
    externalId: station.externalId,
    systemId: station.systemId,
    systemName: station.systemName || systemName(station.systemId),
    siteTypeId: station.siteTypeId,
    status: station.status,
    telemetry: station.telemetry,
    latest: station.latest
      ? {
          value: station.latest.value,
          unitId: station.latest.unitId,
          observedAt: station.latest.observedAt,
          processingLevel: station.latest.processingLevel,
          flags: station.latest.flags,
        }
      : null,
    freshness: station.freshness,
  };
}

function formatValue(model: SitePopupModel): string {
  if (model.latest === null) return 'No reading reported';
  if (model.latest.value === null) return 'Unavailable (reported empty)';
  const unit = UNIT_NAMES.get(model.latest.unitId) ?? model.latest.unitId;
  return `${model.latest.value} ${model.latest.unitId} (${unit})`;
}

const CARD_STYLE: CSSProperties = { minWidth: 240, maxWidth: 300, fontSize: 12, lineHeight: 1.45 };
const MUTED: CSSProperties = { color: '#5a6355' };
const VALUE_STYLE: CSSProperties = { fontSize: 15, fontWeight: 600, margin: '4px 0 0' };
const SECTION_STYLE: CSSProperties = { borderTop: '1px solid #e1e5dd', marginTop: 8, paddingTop: 8 };

export function SitePopup({ station, onOpenProfile, profileHref }: SitePopupProps) {
  const model = sitePopupModel(station);
  const freshness = FRESHNESS_PRESENTATION[model.freshness];
  const hasReading = model.latest !== null;
  const profileTarget = profileHref?.(model.stationId) ?? null;

  return (
    <aside aria-label={`Quick site card for ${model.displayName}`} style={CARD_STYLE}>
      <header>
        <strong>{model.displayName}</strong>
        <p style={{ ...MUTED, margin: '2px 0 0' }}>
          Station {model.stationId} · Site ID {model.externalId}
        </p>
        <p style={{ ...MUTED, margin: '2px 0 0' }}>
          {model.systemName} · {model.siteTypeId.replace(/-/g, ' ')} · telemetry: {model.telemetry}
        </p>
      </header>

      <div style={SECTION_STYLE}>
        <h4 style={{ margin: '0 0 2px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>Latest value</h4>
        <p style={VALUE_STYLE} aria-live="polite">
          {formatValue(model)}
        </p>
        {hasReading && (
          <p style={{ ...MUTED, margin: '2px 0 0' }}>
            Observed {formatDateMT(model.latest!.observedAt)} {formatTimeMT(model.latest!.observedAt)} MT ·{' '}
            {PROCESSING_NAMES.get(model.latest!.processingLevel) ?? model.latest!.processingLevel}
            {model.latest!.flags.length > 0 && <> · flags: {model.latest!.flags.join(', ')}</>}
          </p>
        )}
        {!hasReading && (
          <p style={{ ...MUTED, margin: '2px 0 0' }}>No observation time to show — a missing value is never rendered as zero.</p>
        )}
        <p style={{ margin: '4px 0 0' }}>
          <span aria-hidden>{freshness.shape}</span> <strong>{freshness.label}</strong> <span style={MUTED}>— {freshness.detail}</span>
        </p>
      </div>

      <div style={SECTION_STYLE}>
        {profileTarget !== null ? (
          <a href={profileTarget}>Open site profile</a>
        ) : onOpenProfile ? (
          <button type="button" onClick={() => onOpenProfile(model.stationId)}>
            Open site profile
          </button>
        ) : (
          <p style={MUTED}>
            Site profile mounts at the shell’s sites view for station {model.stationId} (shell wiring pending — see features/discovery/README.md).
          </p>
        )}
      </div>
    </aside>
  );
}

export default SitePopup;
