# NeoServer integration findings

Reviewed 20 October 2026. The upstream README identifies current version 0.3.0. These findings use upstream `main` documentation; qualification must pin an image digest and corresponding source revision before implementation. The supplied neoserver.cloud pages did not load in the research browser; equivalent upstream documentation was available.

## Recommended boundary

Use NeoServer as the curated spatial publication service. Use a dashboard backend for identity entitlements, owner-specific records, time-series aggregation, stewardship review, publication workflows and audit. These are proposed application responsibilities. Do not interpret NeoServer workspace roles as the dashboard's business personas.

## Verified capabilities and application implications

| Capability | Verified behavior | Implication for this dashboard |
| --- | --- | --- |
| PostgreSQL/PostGIS | Network datasource; discover geometry tables and views; SELECT-only SQL views | Connect to the existing Google Cloud PostgreSQL endpoint; confirm network and extension deployment separately |
| OGC API Features | Collection and paged item endpoints; README advertises bbox, temporal, CQL2, properties and sorting | Preferred bounded GeoJSON discovery/detail transport; qualify exact filters against installed OpenAPI |
| OGC API Tiles | MVT, map tiles, TileJSON, WebMercatorQuad and WorldCRS84Quad | Use MVT for overview geometry, then fetch authorized feature details |
| WFS | Read operations plus PostGIS transactions and locks | Support required GIS interoperability; dashboard mutations should use domain APIs |
| WMS | 1.3.0 GetMap, GetFeatureInfo, capabilities and legend | Use raster overlays when server portrayal is needed |
| Identity | OIDC, stored API keys, self-signed JWTs and console sessions | Prefer enterprise identity and server-held scoped credentials |
| Authorization | Workspace role and layer visibility controls | Does not establish owner-level record entitlement |
| Deployment | Single active process per encrypted catalog store | Use a stateful single-node deployment and tested recovery |

