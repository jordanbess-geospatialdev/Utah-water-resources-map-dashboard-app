import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  ClipboardList,
  Database,
  Droplets,
  FileClock,
  FlaskConical,
  Globe2,
  LayoutDashboard,
  Lock,
  MapPin,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import StationMap, { type MapCamera } from '../map/shell/StationMap';
import Chart, { formatFlow, formatTimeMT } from '../components/Chart';
import ObservationTable from '../components/ObservationTable';
import { FlagIndicator, FreshnessIndicator, ProcessingIndicator } from '../components/StatusIndicator';
import {
  FIXTURE_CLOCK,
  FIXTURE_SEED,
  FIXTURE_TIME_ZONE,
  activeEntitlements,
  organizationById,
  principalName,
  qualifierName,
  stationById,
  systemName,
  providerName,
  vocabulary,
} from './data/fixtures';
import { defaultPersonaId, personaById, personas, viewerFor } from './data/personas';
import { projectCatalog, type StationProjection } from './data/projection';
import { dischargeStream, stationRevisions, streamGaps, windowedPoints } from './data/observations';
import {
  applyViewState,
  defaultViewState,
  parseViewState,
  serializeViewState,
  type BasemapKind,
  type ChartWindow,
  type ShellView,
  type TelemetryFilter,
} from './data/viewState';

const VIEW_TITLES: Record<ShellView, string> = {
  overview: 'Measurement overview',
  sites: 'Measurement stations',
  stewardship: 'Stewardship workspace',
};

type DetailTab = 'observations' | 'revisions' | 'details';

function clockMT(): string {
  return new Date(FIXTURE_CLOCK).toLocaleString('en-US', { timeZone: FIXTURE_TIME_ZONE });
}

/**
 * WD-006 role-based application shell over the validated GeoLibre/MapLibre
 * integration. Six persona entry points drive the demo projection; the
 * persona selector is a demonstration control, not a security boundary, and
 * the synthetic-data banner (fixture seed visible) stays on every view.
 */
