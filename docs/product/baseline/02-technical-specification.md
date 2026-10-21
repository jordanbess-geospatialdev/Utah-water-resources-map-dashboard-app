# Utah Water Measurement Dashboard Technical Specification

Version 1.0 | 21 October 2026 | Proposed implementation baseline

Build a browser application around GeoLibre's MapLibre GL JS integration, use NeoServer to publish approved spatial services, and use a dedicated application backend to enforce water-program permissions and manage measurement workflows. PostgreSQL/PostGIS remains the data system of record. TimescaleDB is conditional on the actual Google Cloud database product and installed extensions.

This specification implements the [product requirements](01-product-requirements.md). Requirement identifiers and source page references are maintained in [requirements traceability](requirements-traceability.csv). Interfaces below are proposed application contracts unless explicitly identified as upstream NeoServer interfaces. They are not claims that a production API already exists.

## Application boundaries

| Component | Implementation baseline | Responsibility |
| --- | --- | --- |
| Dashboard | React, TypeScript, Vite, GeoLibre headless map package, MapLibre GL JS | Persona navigation, filters, maps, chart/table interaction, accessible forms |
| Application backend or BFF | Proposed TypeScript service using Fastify, schema validation, and parameterized PostgreSQL queries | Session, entitlements, time series, revisions, imports, exports, audit, notification preferences |
| Spatial gateway | Same-origin application route or reverse proxy with an explicit route allowlist | Public/cohort catalog, tiles, features and WMS; no general-purpose upstream proxy |
| NeoServer | Qualified release and immutable image digest | PostGIS publication views through OGC API Features, OGC API Tiles, WFS and WMS |
| Database | Existing PostgreSQL/PostGIS; qualified TimescaleDB if available | Metadata, observations, revisions, assignments and publication views |
| Workers | Proposed asynchronous application workers | Imports, reports, QC evaluations, notification delivery and cache invalidation |
| Object storage | Proposed private Google Cloud Storage buckets | Attachments and generated reports, with authorization on download |

The prototype in `../prototype` demonstrates a subset with synthetic fixtures. Its role selector is a demonstration control, not enterprise authentication. Read its README and verification report for implemented behavior.

## Browser design and GeoLibre integration

