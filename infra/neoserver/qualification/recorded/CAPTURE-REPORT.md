# T-05 — Live NeoServer qualification capture report

| Field | Value |
| --- | --- |
| Executed by | qa_accessibility (ZCode qualification agent), test T-05 |
| Date | 2026-10-21 (UTC), 11:46–12:10 |
| Worktree / branch | `utah-water-dashboard-worktrees/t05-neoserver-capture`, `test/T-05-neoserver-capture`, base `a43b972` |
| Outcome | **14/14 captures at expected statuses; 13 of 14 machine checks PASS; 1 honest FAIL (MVT layer version 1, not 2 — genuine NeoServer 0.3.0 output, verified by independent decode).** Stack torn down, volumes removed. |
| Final manifest | `manifest.json` sha256 `bbf030adc74115a4901d29f7467b8d1666cf1ddf359322150fbffbd2492f1f2c` (generated 2026-10-21T12:07:01.966Z, 14 captures) |

## 1. Environment record

- Host: Windows 10.0.26100 x64, Git Bash (MSYS). Docker Engine client=29.8.2
  server=29.8.2, Docker Compose v5.6.0.
- Images pulled (`docker compose pull`, re-verified against compose pins —
  `environment-image-digests.txt`):
  - `tobilg/neoserver:0.3.0@sha256:dab746cc669d00d4dd3667cbe871ba87b0e1f3d310456284ebaee0204a05b7d0` — **matches pin**
  - `postgis/postgis:17-3.5@sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6` — **matches pin**
- Stack: `docker compose up -d` (loopback-only ports 127.0.0.1:9000, 127.0.0.1:5477).
  `environment-compose-ps.txt`, first log lines in
  `environment-neoserver-log-first-lines.log`. Store initialized via
  `docker compose run --rm neoserver init --store-path /data/neoserver.db`
  (see defect D9 — MSYS path caveat), store persisted at `/data/neoserver.db`
  in the `serverdata` volume.
