# infra/neoserver — WD-005 qualification stack

Disposable NeoServer + PostGIS pair for protocol qualification (T-05/T-08/
T-14 evidence). **Not a production topology.** Nothing here has been
executed: this environment has no Docker daemon. The compose file pins both
images by digest (read from Docker Hub metadata 2026-10-21; re-verify with
`docker compose pull` before trusting any capture).

| Path | Purpose |
| --- | --- |
| `docker-compose.yml` | Pinned `tobilg/neoserver:0.3.0@sha256:…` + `postgis/postgis:17-3.5@sha256:…`, persistent `serverdata` store volume, single-active-writer and quiesced-backup notes. |
| `.env.example` | Secret references ONLY (`NEOSRV_STORE_KEY`, qualification DB password, viewer API key value env). Copy to `.env` (gitignored). |
| `initdb/10-qualification-station-layer.sql` | Synthetic station layer seeded from the contract fixtures: base table with a never-publish canary column, publication views exposing approved fields only, `neoserver_reader` role granted SELECT on the views and explicitly nothing on the base table. |
| `qualification/capture.mjs` | Zero-dependency capture recorder (see its header). Writes `recorded/` + `manifest.json`, exits non-zero on any failed check, never logs credential values. |
| `qualification/recorded/EXPECTATIONS.md` | The executed-qualification checklist: matrix z/y/x swap detection, source-layer from actual TileJSON, trusted relative-link resolution, WFS explicit GeoJSON + axis control, WMS CRS axis probe with Utah coordinates, paging, cohort denial, cache-refresh and one-active-store drills. |

Order of operations once a daemon exists: `cp .env.example .env` (fill
secrets) → `docker compose pull` (digest re-verification) →
`docker compose run --rm neoserver init --store-path /data/neoserver.db` →
`docker compose up -d` → provision workspaces + viewer API key via the
NeoServer management CLI (record what was created; never the key value) →
`node qualification/capture.mjs` → complete EXPECTATIONS.md.