Use the actual `@geolibre/map` headless integration in a custom water dashboard. The upstream package documents `createLayerSync(map)`, `sync(layers)`, and `dispose()`. Its layer model comes from `@geolibre/core`; do not treat GeoLibre as an undocumented generic React widget. [GeoLibre headless package](https://github.com/opengeos/GeoLibre/blob/main/packages/map/README.md)

An adapter constructs complete GeoLibre layers from an authorized catalog. Each layer has a stable ID, name, type, source, visibility, opacity, style and metadata. The UI owns selection and filters; GeoLibre owns synchronization for its managed layers. Reapply layers after a basemap style reload, dispose synchronization before destroying the map, and reject stale network responses after a filter or persona change. Keep the selected site, map highlight, chart and table row consistent.

Pin compatible package versions in the lockfile, use the tested MapLibre renderer, and record the resolved GeoLibre version. A later full GeoLibre workspace can host a water plugin; it must use the same entitlement and domain services. Optional desktop engines, unrestricted remote data loading, arbitrary GIS analysis and user-supplied SQL are outside the first portal release.

### Screens and interaction states

| View | Required behavior |
| --- | --- |
| Public overview | Useful initial summary, public sites, visible data freshness, manual filters, map/table parity and shareable view |
| Assigned work | Commissioner/engineer sites within explicit assignment scope; separate public browse tab |
| Site detail | Provider, units, source type, latest value/time/quality; chart, table, raw versus best-available selector and public attachments |
| Measurement entry | Mobile form and bulk paste preview; units/time zone/validation before commit; row-level error feedback |
| QA review | Select point/interval; compare original and revisions; required qualifier/reason; show actor/time/history |
| Engineer field work | Equipment and inspections, internal attachments, visit notes, new stream on device configuration change |
| Steward console | Users, assignments, universal vocabulary, connection health and QC configuration |
| My Sites | Favorites and notification preferences; favorites never create edit entitlement |
| Research access | Filtered download, metadata dictionary, processing-level selection, scoped token lifecycle |
| Public policy summary | Measured/estimated, telemetry and review coverage; denominators, exclusions, time range and provenance visible |

Every network view needs loading, empty, partial, stale, denied, error and retry states. A map failure must leave the accessible table usable. Do not show a fabricated zero for missing or late readings. Status must use text or shape as well as color. Target keyboard operation, focus return after dialogs, readable touch controls, and WCAG 2.2 AA as a proposed acceptance baseline. Source browser coverage is Chrome, Edge, Safari and Firefox (requirements PDF physical page 13).

### Filters and sharing

Use one typed filter object across map, table, summaries, chart requests and exports. It includes distribution system/group/subgroup, site type, telemetry tri-state, provider, observed property, structure/material/size, water source, device, measurement/observation/method types, data date range, site status, state, time step and statistic. Add processing level, dataset type, installation range and seasonality from persona sections. The PDF's item 21 is an open `Others?` placeholder rather than a defined field.

Canonicalize multi-value fields in stable order and serialize non-sensitive filters plus map center/zoom to versioned URLs. Never place credentials, internal notes, entitlement grants or private record payloads in links. A recipient receives only data their own current session can access. Bookmarking another user's view cannot reproduce their permissions.

## Identity and application permissions

Integrate the approved institutional identity provider using OIDC Authorization Code with PKCE. The backend validates issuer, audience, signature and expiry, then maps immutable subject IDs to application assignments. Browser sessions use Secure, HttpOnly, SameSite cookies; require CSRF protection and origin checks on mutations. Store no service secrets in browser code or URLs. Public browsing works without a login. Non-browser researcher credentials are scoped and revocable, with rate limits independent of interactive sessions.

Authorization is evaluated on every endpoint, queued job, download and spatial request:

```text
allow_public_read = explicit_public_read_action
                    AND object_is_currently_published
                    AND fields_are_in_public_projection

allow_protected = authenticated AND principal_is_active
                  AND role_grants_requested_action
                  AND object_is_within_current_assignment
                  AND field_visibility_allows_requested_fields
                  AND lifecycle_allows_requested_change

allow = allow_public_read OR allow_protected
```

Resolve system/site/organization membership on the server. Do not trust body `actorId`, browser role switches, submitted owner IDs, CQL filters or hidden buttons. A site edit that moves a site to another system must validate both current and destination scope; ordinary commissioners cannot assign themselves sites. Concurrent role changes revoke affected access and invalidate entitlement caches. Every protected request checks the authoritative assignment version or revocation state, so a stale cache cannot authorize access during invalidation propagation. Multi-role users receive action-specific scoped grants; a public favorite does not extend a management role.

### Proposed authorization matrix

`Assigned` means an explicit current site, system or organization grant. `Public` means the separately approved publication projection. All grants below require stakeholder ratification before production.

| Action | Donna public | Wiley user | Sarah researcher | Cody commissioner/deputy | Fatima engineer | Diego steward |
| --- | --- | --- | --- | --- | --- | --- |
| Browse published stations/series | Public | Public | Public | Public | Public | Public |
| Save favorites and personal alerts | Login needed | Own preferences | Own preferences | Own preferences | Own preferences | Own preferences |
| View restricted operational details | No | Assigned organization data only | Explicit approved dataset grant | Assigned | Assigned | Statewide administration |
| Enter readings and revise best available | No | No by default | No | Assigned | Assigned | Statewide, audited |
| Change site metadata/photos | No | No by default | No | Assigned permitted fields | Assigned permitted fields | Statewide |
| Create sites/streams | No | No | No | Separate explicit grant | Assigned systems | Statewide |
| Review data and change processing status | No | No | No | Assigned, permitted transition | Assigned, permitted transition | Statewide |
| Change universal metadata/systems | No | No | No | No | No | Yes |
| Manage application users/assignments | No | No | No | No | No | Yes |
| Configure ingestion provider credentials | No | No | No | No | Request/delegation only | Yes |
| Exclude erroneous original readings | No | No | No | No | Automation capability only, proposed review | Explicit governance capability |
| Generate research API credential | No | Optional scoped account | Approved scopes | Optional scoped account | Optional scoped account | Own scope or administration |
| Water supplier reporting/boundary proposals | No | Assigned supplier, later module | No | No | No by default | Separate Water Use Manager role |

A deputy is scoped through an explicit delegation with effective and expiry dates, not automatically statewide. Field, regional, automation and modeler are capability profiles under the engineer family; modelers do not automatically gain correction or hardware privileges. Diego's universal dashboard administration does not grant cloud infrastructure ownership or NeoServer super-admin.

NeoServer's global `super_admin` and workspace `admin`, `editor`, `viewer` roles are separate. Editor includes service-management and WFS mutation capabilities, so do not map a business commissioner or steward straight to it. Upstream documentation describes workspace/layer rules; it does not establish principal-specific database row policies for a shared PostGIS pool. [NeoServer authentication](https://github.com/tobilg/neoserver/blob/main/docs/authentication.md)

## Measurement and metadata model

Use internal stable UUID identifiers and preserve legacy IDs in a unique provider/external-ID mapping. Preserve actor identity and name snapshot after offboarding without making the account usable. Do not use a mutable station name as a primary key.

| Entity | Key fields and invariants |
| --- | --- |
| System and group | Stable ID, hierarchy and membership history; universal vocabulary managed by steward |
| Station | Geometry in EPSG:4326, system, provider, status, site/source/structure classifications, visibility, version |
| Device deployment | Device ID, serial/model, installation/removal times, station and inspection history |
| Datastream | Station, observed property, unit, method, deployment, time zone, cadence, capacity limits and processing policy |
| Original observation | Stable logical key, stream ID, observed timestamp, source event ID, source value/unit, received timestamp, provenance and hash |
| Revision | Logical observation key, revision ID, value or exclusion, processing level, qualifiers, reason, actor, recorded time, base revision |
| Rating curve and shift | Versioned coefficients/method/unit, valid interval, deployment, approval and derived-output lineage |
| Site visit and attachment | Capture/visit time, actor, categories, visibility, object reference, retention class and integrity hash |
| QC rule and result | Versioned type/configuration, author, effective interval, run identity, violations and failure state |
| Assignment | Principal, action/capability, scoped object/system/organization, validity dates and grant audit |
| Import/export/report | Request, normalized filters, snapshot/data revision, requester, status, errors, expiration and output manifest |
| Audit event | Actor, action, object/version, time, correlation ID and structured change; secrets excluded |

### Originals and corrections

Original automated observations are not editable. Corrections append revisions to best-available values, with qualifiers and a justification; they never overwrite earlier revisions. Best available remains correctable after year end. Keep an optimistic version on revisions so concurrent edits return a conflict rather than silently overwrite.

The PDF allows automation staff to delete erroneous originals. Proposed implementation uses an authorized exclusion/tombstone with retained provenance; physical deletion requires a separately ratified retention rule. The source also requires finalized accounting to remain immutable. Model finalized accounting/report snapshots separately from the revisable measurement stream: issue a superseding report or compensating accounting entry, never rewrite a finalized transaction (PDF physical pages 22 and 42-43).

Keep observation time and recorded time separate from the first release. This supports later point-in-time reconstruction without promising the full historical query UI in MVP. Processing level and publication status are separate: a reviewed value is not automatically public, and an explicitly public provisional value remains labeled provisional.

For TimescaleDB, validate the hypertable partition and uniqueness design against the installed extension. Unique indexes must satisfy partitioning restrictions. Retain a composite logical key including observation time where needed; do not ship generic UUID-only hypertable uniqueness or foreign-key DDL without a database qualification test. A conventional PostgreSQL implementation can preserve the same API semantics.

### Numerical and temporal rules

- Store timestamps as UTC instants with the source offset/time zone retained. Display and aggregate using the configured station/program zone, usually America/Denver for Utah; user browser time must not redefine a reporting day.
- Use half-open intervals `[start, end)` and return the effective bounds. Test 23-hour and 25-hour local days, leap years, duplicate timestamps and out-of-order arrivals.
- Maintain source units and a governed canonical unit conversion. Treat flow, stage and storage as distinct dimensions. Use decimal precision and explicit rounding policies for reports.
- Integrate flow using a declared method and interval semantics. For cfs, acre-feet equal integrated cubic feet divided by 43,560. A simple rate-times-duration formula is valid only for a rate representative of that interval. Never sum rates or multiply a daily mean by 24 hours across DST without the correct interval duration.
- Exclude or explicitly estimate gaps beyond a configured threshold. Return coverage, estimated proportion and method; a missing reading is not zero. Do not interpolate an unbounded gap silently.
- Do not double-count upstream flow, downstream flow and canal delivery in policy totals. A basin summary needs defined accounting boundaries and distinct measured/estimated/computed categories.
- Define calendar year, water year and irrigation-season dates per report type with program owners. Never assume one year's meaning for all personas.

## Proposed application API

Prefix domain APIs with `/api/v1`. Publish OpenAPI and generated client types once backend implementation begins. Use cursor pagination, server-side maximum bounds, stable sorting and typed validation. A page limit is not an authorization control.

| Method and route | Purpose and authorization |
| --- | --- |
| `GET /session` | Current subject, capabilities, assignment version and server time; no upstream credential |
| `GET /catalog` | Permitted layers, property projections, revisions and transport links |
| `GET /sites` | Paged sites filtered within caller scope; public projection for anonymous requests |
| `GET /sites/{id}` | Authorized site detail with permitted fields and current version |
| `GET /streams/{id}/observations` | Bounded series with start/end, processing selector, aggregation and quality filters |
| `GET /observations/{key}/history` | Authorized revision history; redact internal reasons on public projections |
| `POST /streams/{id}/observations` | Manual entry with unit, time, method, source and idempotency key |
| `POST /observations/{key}/revisions` | Append correction/exclusion using `If-Match`, qualifier IDs and required reason |
| `POST /imports` | Create scoped staged import; file metadata and private upload link |
| `POST /imports/{id}/validate` | Preview parsing, units, timestamps, duplicates and per-row scope errors |
| `POST /imports/{id}/commit` | Commit validated version once; recheck current scope and row versions |
| `PUT /me/favorites/{siteId}` | Add favorite only if published or otherwise readable |
| `PUT /me/notification-subscriptions/{id}` | Own subscriptions with current recipient/scope validation |
| `POST /exports` and `GET /exports/{id}` | Scoped asynchronous CSV/report jobs; reauthorize on download |
| `POST /me/api-tokens` and `DELETE /me/api-tokens/{id}` | Issue/revoke scoped credentials; show secret once, hash at rest |
| `PATCH /sites/{id}` | Allowed metadata fields only, with version conflict check and audit |
| `POST /sites/{id}/visits` | Assigned field documentation and controlled attachment visibility |
| `GET /admin/connections` | Steward connection/task health and permission-checked deep links |
| `PUT /admin/assignments/{id}` | Steward grant/revoke with audit and entitlement invalidation |
| `POST /search/interpret` | Proposed natural-language to allowlisted structured filters, no arbitrary SQL |

Successful responses include `requestId`, effective filters, data revision and freshness where relevant. Errors use a stable code and human-readable message. Use 400/422 for malformed inputs, 401 for missing/expired identity, 403 for permitted object with forbidden operation or 404 to avoid disclosing hidden object existence, 409 for idempotency/content conflicts, 412 for stale `If-Match`, 429 with retry information and 503 for unavailable dependencies. Choose and test a consistent hidden-object policy.

CSV output includes station/stream IDs, property/unit, observation time/zone, value, processing level, qualifiers, source and revision identifiers. Neutralize spreadsheet formula injection in user-controlled text. Large exports are queued with explicit row/time limits and expiring authorized downloads. Export jobs cannot outlive a revoked permission without a new authorization check. Proxy protected downloads through the application so each new download request checks current grants; do not issue an independent reusable storage URL that bypasses revocation. Public artifacts can use separately approved cacheable URLs. Default browser responses containing private records to `Cache-Control: private, no-store`.

### Example correction contract

```http
POST /api/v1/observations/example-logical-key/revisions
If-Match: "revision-7"
Idempotency-Key: 3e2a2ca1-3164-40c3-9235-25a682f240f1
Content-Type: application/json

{
  "value": 12.4,
  "unitId": "cfs",
  "processingLevel": "reviewed",
  "qualifierIds": ["ice-affected", "interpolate"],
  "reason": "Compared with field check and documented adjacent readings."
}
```

The backend loads the observation and current revision, checks assignment and transition, and appends the revision and audit within one transaction. It derives the actor from the session. A transactional outbox requests publication cache refresh after commit. Replaying the same idempotency key with a different body is rejected.

## NeoServer and map transport

Use spatial publication views containing only approved fields. Grant the NeoServer database account SELECT on those views, without access to originals, internal notes, gate codes, contacts, ownership tables or credential tables. A private cohort service is valid only where all members may see all published features and fields in that cohort. Dynamic owner or arbitrary site assignments remain behind the BFF or a separately proven principal-aware spatial service.

| Transport | Use in the portal | Integration rule |
| --- | --- | --- |
| OGC API Tiles / MVT | Statewide station overview and large context layers | Read TileJSON; use advertised template and actual source-layer ID |
| OGC API Features / GeoJSON | Bounded station detail, selected geometry and small filtered results | Follow pagination links; validate bbox and limits; never load all historical observations as features |
| WFS 2.0 | Interoperability and compatibility GeoJSON | Explicit GeoJSON output; no anonymous mutations; dashboard writes use domain API |
| WMS 1.3.0 | Server-rendered thematic/context overlays | Raster source with EPSG:3857 bbox and required attribution |
| Domain JSON/CSV | Time series, quality history, imports, reports and ownership-specific data | BFF entitlement and temporal semantics |

Examples use illustrative workspace/layer names, not existing deployed resources:

```text
/workspaces/water-public/ogc/collections/stations/items?limit=100
/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json
/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}
/workspaces/water-public/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=stations&COUNT=100&OUTPUTFORMAT=application/json
/workspaces/water-public/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=basins&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true
```

The MVT path is matrix/row/column, or z/y/x. Do not swap x/y, add a guessed `.pbf` suffix or guess the MVT source-layer name. Do not blindly rewrite relative TileJSON links against the browser location: resolve against the trusted NeoServer service URL and map only allowlisted paths to the same-origin gateway. For WMS EPSG:4326, test latitude/longitude axis order; prefer EPSG:3857 in MapLibre. [Tiles](https://github.com/tobilg/neoserver/blob/main/docs/ogc-api-tiles.md), [WMS](https://github.com/tobilg/neoserver/blob/main/docs/wms.md), [WFS](https://github.com/tobilg/neoserver/blob/main/docs/wfs.md)

Qualify exact CQL2, datetime, properties and sorting support from the installed OpenAPI and conformance endpoints. Do not forward unrestricted filters or arbitrary upstream URLs. Station geometry tiles are not a time-series API. Features/WFS already supply GeoJSON; OGC SensorThings is not required for this path. Retain an isolated legacy adapter only if an existing provider contract requires it.

External writes by ingestion or the BFF must trigger explicit NeoServer cache refresh/truncation. Coordinate public dataset revision, cache invalidation and browser source refresh through a retryable outbox. A successful measurement commit can display `publication pending` until the map projection catches up. Sensitive responses must never use a public CDN cache; public tiles are revisioned separately. [NeoServer tile cache](https://github.com/tobilg/neoserver/blob/main/docs/tile-cache.md)

## Offline, imports, notifications and AI

Offline capture is a later field milestone, not an implicit capability of a responsive page. Use a scoped IndexedDB queue with draft UUID, actor, site, device timestamp/zone, capture time, base revision and attachment manifests. Show queued/syncing/accepted/conflict/rejected states. Revalidate identity and assignment at synchronization; revoked offline drafts must not upload. Do not silently resolve conflicting corrections. Expire and clear sensitive device data according to approved policy, account switching and logout behavior. Background sync is an enhancement; explicit retry must work on Safari and other browsers without that feature.

Bulk paste/import accepts at least a full year of ordinary daily readings per stream after validation (a proposed 366-row minimum scenario). Parse locale/time formats explicitly. Validate the whole staged batch, report row errors and duplicates, and require explicit commit; never partially save a user-visible atomic batch without reporting precisely what committed. Workers use idempotency, retry limits and dead-letter visibility.

QC tasks cover range, rate of change, persistence, missing and zero checks. Version each rule, define gaps/cadence, and record test/promote history. Isolate failures by task. Connection digests distinguish a failed provider from failed tasks, support weekday timing with Monday weekend coverage, and link to a filtered authorized task view. Program time zone and notification defaults require steward configuration; no application notification schedules were created by this specification.

Natural-language search produces a schema-valid filter proposal plus visible explanations/chips. The same filter engine runs manual and interpreted queries. It cannot create SQL, call arbitrary URLs, infer additional permissions or perform writes. Unsupported trend/release questions route to explicit future analytics tools or return a clear limitation. Evaluate a fixed utterance set for synonyms and ambiguous dates, and preserve manual correction. Voice notes/transcription are a later opt-in field feature with private storage, visible review and no unreviewed edits to official records.

## Proposed service targets and operations

These are initial acceptance targets, not measured existing performance or source requirements. Ratify them with a documented dataset, concurrency profile, network and cost envelope before contractual use.

| Target | Initial acceptance proposal |
| --- | --- |
| Useful initial public screen | p95 at most 3 seconds on the agreed field-network profile |
| Filter/detail response | p95 at most 2 seconds for bounded queries, excluding client map rendering |
| Chart response | p95 at most 2 seconds for an agreed bounded/downsampled interval |
| Public spatial freshness | New committed public metadata visible within 5 minutes; visible timestamp/revision |
| Internal revoked access | Next protected request denied using authoritative assignment version/revocation state; cache propagation cannot extend access |
| Accessibility | Agreed automated checks plus manual keyboard, chart/table and screen-reader review |
| Availability | Proposed 99.5% monthly objective for public read journeys; ingestion and notification health monitored separately |
| Recovery and retention | Establish baseline and cost before SLA; proposed RPO 1 hour/RTO 4 hours must pass restore drill; retention requires DWRi approval |

Instrument request IDs across the gateway, backend, jobs and DB. Record latency/error rates, pool saturation, lag, task failure, export queues, audit loss and cache revision lag. Redact tokens and private notes from logs and analytics. Obtain a privacy decision before session-replay analytics; mask sensitive fields and exclude administrative/field content by default.

Production acceptance requires the tests and independent review in the [AI development and testing plan](04-ai-development-and-testing.md), the decisions in the [architecture](03-architecture.md), and persona signoff against all six Figma flows. Live identity, NeoServer, PostgreSQL, reports and offline synchronization are distinct integration milestones and must be reported accurately.