The README is the source for the aggregate protocol inventory: [NeoServer README](https://github.com/tobilg/neoserver). Runtime capabilities remain authoritative.

## Authentication and authorization

Built-in roles are global `super_admin` and workspace `admin`, `editor`, `viewer`. An editor can modify layer/style management records and perform WFS writes/locks. Stewardship authority should therefore stay in the dashboard backend rather than automatically granting editor. Service `public` controls anonymous admission; layer `public` and `allowed_roles` control visibility. Empty allowed roles permits any caller with service access. Layer restrictions apply to listings, feature reads, feature info, maps and tiles. A disallowed direct layer request is hidden.

OIDC verifies issuer, audience, signature, expiry and configured scopes. Claim mappings grant workspace roles. Additional operation policies are additive. Query-string API keys default off. `Auth.Enabled=false` does not disable built-in authentication or make private services public. Configure HTTPS, trusted proxy CIDRs and narrow CORS. Never embed privileged or broad shared keys in browser bundles. The documentation does not establish JWT-to-database session identity or request-specific row authorization. [Authentication and authorization](https://github.com/tobilg/neoserver/blob/main/docs/authentication.md)

## Data publication and owner isolation

PostGIS `connection_info` uses `host`, `port`, `database`, `user` (not `username`), `password`, `sslmode`, `schemas`. The example specifies `sslmode=require`; certificate verification and any Cloud SQL proxy arrangement need target-environment qualification. `Datasource.DatabaseHosts` restricts database endpoints workspace administrators may introduce. Grant the map datasource SELECT only over approved publication views, with no raw-observation or ownership-table access.

SQL-view layers accept SELECT queries, remain read-only and require a stable unique non-null feature ID. Item lookup respects the authored view. Static publication views can exclude sensitive rows/columns; they do not imply a per-request user identity. [Data sources and SQL views](https://github.com/tobilg/neoserver/blob/main/docs/data-sources.md)

Proposed isolation: publish sanitized public views and a small number of approved internal cohorts; serve owner-specific features through authenticated backend queries. Client `owner_id`, `region_id`, bbox or CQL filters cannot establish authorization. PostgreSQL RLS would require independently verified transaction-scoped identity propagation and a role without bypass privileges; it must not be assumed for a shared NeoServer pool.

## Documented request shapes

Examples below use illustrative dashboard collection names; those names are proposed, not existing server resources. Prepend any configured server base path.

```text
# OGC API Features, backed by the API-first tutorial
GET /workspaces/water-public/ogc/collections
GET /workspaces/water-public/ogc/collections/stations/items?limit=100

# OGC API Tiles
GET /workspaces/water-public/ogc-tiles/collections/stations/tilejson.json
GET /workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}

# WFS GeoJSON
GET /workspaces/water-public/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=stations&COUNT=100&OUTPUTFORMAT=application/json

# WMS raster in the MapLibre display projection
GET /workspaces/water-public/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=basins&STYLES=&CRS=EPSG:3857&BBOX={projected_bbox}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true
```

Collection/item paths are demonstrated in the [API-first tutorial](https://github.com/tobilg/neoserver/blob/main/docs/getting-started.md). The dedicated Features document could not be fetched in this session; exact CQL2 and datetime parameter behavior requires installed-server OpenAPI and contract tests.

Tile paths use matrix/row/column, equivalent to **z/y/x**, not an assumed z/x/y layout. TileJSON advertises its actual templates and MVT source layers. A MapLibre vector source can consume those templates; choose the reported `vector_layers` ID as `source-layer`. Avoid inventing a `.pbf` suffix. NeoServer supports both map tiles and MVT but group/coverage tiles are rendered images. [OGC API Tiles](https://github.com/tobilg/neoserver/blob/main/docs/ogc-api-tiles.md)

WMS 1.3.0 EPSG:4326 uses latitude/longitude bbox order; CRS:84 uses longitude/latitude. Prefer EPSG:3857 for ordinary MapLibre raster tiles. GetFeatureInfo requires a visible queryable layer. [WMS](https://github.com/tobilg/neoserver/blob/main/docs/wms.md)

WFS accepts KVP GET and XML POST. Default feature output is GML; request GeoJSON explicitly. PostGIS writes require source database write grants. SQL-view layers cannot be written or locked. Keep `WFS.AllowAnonymousMutations=false`. NeoServer's persisted feature-version metadata is not content history and cannot replace stewardship audit history. [WFS](https://github.com/tobilg/neoserver/blob/main/docs/wfs.md)

## Caching and operations

External database writes do not invoke NeoServer's WFS cache barrier. After publication changes committed by the application or ingestion pipeline, refresh/truncate affected feature/tile caches through a controlled job. Set a data revision, invalidate server entries, and change the client cache revision together. Durable tile cache supports filesystem or S3-compatible storage; native Google Cloud Storage support is not established. Treat any GCS interoperability mode as a separate qualification. Avoid shared caching of owner-specific data. [Persistent tile caching](https://github.com/tobilg/neoserver/blob/main/docs/tile-cache.md)

Set paging, maximum offset, database pool, statement timeout, tile feature/vertex/byte limits and rendering queues before load testing. Exact counts may time out and be omitted; clients must not require `numberMatched`. OpenTelemetry exports traces/cache/audit metrics. Any audit `events_lost` increment merits an operator alert. Performance ceilings are controls, not benchmark evidence. [Performance and observability](https://github.com/tobilg/neoserver/blob/main/docs/performance.md)

Persist the encrypted catalog and required auxiliary state. Exactly one active node may own one store; a second process fails on file locks. Administration CLI access can require the server to stop. Backup must quiesce writers and copy coordinated state. The store encryption key cannot be rotated; compromise requires reinitialization and replacement of stored credentials. Do not put a mutable shared store behind ordinary horizontal autoscaling. [Deployment](https://github.com/tobilg/neoserver/blob/main/docs/deployment.md)

## Required qualification gates

1. Pin NeoServer release, image digest and source revision; capture actual OpenAPI, conformance and GetCapabilities.
2. Prove PostgreSQL TLS/network access and SELECT-only publication privileges against the actual Google Cloud product.
3. Exercise anonymous/public, permitted cohort, denied cohort, expired identity, malformed headers and direct protocol URLs for each layer.
4. Prove no private properties are present in MVT bytes, capabilities, queryables, feature info, exports or cache responses.
5. Verify map position, row/column order, projection, source-layer ID and WMS axis order using known Utah control points.
6. Test cache freshness after external data updates, failure/retry and restart; prove permission revocation cannot expose old cached responses.
7. Demonstrate store backup/restore, single-writer fencing and recovery with secrets supplied through the deployment's secret manager.

No SensorThings dependency is needed to request GeoJSON. Add a client adapter only if an existing external source contract specifically requires SensorThings; do not introduce a new ingestion platform for the dashboard.