export function App() {
  const [personaId, setPersonaId] = useState(defaultPersonaId);
  const [view, setView] = useState<ShellView>(defaultViewState.view);
  const [stationId, setStationId] = useState<string | null>(defaultViewState.stationId);
  const [systemId, setSystemId] = useState(defaultViewState.systemId);
  const [siteTypeId, setSiteTypeId] = useState(defaultViewState.siteTypeId);
  const [telemetry, setTelemetry] = useState<TelemetryFilter>(defaultViewState.telemetry);
  const [search, setSearch] = useState('');
  const [days, setDays] = useState<ChartWindow>(defaultViewState.days);
  const [basemap, setBasemap] = useState<BasemapKind>(defaultViewState.basemap);
  const [camera, setCamera] = useState<MapCamera>(defaultViewState.map);
  const [tab, setTab] = useState<DetailTab>('observations');
  const [display, setDisplay] = useState<'chart' | 'table'>('chart');
  const [emphasis, setEmphasis] = useState<'best' | 'raw'>('best');
  const [pointIndex, setPointIndex] = useState<number | null>(null);
  const [deniedStationId, setDeniedStationId] = useState<string | null>(null);
  const urlSynced = useRef(false);

  const persona = personaById(personaId);
  const viewer = viewerFor(persona);
  const catalog = useMemo(() => projectCatalog(viewer), [viewer]);

  // Restore a shared URL (FR-008): non-sensitive view state only; the persona
  // never travels in the link, and an inaccessible station is omitted with a
  // clear message instead of silently kept.
  useEffect(() => {
    const parsed = parseViewState(typeof location === 'undefined' ? '' : location.search);
    if (parsed) {
      const applied = applyViewState(parsed, catalog.map((station) => station.id));
      setView(applied.state.view);
      setStationId(applied.state.stationId);
      setSystemId(applied.state.systemId);
      setSiteTypeId(applied.state.siteTypeId);
      setTelemetry(applied.state.telemetry);
      setDays(applied.state.days);
      setBasemap(applied.state.basemap);
      setCamera(applied.state.map);
      setDeniedStationId(applied.deniedStationId);
    }
    urlSynced.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serialize every view-state change back to the URL (versioned, canonical).
  useEffect(() => {
    if (!urlSynced.current || typeof history === 'undefined') return;
    const query = serializeViewState({ view, stationId, systemId, siteTypeId, telemetry, days, basemap, map: camera });
    history.replaceState(null, '', query === '' ? location.pathname : `${location.pathname}?${query}`);
  }, [view, stationId, systemId, siteTypeId, telemetry, days, basemap, camera]);

  // Persona switch: drop a selection the new projection cannot see (with a
  // notice), and fall back from a view the persona cannot reach.
  useEffect(() => {
    if (stationId !== null && !catalog.some((station) => station.id === stationId)) {
      setStationId(null);
      setDeniedStationId(stationId);
      setPointIndex(null);
    }
    if (view === 'stewardship' && persona.role !== 'steward') setView('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  const systemOptions = useMemo(() => {
    const ids = [...new Set(catalog.map((station) => station.systemId))];
    return ids.map((id) => ({ id, name: systemName(id) }));
  }, [catalog]);
  const siteTypeOptions = useMemo(() => [...new Set(catalog.map((station) => station.siteTypeId))], [catalog]);

  const filtered = useMemo(
    () =>
      catalog.filter(
        (station) =>
          (systemId === 'all' || station.systemId === systemId) &&
          (siteTypeId === 'all' || station.siteTypeId === siteTypeId) &&
          (telemetry === 'all' || station.telemetry === telemetry) &&
          (search.trim() === '' ||
            `${station.displayName} ${station.id} ${station.externalId} ${station.systemName}`.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [catalog, systemId, siteTypeId, telemetry, search],
  );

  const selected = stationId !== null ? catalog.find((station) => station.id === stationId) ?? null : null;
  const baseStation = selected !== null ? stationById.get(selected.id) ?? null : null;
  const detailStream = baseStation !== null ? dischargeStream(baseStation) : undefined;
  const detailPoints = useMemo(
    () => (detailStream !== undefined ? windowedPoints(detailStream.id, days) : []),
    [detailStream, days],
  );
  const detailGapBands = useMemo(() => (detailStream !== undefined ? streamGaps(detailStream.id) : []), [detailStream]);
  const detailRevisionList = useMemo(() => (baseStation !== null ? stationRevisions(baseStation) : []), [baseStation]);

  useEffect(() => setPointIndex(null), [stationId, days]);

  const overview = useMemo(() => {
    const telemetered = catalog.filter((station) => station.telemetry === 'telemetered' && station.status === 'active');
    const reporting = telemetered.filter((station) => station.freshness === 'current');
    const withData = catalog.filter((station) => station.latest !== null);
    const reviewed = withData.filter((station) => station.latest?.processingLevel === 'reviewed' || station.latest?.processingLevel === 'best-available');
    const attention = catalog.filter(
      (station) => station.freshness === 'stale' || station.freshness === 'no-data' || (station.latest?.flags.length ?? 0) > 0,
    );
    return { telemetered, reporting, withData, reviewed, attention };
  }, [catalog]);

  function selectStation(id: string) {
    setStationId(id);
    setTab('observations');
    setPointIndex(null);
  }

  function resetFilters() {
    setSystemId('all');
    setSiteTypeId('all');
    setTelemetry('all');
    setSearch('');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('overview');
          }}
        >
          <div className="brand-icon">
            <Droplets size={26} aria-hidden />
          </div>
          <div>
            UTAH
            <span>DIVISION OF WATER RIGHTS</span>
          </div>
        </a>
        <div className="workspace-label">WATER MEASUREMENT</div>
        <nav aria-label="Main navigation">
          {(
            [
              { id: 'overview' as ShellView, label: 'Overview', icon: LayoutDashboard },
              { id: 'sites' as ShellView, label: 'Stations', icon: MapPin },
              ...(persona.role === 'steward' ? [{ id: 'stewardship' as ShellView, label: 'Stewardship', icon: Users }] : []),
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'nav-item selected' : 'nav-item'}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              <item.icon size={18} aria-hidden />
              <span>{item.label}</span>
              {view === item.id && <span className="nav-selected" aria-hidden />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="water-mark">
            <Activity size={22} aria-hidden />
          </div>
          <strong>Understand the flow.</strong>
          <p>Trusted measurements for a shared water future.</p>
          <span className="status-dot" aria-hidden /> Synthetic demonstration
        </div>
        <div className="sidebar-user">
          <div className="avatar" aria-hidden>
            {persona.initials}
          </div>
          <div>
            <strong>{persona.name}</strong>
            <span>{persona.title}</span>
          </div>
          <ShieldCheck size={17} aria-hidden />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Water data <ChevronRight size={13} aria-hidden /> <strong>{VIEW_TITLES[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="public-label">
              <Globe2 size={14} aria-hidden />
              {persona.role === 'public' ? 'Public access' : 'Demo session'}
            </span>
            <div className="avatar small" aria-hidden>
              {persona.initials}
            </div>
          </div>
        </header>

        {/* Persistent synthetic-data banner: fixture seed id always visible. */}
        <div className="demo-ribbon" role="note">
          <span>
            <Database size={16} aria-hidden />
            <strong>SYNTHETIC DATA</strong> · seed <code>{FIXTURE_SEED}</code> · fixed clock {clockMT()} MT · demonstration only, not operational water data
          </span>
          <label>
            <span className="ribbon-label">
              Demonstration control — not a security boundary<Lock size={12} aria-hidden />
            </span>
            <select aria-label="Demo persona (demonstration control, not a security boundary)" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              {personas.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">UTAH WATER DATA</div>
              <h1>{VIEW_TITLES[view]}</h1>
              <p>
                {persona.description} <span className="persona-note">{persona.principalNote}</span>
              </p>
            </div>
          </div>

          {deniedStationId !== null && (
            <div className="denied-banner" role="status">
              <AlertTriangle size={16} aria-hidden />
              <span>
                Station <code>{deniedStationId}</code> is outside this persona's demo projection, so it was omitted. Whoever opens a shared URL only ever
                receives data their own session can access.
              </span>
              <button type="button" className="dismiss" aria-label="Dismiss omission notice" onClick={() => setDeniedStationId(null)}>
                <X size={14} aria-hidden />
              </button>
            </div>
          )}

          {view === 'stewardship' && persona.role === 'steward' ? (
            <Stewardship />
          ) : (
            <>
              {view === 'overview' && (
                <section className="stats" aria-label="Statewide summary at the fixture snapshot">
                  <div className="stat-card">
                    <div className="stat-top">
                      <span>Stations in view</span>
                      <MapPin size={17} aria-hidden />
                    </div>
                    <strong>
                      {catalog.length}
                      <small>stations</small>
                    </strong>
                    <span className="stat-foot">
                      {catalog.filter((s) => s.access === 'public').length} public · {catalog.filter((s) => s.access === 'assigned').length} through demo assignment ·{' '}
                      {systemOptions.length} systems
                    </span>
                  </div>
                  <div className="stat-card">
                    <div className="stat-top">
                      <span>Telemetry reporting</span>
                      <Activity size={17} aria-hidden />
                    </div>
                    <strong>
                      {overview.reporting.length}
                      <small>of {overview.telemetered.length} telemetered</small>
                    </strong>
                    <span className="stat-foot">
                      Fresh at the fixture snapshot {clockMT()} MT · trailing cadence window · denominator: active telemetered stations
                    </span>
                  </div>
                  <div className="stat-card">
                    <div className="stat-top">
                      <span>Reviewed or best available</span>
                      <ShieldCheck size={17} aria-hidden />
                    </div>
                    <strong>
                      {overview.reviewed.length}
                      <small>of {overview.withData.length} with data</small>
                    </strong>
                    <span className="stat-foot">Latest discharge point per station · output measures, not outcomes</span>
                  </div>
                  <button type="button" className="stat-card attention" onClick={() => setView('sites')}>
                    <div className="stat-top">
                      <span>Needs attention</span>
                      <FileClock size={17} aria-hidden />
                    </div>
                    <strong>
                      {overview.attention.length}
                      <small>stations</small>
                    </strong>
                    <span className="stat-foot">
                      Stale, no data or flagged latest values <ChevronRight size={13} aria-hidden />
                    </span>
                  </button>
                </section>
              )}

              <section className="filter-bar" aria-label="Station filters">
                <div className="search">
                  <Search size={17} aria-hidden />
                  <input aria-label="Search stations" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search stations, IDs or systems" />
                  {search !== '' && (
                    <button type="button" aria-label="Clear search" onClick={() => setSearch('')}>
                      <X size={14} aria-hidden />
                    </button>
                  )}
                </div>
                <div className="filter-select">
                  <label htmlFor="system">Distribution system</label>
                  <select id="system" value={systemId} onChange={(e) => setSystemId(e.target.value)}>
                    <option value="all">All systems</option>
                    {systemOptions.map((system) => (
                      <option key={system.id} value={system.id}>
                        {system.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="filter-select">
                  <label htmlFor="site-type">Site type</label>
                  <select id="site-type" value={siteTypeId} onChange={(e) => setSiteTypeId(e.target.value)}>
                    <option value="all">All site types</option>
                    {siteTypeOptions.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="filter-select">
                  <label htmlFor="telemetry">Telemetry</label>
                  <select id="telemetry" value={telemetry} onChange={(e) => setTelemetry(e.target.value as TelemetryFilter)}>
                    <option value="all">Any</option>
                    <option value="telemetered">Telemetered</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>
                <button type="button" className="button filter-toggle" onClick={resetFilters}>
                  Reset filters
                </button>
              </section>

              <section className="workspace-grid">
                <div className="panel map-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Stations across Utah</h2>
                      <span>{filtered.length} projected stations match your view</span>
                    </div>
                    <span className="mini-pill">
                      <Globe2 size={12} aria-hidden />
                      GeoLibre map
                    </span>
                  </div>
                  <StationMap
                    stations={filtered}
                    selectedStationId={selected?.id ?? null}
                    basemapId={basemap}
                    initialCamera={camera}
                    onSelect={selectStation}
                    onBasemapChange={setBasemap}
                    onCameraChange={setCamera}
                  />
                </div>
                <div className="panel table-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Measurement stations</h2>
                      <span>Map and table carry the same rows; select a station to explore its observations</span>
                    </div>
                    <span className="count-pill">{filtered.length}</span>
                  </div>
                  <div className="site-table-wrap">
                    {filtered.length > 0 ? (
                      <table className="site-table">
                        <thead>
                          <tr>
                            <th scope="col">Station</th>
                            <th scope="col">Latest value</th>
                            <th scope="col">Freshness</th>
                            <th scope="col">Access</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((station) => (
                            <tr key={station.id} className={selected?.id === station.id ? 'active-row' : ''}>
                              <td>
                                <button type="button" className="site-name" onClick={() => selectStation(station.id)}>
                                  {station.displayName}
                                </button>
                                <span className="site-sub">
                                  {station.id} · {station.externalId} · {station.systemName}
                                </span>
                              </td>
                              <td>
                                {station.latest === null ? (
                                  <span className="muted">Unavailable</span>
                                ) : (
                                  <>
                                    <strong className="numeric">{formatFlow(station.latest.value, station.latest.unitId).split(' ')[0]}</strong>
                                    <small>{station.latest.unitId}</small>
                                  </>
                                )}
                              </td>
                              <td>
                                <FreshnessIndicator value={station.freshness} />
                              </td>
                              <td>
                                <span className={`access-pill ${station.access}`}>{station.access === 'public' ? 'Public' : 'Assigned'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty-state">
                        <Search size={27} aria-hidden />
                        <h3>No stations in this view</h3>
                        <p>Try a different search or filter, or switch the demo persona.</p>
                        <button type="button" className="button" onClick={resetFilters}>
                          Reset filters
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="table-foot">
                    <span>
                      {filtered.length} synthetic records · demo projection applied · missing readings shown as unavailable
                    </span>
                    <span>cfs = cubic feet per second</span>
                  </div>
                </div>
              </section>

              {selected !== null && baseStation !== null ? (
                <StationDetail
                  key={selected.id}
                  station={selected}
                  tab={tab}
                  setTab={setTab}
                  days={days}
                  setDays={setDays}
                  display={display}
                  setDisplay={setDisplay}
                  emphasis={emphasis}
                  setEmphasis={setEmphasis}
                  pointIndex={pointIndex}
                  setPointIndex={setPointIndex}
                  points={detailPoints}
                  gapBands={detailGapBands}
                  revisionList={detailRevisionList}
                  stream={detailStream}
                />
              ) : (
                <section className="panel detail-panel empty-detail" aria-label="No station selected">
                  <div className="empty-state compact">
                    <MapPin size={24} aria-hidden />
                    <p>Select a station on the map or in the table to see its observations, revisions and details.</p>
                  </div>
                </section>
              )}
            </>
          )}

          <footer className="page-footer">
            <span>Utah Division of Water Rights · product demonstration</span>
            <span>
              Fixture snapshot {clockMT()} MT (fixed clock) · all measurements synthetic · seed {FIXTURE_SEED}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function StationDetail({
  station,
  tab,
  setTab,
  days,
  setDays,
  display,
  setDisplay,
  emphasis,
  setEmphasis,
  pointIndex,
  setPointIndex,
  points,
  gapBands,
  revisionList,
  stream,
}: {
  station: StationProjection;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
  days: ChartWindow;
  setDays: (days: ChartWindow) => void;
  display: 'chart' | 'table';
  setDisplay: (display: 'chart' | 'table') => void;
  emphasis: 'best' | 'raw';
  setEmphasis: (emphasis: 'best' | 'raw') => void;
  pointIndex: number | null;
  setPointIndex: (index: number | null) => void;
  points: ReturnType<typeof windowedPoints>;
  gapBands: ReturnType<typeof streamGaps>;
  revisionList: ReturnType<typeof stationRevisions>;
  stream: ReturnType<typeof dischargeStream>;
}) {
  const latest = points.at(-1) ?? null;
  return (
    <section className="panel detail-panel" aria-label={`Detail for ${station.displayName}`}>
      <div className="detail-heading">
        <div className="detail-icon">
          <Droplets size={22} aria-hidden />
        </div>
        <div>
          <div className="detail-kicker">
            {station.id} <span>·</span> {station.externalId} <span>·</span> {station.systemName}
          </div>
          <h2>{station.displayName}</h2>
        </div>
        <div className="detail-right">
          <FreshnessIndicator value={station.freshness} />
          <span className={`access-pill ${station.access}`}>{station.access === 'public' ? 'Public' : 'Assigned'}</span>
        </div>
      </div>
      <div className="detail-tabs" role="tablist" aria-label="Station detail sections">
        {(
          [
            { id: 'observations' as DetailTab, name: 'Observations' },
            { id: 'revisions' as DetailTab, name: `Revisions (${revisionList.length})` },
            { id: 'details' as DetailTab, name: 'Station information' },
          ]
        ).map((entry) => (
          <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? 'active' : ''} onClick={() => setTab(entry.id)}>
            {entry.name}
          </button>
        ))}
      </div>

      {tab === 'observations' && (
        <div className="observations">
          <div className="latest-reading">
            <span className="eyebrow">LATEST DISCHARGE</span>
            <div className="reading-value">
              {station.latest === null || station.latest.value === null ? <span className="unavailable">Unavailable</span> : station.latest.value.toFixed(1)}
              {station.latest !== null && station.latest.value !== null && <span>{station.latest.unitId}</span>}
            </div>
            <p>
              {station.latest === null ? (
                'No observation received in the fixture world'
              ) : (
                <>
                  observed {formatTimeMT(station.latest.observedAt)} MT · <ProcessingIndicator value={station.latest.processingLevel} />
                </>
              )}
            </p>
            {latest !== null && latest.flags.length > 0 && (
              <div className="flag-list">
                {latest.flags.map((flag) => (
                  <FlagIndicator key={flag} value={flag} />
                ))}
              </div>
            )}
            <dl>
              <div>
                <dt>Provider</dt>
                <dd>{providerName(station.providerId)}</dd>
              </div>
              <div>
                <dt>Telemetry</dt>
                <dd>{station.telemetry}</dd>
              </div>
              <div>
                <dt>Water source</dt>
                <dd>{station.waterSourceTypeId}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>{station.access === 'public' ? 'Published' : 'Through demo assignment'}</dd>
              </div>
            </dl>
          </div>
          <div className="chart-section">
            <div className="chart-heading">
              <h3>Discharge over time · raw vs best available</h3>
              <div className="segmented" role="group" aria-label="Value emphasis">
                <button type="button" className={emphasis === 'best' ? 'active' : ''} onClick={() => setEmphasis('best')}>
                  Best available
                </button>
                <button type="button" className={emphasis === 'raw' ? 'active' : ''} onClick={() => setEmphasis('raw')}>
                  Raw
                </button>
              </div>
              <div className="segmented" role="group" aria-label="Chart window">
                <button type="button" className={days === 7 ? 'active' : ''} onClick={() => setDays(7)}>
                  7 days
                </button>
                <button type="button" className={days === 14 ? 'active' : ''} onClick={() => setDays(14)}>
                  14 days
                </button>
              </div>
              <div className="segmented" role="group" aria-label="Display mode">
                <button type="button" className={display === 'chart' ? 'active' : ''} onClick={() => setDisplay('chart')}>
                  Chart
                </button>
                <button type="button" className={display === 'table' ? 'active' : ''} onClick={() => setDisplay('table')}>
                  Data table
                </button>
              </div>
            </div>
            {stream === undefined ? (
              <div className="chart-empty" role="status">
                <p>No discharge datastream is visible for this persona.</p>
              </div>
            ) : display === 'chart' ? (
              <Chart
                points={points}
                gapBands={gapBands}
                unitId={stream.unitId}
                stationName={station.displayName}
                emphasis={emphasis}
                selectedIndex={pointIndex}
                onSelectIndex={setPointIndex}
              />
            ) : (
              <ObservationTable points={points} unitId={stream.unitId} selectedIndex={pointIndex} onSelectIndex={setPointIndex} />
            )}
            <p className="chart-hint">
              Select any point (click or keyboard) to inspect its raw value, best-available value and flags. The table alternative carries the same selected
              values.
            </p>
          </div>
        </div>
      )}

      {tab === 'revisions' && (
        <div className="history">
          <div className="history-explainer">
            <ShieldCheck size={17} aria-hidden />
            <span>Raw observations are immutable. Corrections append revisions; the best available value is derived, and every earlier revision is retained.</span>
          </div>
          {revisionList.length > 0 ? (
            revisionList.map((revision) => (
              <article key={revision.id}>
                <div className="timeline-dot" aria-hidden />
                <div>
                  <strong>
                    {revision.type === 'correction' ? 'Corrected observation' : 'Processing level advance'} · {revision.id}
                  </strong>
                  <p>{revision.reason}</p>
                  <div>
                    <span className="revision">
                      {revision.type === 'correction' ? 'corrected to' : 'advanced to'} {revision.value} {revision.unitId}
                    </span>
                    {revision.baseRevisionId !== null && <span className="qualifier">supersedes nothing; builds on {revision.baseRevisionId}</span>}
                    {revision.qualifierIds.length > 0 && (
                      <span className="qualifier">{revision.qualifierIds.map((id) => qualifierName.get(id) ?? id).join(', ')}</span>
                    )}
                    <span className="qualifier">{revision.processingLevel}</span>
                  </div>
                  <small>
                    {principalName(revision.actorId)} · recorded {formatTimeMT(revision.recordedAt)} MT · point observed {formatTimeMT(revision.observedAt)} MT
                  </small>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state compact">
              <ClipboardList size={24} aria-hidden />
              <p>No revisions recorded for this station in the fixture world.</p>
            </div>
          )}
        </div>
      )}

      {tab === 'details' && (
        <div className="site-information">
          <dl>
            <div>
              <dt>Measurement station</dt>
              <dd>{station.id}</dd>
            </div>
            <div>
              <dt>External ID</dt>
              <dd>{station.externalId}</dd>
            </div>
            <div>
              <dt>Distribution system</dt>
              <dd>{station.systemName}</dd>
            </div>
            <div>
              <dt>Site type</dt>
              <dd>{station.siteTypeId}</dd>
            </div>
            <div>
              <dt>Coordinates · WGS84</dt>
              <dd>
                {station.latitude.toFixed(4)}, {station.longitude.toFixed(4)} (lat, lon)
              </dd>
            </div>
            <div>
              <dt>Elevation</dt>
              <dd>{station.elevationFt.toFixed(0)} ft</dd>
            </div>
            {stream !== undefined && (
              <>
                <div>
                  <dt>Discharge valid range</dt>
                  <dd>
                    {stream.validRangeMin}–{stream.validRangeMax} {stream.unitId}
                  </dd>
                </div>
                <div>
                  <dt>Cadence</dt>
                  <dd>{stream.cadenceMinutes >= 1440 ? `${stream.cadenceMinutes / 1440} day(s)` : `${stream.cadenceMinutes} min`}</dd>
                </div>
                {stream.deviceDeployments.length > 0 && (
                  <div>
                    <dt>Device deployments</dt>
                    <dd>
                      {stream.deviceDeployments
                        .map((dep) => `${dep.model} (${dep.serial}) ${dep.removedAt === null ? 'current' : `removed ${dep.removedAt.slice(0, 10)}`}`)
                        .join('; ')}
                    </dd>
                  </div>
                )}
                {stream.ratingCurvePeriods.length > 0 && (
                  <div>
                    <dt>Rating curves</dt>
                    <dd>{stream.ratingCurvePeriods.map((curve) => `${curve.id} (${curve.validFrom.slice(0, 10)} → ${curve.validTo?.slice(0, 10) ?? 'open'})`).join('; ')}</dd>
                  </div>
                )}
              </>
            )}
            <div>
              <dt>Provenance</dt>
              <dd>
                Synthetic fixture {FIXTURE_SEED} · demonstration only
              </dd>
            </div>
          </dl>
          <div className="information-note">
            <Database size={22} aria-hidden />
            <h3>One view of water data</h3>
            <p>
              Maps use the GeoLibre layer engine with MapLibre GL JS. Live mapping, charts and permissions will connect through the proposed authenticated
              gateway; no live NeoServer or database is connected.
            </p>
            {station.internal !== null ? (
              <div className="internal-block">
                <h4>
                  <Lock size={14} aria-hidden /> Restricted operational details (demo projection: engineer/steward scope)
                </h4>
                <dl>
                  <div>
                    <dt>Gate code</dt>
                    <dd>{station.internal.gateCode}</dd>
                  </div>
                  <div>
                    <dt>Wiring notes</dt>
                    <dd>{station.internal.wiringNotes}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className="internal-denied">
                <Lock size={14} aria-hidden /> Restricted operational details (gate codes, wiring notes) are not part of this persona's demo projection. Real
                enforcement is server-side policy (WD-004).
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Stewardship() {
  const staffed = ['principal-fatima-engineer', 'principal-priya-engineer', 'principal-cody-commissioner', 'principal-ana-deputy'];
  return (
    <div className="admin-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Assignments</h2>
            <span>Entitlement scopes from the fixture principals · editing arrives with WD-004 server policy</span>
          </div>
          <Users size={20} aria-hidden />
        </div>
        <div className="assignment-list">
          {staffed.map((principalId) => {
            const grants = activeEntitlements(principalId);
            const grant = grants[0];
            const principalNameValue = principalName(principalId);
            return (
              <div className="assignment" key={principalId}>
                <div className="avatar" aria-hidden>
                  {principalNameValue
                    .split(' ')
                    .map((part) => part[0])
                    .join('')
                    .slice(0, 2)}
                </div>
                <div>
                  <strong>{principalNameValue}</strong>
                  <span>
                    {grant ? `${grant.role} · ${grant.scopeType === 'statewide' ? 'statewide' : systemName(grant.scopeId ?? '')}` : 'no active grant'}
                    {grant?.expiresAt !== null && grant !== undefined && grant.expiresAt !== null ? ` · expires ${grant.expiresAt.slice(0, 10)}` : ''}
                  </span>
                </div>
                <span className={`access-pill ${grant ? 'public' : 'assigned'}`}>{grant ? 'Active at fixture clock' : 'Inactive'}</span>
              </div>
            );
          })}
        </div>
        <div className="assignment-list">
          {[...organizationById.values()].map((org) => (
            <div className="assignment" key={org.id}>
              <div className="avatar" aria-hidden>
                ORG
              </div>
              <div>
                <strong>{org.name}</strong>
                <span>{org.description}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Vocabulary & connection health</h2>
            <span>Steward-managed universal vocabulary (FR-012) · illustrative ingestion status</span>
          </div>
          <FlaskConical size={20} aria-hidden />
        </div>
        <dl className="vocab-grid">
          <div>
            <dt>Observed properties</dt>
            <dd>{vocabulary.observedProperties.map((prop) => prop.name).join(' · ')}</dd>
          </div>
          <div>
            <dt>Units</dt>
            <dd>{vocabulary.units.map((unit) => unit.name).join(' · ')}</dd>
          </div>
          <div>
            <dt>Qualifiers</dt>
            <dd>{vocabulary.qualifiers.map((qualifier) => qualifier.name).join(' · ')}</dd>
          </div>
          <div>
            <dt>Processing levels</dt>
            <dd>{vocabulary.processingLevels.map((level) => level.name).join(' · ')}</dd>
          </div>
        </dl>
        <div className="connection">
          <div>
            <strong>DWRi Telemetry Network</strong>
            <span>Telemetry provider · fixture seed</span>
          </div>
          <span className="status-indicator tone-good">
            <span className="indicator-shape" aria-hidden>
              ●
            </span>
            Sample
          </span>
        </div>
        <div className="connection">
          <div>
            <strong>Cooperator Manual Measurement Program</strong>
            <span>Manual provider · fixture seed</span>
          </div>
          <span className="status-indicator tone-neutral">
            <span className="indicator-shape" aria-hidden>
              ■
            </span>
            Sample
          </span>
        </div>
        <div className="admin-note">
          Connection repair, QC scheduling and notification delivery require the ingestion platform integration. Assignment editing, credential configuration
          and vocabulary changes are server-side (WD-004) — this console is read-only synthetic data.
        </div>
      </section>
    </div>
  );
}

export default App;
