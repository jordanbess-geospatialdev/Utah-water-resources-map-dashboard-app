# GeoLibre and Google Cloud integration findings

Research date: October 20, 2026. Links point to primary sources. Decisions below are proposed for the Utah water dashboard; upstream `main` is mutable and is not an implementation version pin.

## Verified GeoLibre integration surfaces

GeoLibre is a React and TypeScript application with MapLibre GL JS as its default renderer. It has an npm workspaces monorepo. The browser UI is built from the `geolibre-desktop` Vite application in `apps/geolibre-desktop`; the name does not mean the web build requires Tauri. Root scripts run that workspace. The source snapshot lists root version `3.4.0` and Node `>=22`. [Root package manifest](https://raw.githubusercontent.com/opengeos/GeoLibre/main/package.json)

The app imports `@geolibre/core`, `@geolibre/map`, `@geolibre/plugins`, `@geolibre/ui`, and `@geolibre/embed`. Its dependency declarations include React, MapLibre, Auth0, and Clerk. A dependency declaration alone does not establish that an application authorization policy exists. [Application manifest](https://raw.githubusercontent.com/opengeos/GeoLibre/main/apps/geolibre-desktop/package.json)

| Surface | Verified purpose | Dashboard implication |
| --- | --- | --- |
| `@geolibre/core` | Types, project schema, Zustand store | Reuse domain layer types when integrating in the monorepo. |
| `@geolibre/map` | Renderer lifecycles, layer sync, styling, selection | Use the headless package in a custom role-based water UI. |
| `@geolibre/ui` | Shared UI primitives | Reuse selectively where they fit the persona design. |
| `@geolibre/plugins` | Plugin interfaces and built-in plugins | A water workflow can become a plugin in a full GeoLibre deployment. |
| `@geolibre/embed` | Typed iframe controller | Alternative for a separately hosted full GIS workspace. |

The package responsibilities and engine-neutral layer model are documented in [GeoLibre architecture](https://raw.githubusercontent.com/opengeos/GeoLibre/main/docs/architecture.md). Package presence must not be represented as an invented generic `<GeoLibre>` React component.

### Preferred prototype seam

The official headless package documents this integration:

```ts
import maplibregl from 'maplibre-gl';
import { createLayerSync } from '@geolibre/map';

const map = new maplibregl.Map({ container, style });
const sync = createLayerSync(map);
map.on('load', () => sync.sync(layers));
// On teardown: sync.dispose(); map.remove();
```

This is actual GeoLibre reuse in a purpose-built dashboard. It is an appropriate first slice when the product needs five focused persona experiences rather than all desktop GIS menus. The headless API handles loading, layer synchronization, and styling without the full React shell. [Headless package README](https://raw.githubusercontent.com/opengeos/GeoLibre/main/packages/map/README.md)

`createLayerSync(map)` accepts a complete `GeoLibreLayer[]` in bottom-to-top order. It supplies `sync(layers)` and `dispose()`. Reapply the layer list after a style reload and dispose before removing the map. Keep domain selection and network state in the dashboard; avoid two owners independently mutating the same managed layer. [Headless implementation](https://raw.githubusercontent.com/opengeos/GeoLibre/main/packages/map/src/headless.ts)

`GeoLibreLayer` requires `id`, `name`, `type`, `source`, `visible`, `opacity`, `style`, and `metadata`; `geojson` is optional. It also has optional capabilities. The schema is more than a MapLibre source object. The prototype adapter must construct the actual GeoLibre shape and verify it against the installed package, rather than pass arbitrary objects. UI capabilities are useful for rendering but do not grant server access. [GeoLibre types](https://raw.githubusercontent.com/opengeos/GeoLibre/main/packages/core/src/types.ts)

### Full GeoLibre application alternative

A water plugin can implement `activate(app)` and `deactivate(app)` with `engines: ['maplibre']`. The app API includes `addGeoJsonLayer`, `addTileLayer`, `addWmsLayer`, viewport access, and selection events. This makes a plugin a plausible future home for analyst tools and synchronized attribute panels. The API is a real extension contract, but the water entitlement service and NeoServer adapter still need implementation. [Plugin API](https://raw.githubusercontent.com/opengeos/GeoLibre/main/docs/plugin-api.md)

For a full GIS iframe, `@geolibre/embed` provides `connect(iframe, {origin})`, then methods including `setView`, `setLayerVisibility`, `addData`, and selection events. Runtime control is opt-in: self-host with an exact `GEOLIBRE_EMBED_ORIGINS` allowlist, or build with `VITE_GEOLIBRE_EMBED_ORIGINS`. The public hosted viewer does not enable that allowlist. [Embed client README](https://raw.githubusercontent.com/opengeos/GeoLibre/main/packages/embed/README.md)

## Authentication and NeoServer access design

Serve the portal, feature gateway, tiles, and project files under one HTTPS origin. This allows a session cookie scoped to `Path=/` to reach service requests, including MapLibre tile requests, and avoids cross-origin cookie/CORS complications. Keep NeoServer service credentials behind the gateway. GeoLibre's self-hosting guide explains the same-origin model; its GeoLens example is an example architecture, not a requirement to add GeoLens to this project. [Self-hosting guide](https://raw.githubusercontent.com/opengeos/GeoLibre/main/docs/self-hosting.md)

Proposed routing:

```text
https://water.example.gov/             Portal and role-based UI
https://water.example.gov/api/         Session, entitlements, charts, workflow
https://water.example.gov/geo/         Authorized proxy to NeoServer
```

GeoLibre's optional Basic Auth is one shared credential. The Auth0/Clerk client gate controls access to the interface, while sensitive upstream services require server authorization on each request. Consequently, implement institutional SSO and water-specific entitlements at the BFF/gateway; do not equate a hidden button or a GeoLibre capability flag with object authorization. [Getting started authentication guidance](https://raw.githubusercontent.com/opengeos/GeoLibre/main/docs/getting-started.md)

Proposed NeoServer adapter responsibilities: translate the authorized catalog to GeoLibre layers; use XYZ MVT for broad station/context rendering, bounded GeoJSON for detail/selection, and raster sources for WMS. Map-visible feature attributes must be a safe subset because PBF contents can be decoded by the browser. WFS can remain a compatibility interface rather than the default application query protocol. These are project design choices, not claims about automatic GeoLibre/NeoServer integration.

## Google Cloud PostgreSQL and TimescaleDB decision

Google's Cloud SQL documentation says only its supported extensions can be installed and that custom extensions cannot be added. PostGIS is supported. TimescaleDB is absent from the current supported-extension list, so the design must not assume `CREATE EXTENSION timescaledb` will work on Cloud SQL. First inventory the existing service and run `SELECT extname, extversion FROM pg_extension` with approved read-only access. [Cloud SQL extension policy and list](https://docs.cloud.google.com/sql/docs/postgres/extensions)

| Existing database reality | Proposed response |
| --- | --- |
| Self-managed PostgreSQL with PostGIS and TimescaleDB on GCP | Connect NeoServer to approved read-only views; retain the extension and existing operational ownership. |
| Google Cloud SQL PostgreSQL with PostGIS | Use PostgreSQL partitioning/materialized summaries for the first integration; do not promise TimescaleDB. |
| TimescaleDB is a hard requirement but the existing instance is Cloud SQL | Select and validate a separate compatible managed service or self-managed PostgreSQL deployment on GCP; budget replication, HA, backup, and extension operations before migration. |

Timescale documents self-hosted installation from source or container and identifies production needs including backups/PITR, replication, pooling, monitoring, and safe upgrades. A GCP VM or managed Kubernetes deployment is an architectural option, not a turnkey production guarantee. [Timescale self-hosted installation](https://docs.timescale.com/self-hosted/latest/install/?gi=f29b51a51751)

For containerized NeoServer and a BFF on Cloud Run, Direct VPC egress can reach private-IP VM/database resources and is Google's recommended alternative to a Serverless VPC Access connector. Apply firewall rules and bound connection pools to database capacity. [Cloud Run VPC comparison](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc)

If the approved database is Cloud SQL, Google's Cloud Run connection guide covers Cloud SQL Auth Proxy/connection configuration and private-IP access. Keep database and application services in the same region where possible. The application never connects directly from the browser to PostgreSQL. [Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

## Version and proof requirements

The inspected upstream sources are mutable and browser caches returned different dates and package versions. No exact current commit SHA was reliably resolved. Record the full reviewed commit SHA, npm lockfile integrity values, resolved MapLibre version, and NeoServer image digest during implementation; do not use `main`, wildcard workspace versions, or Docker `latest` as production pins.

Run one integration spike before committing to the delivery estimate: load a permitted NeoServer MVT layer through the same-origin gateway, decode its properties, select a station, retrieve bounded authorized GeoJSON, then load its chart series. Repeat with a denied role, another region, a revoked session, and a changed WMS extent. Demonstrate that no hidden attribute, station, cached tile, or export crosses the permission boundary.

No OGC SensorThings component is required for this viewer path. GeoJSON can come from OGC API Features/WFS or the application API. Introduce SensorThings only if a confirmed upstream/downstream interoperability requirement demands its entity model or API.
