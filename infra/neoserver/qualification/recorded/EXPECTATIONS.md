# WD-005 NeoServer qualification — executed-qualification checklist (recorded/)

Status: **AUTHORED / EXECUTION PENDING.** No Docker daemon and no live
NeoServer exist in the authoring environment, so no capture has run yet and
nothing in this directory is server output. `capture.mjs` (one directory up)
fills this directory with `manifest.json` plus the captured artifacts and
exits non-zero if any machine check below fails. Every box starts unchecked;
the platform owner (or the executing engineer) ticks a box only with the
capture evidence attached. Test references: T-05 (protocol/spatial), T-08
(cache/privacy), T-14 (operations) in
`docs/product/baseline/04-ai-development-and-testing.md`.

How to run (from the repo root, once a Docker daemon exists):

```bash
cd infra/neoserver
cp .env.example .env            # fill the three secrets
docker compose pull             # RE-VERIFY the pinned digests (see below)
docker compose run --rm neoserver init --store-path /data/neoserver.db
docker compose up -d postgis    # initdb seeds the synthetic station layer
# provision workspaces water-public / water-bear-cohort + a viewer API key
# via the NeoServer management CLI per docs/deployment.md, then:
node qualification/capture.mjs
```

## 0. Release pinning (prerequisite)

- [ ] `docker compose pull` confirms `tobilg/neoserver` at digest
      `sha256:dab746cc…a05b7d0` (tag 0.3.0, read from Docker Hub 2026-10-21)
      and `postgis/postgis:17-3.5` at `sha256:01a6a70e…daeb6f6`. A digest
      mismatch means the registry moved: STOP and re-pin deliberately
      (architecture: "Reviewed upstream `main` documentation is evidence
      about a design seam, not a reproducible release pin").
- [ ] The deployed OpenAPI/conformance documents captured below are archived
      with the image digest in the run book.

## 1. Tile path — matrix z/y/x (T-05, swap detection)

- [ ] The capture log shows the control tile for the synthetic station
      `sta-bear-corinne` (41.6337 N, 112.1965 W) at zoom 10 computed as
      **z/y/x = 10/381/192**, and that `mvt-tile-control-z10.pbf` (200,
      MVT bytes) was fetched from
      `/tiles/WebMercatorQuad/10/381/192` — matrix/ROW/COLUMN order.
- [ ] The tile's northwest corner (capture log) lies inside northern Utah
      (~41.7 N, ~112.5 W). A swapped x/y submission (10/192/381) addresses
      ~73.8 N — outside Utah — and MUST be recognizable from the recorded
      control coordinates; record one deliberate swapped request
      (`curl …/tiles/WebMercatorQuad/10/192/381`) and note the mismatch.
- [ ] No format suffix is required or accepted on the tile path
      (`…/381/192.pbf` answers 404/error, not a tile).

## 2. MVT source-layer from the ACTUAL TileJSON (T-05)

- [ ] `tilejson.json` capture contains `vector_layers[0].id` (e.g.
      `stations_public` or the deployed layer id) — the capture records it.
- [ ] The decoded MVT header check in `mvt-tile-control-z10` shows the
      tile's first layer name **equals** `vector_layers[0].id` and the layer
      version is 2. The source-layer id is taken from this evidence, never
      guessed from the collection name.
- [ ] The gateway unit tests in `services/geo-gateway` already enforce this
      on synthetic samples (`SOURCE_LAYER_MISMATCH` fails loudly); confirm
      the live value differs from or equals the collection id as deployed
      and record it here: `vector_layers[0].id = ____________`.

## 3. Relative TileJSON links resolve against the TRUSTED service URL (T-05)

- [ ] The `tilejson` capture's `checks[]` records whether the advertised
      `tiles[0]` template is **relative** or **absolute**
      (`NEOSRV_SERVER_URLBASE` influences this). Record the observed shape.
- [ ] With a relative template, the browser-facing document served by the
      gateway (rewrite happens in `services/geo-gateway/src/tilejson.ts`)
      contains ONLY same-origin gateway paths — no `localhost:9000`, no
      upstream host anywhere in the JSON (asserted by
      `tilejson.test.ts` on synthetic samples; repeat by fetching
      `/geo/workspaces/water-public/ogc-tiles/.../tilejson.json` through the
      wired gateway and grepping for the upstream host).

## 4. WFS — explicit GeoJSON output and axis control (T-05)

- [ ] `wfs-getfeature-geojson` capture shows `OUTPUTFORMAT=application/json`
      honored (content-type JSON, GeoJSON FeatureCollection body).
- [ ] The first feature's `coordinates` in that capture are
      **longitude-first** and inside the Utah envelope (lon −114.1..−108.9,
      lat 37.0..42.1). A lat/lon swap would place "lon" ≈ −112 as a latitude
      of the *longitude* slot — the capture's axis check fails loudly.
- [ ] `wfs-getcapabilities` XML snapshot archived; the advertised
      `OperationsMetadata` for Transaction exists upstream but the gateway
      denies it (see item 7) — record that anonymous/portal Transaction
      attempts never succeed.
- [ ] If BBOX is used against WFS, record which `SRSNAME` values the server
      honors for lon,lat order (the gateway sends `SRSNAME=CRS:84`;
      `urn:ogc:def:crs:EPSG::4326` is lat,lon in WFS 2.0 — the trap).

## 5. WMS — CRS axis verified with Utah control coordinates (T-05)

- [ ] `wms-getmap-epsg3857` capture returned an image for
      `CRS=EPSG:3857&BBOX=<meters>` over Utah (projected envelope recorded
      in the manifest). Confirm the rendered image is non-empty.
- [ ] **EPSG:4326 axis order probe (manual):** issue two GetMap requests
      with `CRS=EPSG:4326`, one `BBOX=37,-114.1,42,-108.9` (lat,lon) and one
      `BBOX=-114.1,37,-108.9,42` (lon,lat). WMS 1.3.0 defines EPSG:4326 as
      **latitude,longitude**; record which request renders Utah and note
      that MapLibre routing therefore stays on EPSG:3857 (spec:
      "For WMS EPSG:4326, test latitude/longitude axis order; prefer
      EPSG:3857 in MapLibre").

## 6. Paging followed (T-05)

- [ ] `ogc-items-page1` plus `ogc-items-page2…` captures show the capture
      followed the `next` link(s) of the items collection up to
      `--max-pages`, with the continuation URL recorded in the manifest.
      The portal follows pagination links rather than assuming one page.

## 7. Denied cohort reveals no private content (T-08)

- [ ] `negative-cohort-without-credential` capture shows the cohort
      workspace layer refusing an uncredentialed read (401/403).
- [ ] The private canary check passed on EVERY captured text artifact:
      the strings `SYNTHETIC-NEVER-PUBLISH`, `internal note` and `gate_code`
      appear nowhere (they exist only in the base table
      `qualification.station_all`, never in the publication views).
- [ ] Manual: warm the public tile/feature caches, then attempt the cohort
      layer via the gateway as an unentitled principal — responses must be
      denials (401/403/404), never cached private bytes (gateway cache
      policy for cohort content is `private, no-store`).

## 8. External-write cache refresh gate (T-08, ADR-10)

- [ ] With the tile cache enabled upstream: modify the synthetic layer
      through an EXTERNAL database write (psql UPDATE on
      `qualification.station_all`), confirm the stale tile serves until an
      explicit NeoServer cache refresh/truncation runs, then confirm the new
      revision serves afterward. Record timing + the refresh command.
- [ ] Confirm no spontaneous invalidation happened before the explicit
      refresh (the whole reason the outbox design exists).

## 9. One-active-store ownership gate (T-14, ADR-09)

- [ ] Start a second NeoServer container attached to the same `serverdata`
      volume (or `--scale neoserver=2`) and record that it FAILS to start /
      locks (single active writer per encrypted catalog store).
- [ ] Restart drill: `docker compose restart neoserver`, confirm the store
      reopens with `NEOSRV_STORE_KEY` and serves identical content.
- [ ] Quiesced backup/restore: stop, copy the `serverdata` volume, restore
      into a fresh compose project, confirm the recovered store serves the
      same sha256 tile/TileJSON artifacts as `manifest.json` recorded.

## 10. Gateway-side controls (already green on SYNTHETIC samples)

These need no live server (see `services/geo-gateway/test/`), listed here so
the executed qualification can point at the same evidence trail:

- [x] z/y/x swap detection via Utah control coordinates (synthetic).
- [x] Relative TileJSON links never leak the upstream host (synthetic).
- [x] Unlisted workspace denied; admin/service-management paths always
      denied (synthetic).
- [x] WFS Transaction/Insert/Update/Delete/Replace denied before any
      upstream call (synthetic).
- [x] Oversized responses capped (declared and mid-stream) (synthetic).
- [x] Cohort credential never echoes caller input (synthetic).
- [x] Source-layer mismatch fails loudly (synthetic).

## Sign-off

| Field | Value |
| --- | --- |
| Executed by | ____________ |
| Date | ____________ |
| Image digest verified | ____________ |
| Manifest sha256 (manifest.json) | ____________ |
| Deviations from this checklist | ____________ |