- Deployment pins archived with this report: `ogc-openapi.json` (management
  OpenAPI, dumped via the image's `openapi-dump`) and `ogc-conformance.json`
  (deployed OGC API - Features conformance), both captured against the digest
  above.
- No port 5173 was touched at any time.

## 2. Configuration steps (management API)

Every request is logged as `METHOD path -> status` in
`configuration-requests.log`; credential values were never logged (the
bootstrap super_admin JWT and the viewer API key exist only in the local
throwaway environment, both destroyed at teardown).

1. `GET /ready` (anonymous) → 200.
2. `POST /api/v1/workspaces` `{name:"water-public"}` → 201.
3. `POST /api/v1/workspaces/water-public/services` PostGIS service
   `qual-postgis`, `public: true`, connection `postgis:5432/neosrv`, password
   from local `.env` → 201. (`test-connection` without a body → 400
   "invalid connection test request" — that endpoint validates a prospective
   `connection_info`, not the stored service; connectivity proven by
   `discover` → 200 instead. Probe-usage note D8.)
4. `POST …/services/qual-postgis/layers` — ONE layer, `public_id=stations`
   over `qualification.stations_public_v`, `public: true` → 201.
5. `PUT …/settings/{ogcapi,ogc-tiles,wms,wfs}` enabled → 200 (ogc-tiles
   additionally needed the nested `settings.vector_tiles.enabled=true`,
   applied in a follow-up PUT, and global env flags — defect D3).
6. Cohort workspace `water-bear-cohort` + NON-public service
   (`public: false`) + layer `stations-restricted` over
   `qualification.stations_cohort_v` → 201; ogcapi enabled → 200.
7. `POST /api/v1/workspaces/water-public/apikeys` `{role_id:"viewer"}` → 201;
   secret handed to `capture.mjs` via env `NEOSERVER_QUALIFICATION_API_KEY`
   only.
8. MVT enablement (defect D7): NeoServer 0.3.0 MVT generation requires an
   integer feature-id column; the seeded publication view has none
   (`mvt_agg_transfn: Could not find column 'id' of integer type`). Layer
   republished with a validated sql_view
   `SELECT station_id, display_name, status, geom, row_number() OVER () AS id
   FROM qualification.stations_public_v` (`id_column:"id"`) after
   `validate-sql` → 200 (`hashtext` is NOT on the sql-view function
   allowlist). `PUT layers/{id}` silently drops `sql_view` (defect D6), so the
   layer was DELETEd and re-POSTed with the sql_view.

## 3. Per-expectation verdicts

Evidence paths are relative to `infra/neoserver/qualification/recorded/`.

### 0. Release pinning
| Item | Verdict | Evidence |
| --- | --- | --- |
| `docker compose pull` confirms both digests | **PASS** | `environment-image-digests.txt` — both digests byte-identical to the compose pins |
| Deployed OpenAPI/conformance archived with image digest | **PASS** | `ogc-openapi.json`, `ogc-conformance.json` + digest in section 1 |

### 1. Tile path — matrix z/y/x (swap detection)
| Item | Verdict | Evidence |
| --- | --- | --- |
| Control tile for sta-bear-corinne computed z/y/x = 10/381/192, fetched 200 as MVT | **PASS** | console log `[capture] control tile … z10 -> matrix z/y/x = 10/381/192 (NW corner 41.771,-112.500)` (`manual-probes/t05-capture-console-run4.log`); `manifest.json` capture `mvt-tile-control-z10` 200, 129 B, `application/vnd.mapbox-vector-tile` |
| NW corner inside northern Utah; deliberate swapped request recorded and distinguishable | **PASS** | NW corner 41.771,-112.500 (northern Utah). Swapped `10/192/381` → 200 but a **17 B empty tile** (sha `396bba74…`) vs the 129 B control (sha `3bab0466…`); ~73.8 N has no Utah features — `manual-probes/probes-tiles.log`, `tile-swapped-10-192-381.pbf`, `tile-control-10-381-192.pbf` |
| No format suffix required/accepted | **PASS** | `…/10/381/192.pbf` → **400** `application/json` (error, not a tile) — `probes-tiles.log` |

### 2. MVT source-layer from the ACTUAL TileJSON
| Item | Verdict | Evidence |
| --- | --- | --- |
| `tilejson.json` contains `vector_layers[0].id` | **PASS** | `tilejson.json`: `vector_layers[0].id = "stations"` (fields: `display_name`, `station_id`, `status` only) |
| Decoded MVT layer name equals `vector_layers[0].id` | **PASS** | manifest check `decoded MVT source-layer equals TileJSON vector_layers[0].id`: `tile="stations" tilejson="stations"` |
| MVT layer version is 2 | **FAIL** (genuine server behavior) | Decoded layer `version=1` (name `stations`, extent 4096). Independently re-decoded from raw bytes (see report section 5 / D5) — not a decoder artifact. No `[Tiles]` config knob exists for the MVT layer version. |
| Record live value | recorded | `vector_layers[0].id = "stations"` — equals the collection id as deployed (public_id) |

### 3. Relative TileJSON links resolve against the TRUSTED service URL
| Item | Verdict | Evidence |
| --- | --- | --- |
| Template shape recorded (relative vs absolute) | **PASS** (absolute observed) | manifest check `tile template shape recorded`: **absolute** — `tiles[0] = http://localhost:9000/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}` (built from `NEOSRV_SERVER_URLBASE`) |
| Gateway-served TileJSON contains only same-origin paths | **N/A live** (gateway not in this stack) | Synthetic `services/geo-gateway` `tilejson.test.ts` remains the operative test. Live finding for spatial_integration: upstream returns ABSOLUTE links, so the gateway's absolute→same-origin rewrite path is the one exercised in production, not relative resolution. |

### 4. WFS — explicit GeoJSON output and axis control
| Item | Verdict | Evidence |
| --- | --- | --- |
| `OUTPUTFORMAT=application/json` honored | **PASS** | `wfs-getfeature-geojson.json` — content-type `application/json; charset=utf-8`, GeoJSON `FeatureCollection`, 3 features |
| First feature lon-first inside Utah envelope | **PASS** | manifest check `WFS GeoJSON coordinate axis control`: `coordinates [-111.8524, 41.6295]` (lon,lat; inside −114.1..−108.9 / 37.0..42.1) |
| GetCapabilities archived; Transaction never succeeds | **PASS** | `wfs-getcapabilities.xml` (12,688 B; `Transaction` IS advertised in OperationsMetadata). Live denials: POST Transaction with viewer key → **403** `forbidden: operation is not granted`; anonymous → **401** — `manual-probes/probes-paging-wfs.log`, `wfs-transaction-attempt.xml`. Gateway deny-before-upstream remains synthetic-tested. |
| BBOX SRSNAME axis behavior recorded | **PASS** (recorded) | `BBOX=-112.3,41.6,-111.8,41.8`: `SRSNAME=CRS:84` → 3 features; `SRSNAME=urn:ogc:def:crs:EPSG::4326` → 3 features, identical lon,lat interpretation — the server treats BOTH as lon,lat (no urn lat,lon reinterpretation trap). Gateway's `CRS:84` choice is safe. `wfs-bbox-crs84.json`, `wfs-bbox-urn4326.json` |

### 5. WMS — CRS axis verified with Utah control coordinates
| Item | Verdict | Evidence |
| --- | --- | --- |
| `CRS=EPSG:3857` GetMap returns a non-empty image | **PASS** (after capture-script defect fix D4) | `wms-getmap-epsg3857.png` 200 `image/png`, 256×256, **345 non-transparent pixels** (decoded; `probes-tiles.log`). BBOX meters recorded in manifest. The original 0.5°-margin BBOX excluded every seeded station (transparent PNG) — see D4. |
| EPSG:4326 axis probe (lat,lon vs lon,lat) | **PASS** | `BBOX=37,-114.1,42,-108.9` (lat,lon) → 1988 B, **339 non-transparent pixels** (Utah stations rendered). `BBOX=-114.1,37,-108.9,42` (lon,lat) → 820 B, **0 non-transparent pixels**, byte-identical in size to the empty Atlantic baseline. WMS 1.3.0 EPSG:4326 is latitude,longitude — confirmed; MapLibre routing stays on EPSG:3857. `wms-getmap-4326-latlon.png`, `wms-getmap-4326-lonlat.png`, `wms-getmap-empty-baseline.png` |
| (baseline T-05 row) WMS GetFeatureInfo | **PASS** (extra probe) | `I=94&J=19` (computed pixel of sta-bear-corinne) → 200 `text/plain`: `station_id: sta-bear-corinne`, publication fields only. `application/geojson` INFO_FORMAT → 400 `Invalid INFO_FORMAT` (advertised formats are text/plain, text/html, utfgrid, …). `wms-getfeatureinfo.txt`, `wms-getfeatureinfo-geojson.json` |

### 6. Paging followed
| Item | Verdict | Evidence |
| --- | --- | --- |
| Items `next` links followed | **PASS** | With `limit=100` and 3 features no `next` exists (manifest: `items paging followed to page 1`). Manual probe with `limit=1` followed `next` for 3 pages (`?limit=1&offset=1`, `&offset=2`), `numberMatched=3`, page 3 has no `next` — `manual-probes/probes-paging-wfs.log`, `paging-page{1,2,3}.json` |

### 7. Denied cohort reveals no private content (T-08)
| Item | Verdict | Evidence |
| --- | --- | --- |
| Cohort layer refuses uncredentialed read (401/403) | **PASS** | manifest `negative-cohort-without-credential` → **401** (`negative-cohort-without-credential.json`) |
| Canary absent from every captured artifact | **PASS** | In-script canary checks all `ok` (every JSON/XML capture), plus an extended sweep scanning ALL 39 recorded files INCLUDING binary artifacts (.pbf/.png): **zero occurrences of `SYNTHETIC-NEVER-PUBLISH`, `internal note`, `gate_code` in any server-served byte**. The only matches are the harness's own check-label text and this checklist/report naming the strings — contexts proven in `canary-sweep.log`. |
| Manual gateway cache/privacy probe | **N/A live** | Gateway not part of this stack; synthetic gateway suite already covers cohort `private, no-store` policy. |

### 8. External-write cache refresh gate (T-08, ADR-10)
| Item | Verdict | Evidence |
| --- | --- | --- |
| Stale tile serves until explicit refresh, then new revision serves | **PASS** | `manual-probes/probe-cache-refresh.log`: tile cache enabled; warm tile sha16 `3bab0466…` (129 B); EXTERNAL `psql UPDATE … display_name += ' [T05-REV2]'` at 12:06:50.840Z; fetch 9 ms later → same sha16, `rev2-string-in-tile=false` (**no spontaneous invalidation**); `POST /api/v1/workspaces/water-public/cache/clear` → 200; next fetch → sha16 `2ddb64ab…` (141 B), `[T05-REV2]` present in tile bytes. Timing recorded per step. Data restored and cache cleared/disabled afterwards. |

### 9. One-active-store ownership gate (T-14, ADR-09)
| Item | Verdict | Evidence |
| --- | --- | --- |
| Second writer on the same `serverdata` volume fails | **PASS** | Second container **exited(1)**: `another process is holding /data/neoserver.db; neoserver requires a single active node per store … Could not set lock` (DuckDB conflicting lock); original unaffected (200). `manual-probes/probe-store-drills.log` |
| Restart drill: store reopens, identical content | **PASS** | `docker compose restart neoserver` → tile sha256 **identical to the manifest value** `03aa35dabf…`, tilejson 200, same 3 stations. `restart-tile.pbf` |
| Quiesced backup/restore into fresh project | **PASS** | `compose stop` → tar of `serverdata` → restored into a fresh volume → recovered instance (same `NEOSRV_STORE_KEY`) on 127.0.0.1:9001 served the **identical tile sha** `03aa35dabf…` and the same 3 features. Recovered container/volume removed; original restarted to 200. `recovered-tile.pbf` |

### 10. Gateway-side controls (synthetic)
Unchanged — already green on synthetic samples in `services/geo-gateway/test/`; this run adds no gateway. One live input for those tests: **accept MVT layer version 1** (D5) or the live-source-layer decode path will reject real NeoServer tiles.

## 4. Defects found

Owner for all: **spatial_integration** (fixes applied during T-05 are marked;
each is commented inline in the changed file).

| # | Where | Defect | Disposition |
| --- | --- | --- | --- |
| D1 | `docker-compose.yml` (WD-005) | Mounting `./initdb` as `/docker-entrypoint-initdb.d` sorts `10-qualification-station-layer.sql` BEFORE the postgis image's `10_postgis.sh` (ASCII `-` < `_`), so `ST_MakePoint` didn't exist yet — postgis exited 3 on first boot. | **Fixed in compose** (seed remounted as `20-…sql`). Evidence: `defect-postgis-initdb-ordering.log` |
| D2 | `docker-compose.yml` (WD-005) | No `NEOSRV_SERVER_HTTPHOST`: NeoServer 0.3.0 binds `127.0.0.1` INSIDE the container; the `127.0.0.1:9000->9000` mapping cannot reach it (host curl: empty reply). | **Fixed in compose** (`NEOSRV_SERVER_HTTPHOST: 0.0.0.0`; still loopback-only on the host via ports) |
| D3 | `docker-compose.yml` (WD-005) | Missing global protocol flags: `[WMS]`, `[WFS]`, `[Tiles]` all default `Enabled=false` upstream; workspace settings alone leave `/wfs`, `/wms`, `/ogc-tiles` at 404. | **Fixed in compose** (`NEOSRV_WMS_ENABLED`, `NEOSRV_WFS_ENABLED`, `NEOSRV_TILES_ENABLED: "true"`) |
| D4 | `capture.mjs` (WD-005) | The WMS GetMap BBOX applied a 0.5° inward margin to the Utah envelope, capping north lat at 41.6 — every seeded station (41.62–41.74) was outside; the PNG rendered fully transparent (0 pixels). | **Fixed in capture.mjs** (full envelope BBOX; now 345 station pixels). Evidence: `manual-probes/probes-tiles.log` |
| D5 | **NeoServer 0.3.0 behavior** | MVT tiles carry layer `version=1`, not 2 (independently verified by full protobuf decode; no `[Tiles]` config knob controls it). The capture's version-2 machine check **fails honestly and was NOT relaxed**. | Open — spatial_integration + DR-009 owner: either accept v1 in every MVT consumer (gateway decode, MapLibre handles v1) or pin an upstream NeoServer release that emits v2. |
| D6 | **NeoServer 0.3.0 behavior** | `PUT …/layers/{id}` silently drops `sql_view` (200 response, field gone; layer GET also never echoes sql_view) — sql_view is only settable at layer CREATE. | Workaround recorded (DELETE + re-POST). Upstream API-contract bug worth reporting. |
| D7 | Seeding × NeoServer API | NeoServer MVT generation requires an integer feature-id column (`'id'`); the WD-005 publication view has none, and the sql-view function allowlist excludes all hash functions (`hashtext` rejected; `row_number` allowed). Workaround: sql_view projecting `row_number() OVER () AS id`. **Consequence:** feature ids (and tile byte orderings) are non-deterministic — run-3 vs run-4 control-tile shas differ for identical data (`3bab0466…` vs `03aa35da…`). | Open — spatial_integration should seed a stable integer id column in `initdb/10-qualification-station-layer.sql`'s publication views (outside T-05's allowed write surface). T-08/T-14 evidence that compares tile BYTES must compare semantics or use a stable id. |
| D8 | Probe usage | `POST …/services/{s}/test-connection` with no body → 400 `invalid connection test request` — it validates a prospective `connection_info`, not the stored service. | Note only; connectivity proven via `discover` → 200. |
| D9 | README (WD-005) execution notes | On Git Bash/Windows, MSYS rewrites `--store-path /data/neoserver.db` to `C:/Program Files/Git/data/…`, so the store initializes OUTSIDE the volume and is lost with `--rm`. | `MSYS_NO_PATHCONV=1` prefix required (used for all container path args). README/runbook caveat owed to spatial_integration. |

