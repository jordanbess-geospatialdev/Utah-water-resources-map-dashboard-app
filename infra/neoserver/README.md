# infra/neoserver — WD-005 qualification stack

Disposable NeoServer + PostGIS pair for protocol qualification (T-05/T-08/
T-14 evidence). **Not a production topology.** The stack was executed live
for the T-05 qualification on 2026-10-21 — evidence and per-expectation
verdicts live in `qualification/recorded/CAPTURE-REPORT.md` (immutable);
upstream behaviors to remember live in `qualification/KNOWN-SERVER-BEHAVIOR.md`.
Both images stay pinned by digest (re-verify with `docker compose pull`
before any capture).

| Path | Purpose |
| --- | --- |
| `docker-compose.yml` | Pinned `tobilg/neoserver:0.3.0@sha256:…` + `postgis/postgis:17-3.5@sha256:…`, persistent `serverdata` store volume, single-active-writer and quiesced-backup notes. |
| `.env.example` | Secret references ONLY (`NEOSRV_STORE_KEY`, qualification DB password, viewer API key value env). Copy to `.env` (gitignored). |
| `initdb/10-qualification-station-layer.sql` | Synthetic station layer seeded from the contract fixtures: base table with a never-publish canary column, publication views exposing approved fields only — including the T-05 D7 deterministic integer feature id (`qualification.station_key_id`, md5-folded from the station key) so identical data yields byte-identical MVT tiles — `neoserver_reader` role granted SELECT on the views and explicitly nothing on the base table. |
| `qualification/capture.mjs` | Zero-dependency capture recorder (see its header). Writes `recorded/` + `manifest.json`, exits non-zero on any failed check, never logs credential values. |
| `qualification/KNOWN-SERVER-BEHAVIOR.md` | Operator-facing record of pinned-digest server behaviors (MVT layer version v1/v2 policy, `PUT layer` drops `sql_view`, `test-connection` body requirement, MSYS path mangling) with the operator rule for each. |
| `qualification/recorded/` | **Immutable captured evidence** from the executed T-05 qualification: manifest, per-check artifacts, `CAPTURE-REPORT.md`, `EXPECTATIONS.md` (the full checklist: matrix z/y/x swap detection, source-layer from actual TileJSON, trusted relative-link resolution, WFS explicit GeoJSON + axis control, WMS CRS axis probe, paging, cohort denial, cache-refresh and one-active-store drills). Never edit. |

Order of operations once a daemon exists: `cp .env.example .env` (fill
secrets) → `docker compose pull` (digest re-verification) →
`MSYS_NO_PATHCONV=1 docker compose run --rm neoserver init --store-path /data/neoserver.db` → `docker compose up -d` → provision workspaces + viewer API key via the
NeoServer management CLI (record what was created; never the key value) →
`node qualification/capture.mjs` → complete EXPECTATIONS.md.

## Runbook caveats (T-05 live findings — do not rediscover these)

1. **Global protocol env flags are REQUIRED (D3):** `[WMS]`, `[WFS]` and
   `[Tiles]` all default `Enabled=false` upstream, and they control whether
   a protocol's routes are mounted AT ALL — workspace settings alone leave
   `/wfs`, `/wms`, `/ogc-tiles` at 404. `docker-compose.yml` sets
   `NEOSRV_WMS_ENABLED`, `NEOSRV_WFS_ENABLED`, `NEOSRV_TILES_ENABLED:
   "true"`; keep them. Per-workspace, `ogc-tiles` additionally needs the
   nested `settings.vector_tiles.enabled=true` PUT (carrying `formats:
   ["application/vnd.mapbox-vector-tile"]`).
2. **Bind host (D2):** without `NEOSRV_SERVER_HTTPHOST: 0.0.0.0` NeoServer
   0.3.0 binds `127.0.0.1` INSIDE the container and the
   `127.0.0.1:9000->9000` host port mapping cannot reach it (host curl
   gets an empty reply). Keep the env; the stack stays host-loopback-only
   via the ports mapping.
3. **Windows Git Bash / MSYS path mangling (D9):** MSYS rewrites
   Unix-style absolute paths in docker CLI arguments —
   `--store-path /data/neoserver.db` becomes `C:/Program Files/Git/data/…`,
   so the store initializes OUTSIDE the `serverdata` volume and is lost
   with `--rm`. Prefix EVERY docker command that carries a container-side
   path with `MSYS_NO_PATHCONV=1` (the init command above already shows
   it; it equally applies to `docker compose exec`, `docker compose cp`
   and `docker run --entrypoint /app/neoserver …`).
4. **Layer sql_view rules (D6/D7):** create layers with their FINAL
   `sql_view_config` at CREATE time — `PUT …/layers/{id}` silently drops
   `sql_view` (see `qualification/KNOWN-SERVER-BEHAVIOR.md`). Better: with
   the D7 deterministic integer id in the seeded publication views you
   need NO sql_view at all — create the layer directly over the view.