## 5. Method notes (decoder validation)

The MVT header decode in `capture.mjs` was independently re-verified: a
from-scratch protobuf walk of `mvt-tile-control-z10.pbf` (field-by-field:
name `stations`, keys/values/features present, extent 4096, version **1**)
matches the script's finding, so the version-1 FAIL is server output, not a
decoder artifact. Transport encoding: raw protobuf (no gzip magic);
content-type `application/vnd.mapbox-vector-tile`.

## 6. Follow-ups owed

1. **spatial_integration / DR-009**: decide on MVT layer version 1 (D5) —
   consumers and the geo-gateway synthetic samples currently assume v2.
2. **spatial_integration**: seed a stable integer id in the publication views
   (D7) so tile bytes are reproducible (T-08 cache-sha and T-14 restore-sha
   comparisons currently had to account for this).
3. **spatial_integration**: README/runbook caveat for MSYS path mangling (D9)
   and the global protocol env flags (D3) for anyone re-running the stack.
4. **DR-013 owner**: WFS Transaction is advertised upstream and denied at the
   server for the viewer role (403) and anonymously (401) — the gateway's
   deny-before-upstream behavior stays authoritative (synthetic tests green).
5. Upstream bug report candidate: `PUT layer` drops `sql_view` silently (D6).

## 7. Teardown

`docker compose down -v` (network + `serverdata` + `pgdata` volumes removed),
`docker ps` verified empty of qualification leftovers, local `.env` deleted.
Postgres 17.5 / PostGIS 3.5 container was the `17-3.5` digest-pinned image;
no production or live DWRi system was contacted at any point (synthetic
fixture data only).
