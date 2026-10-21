# WD-005 NeoServer qualification — executed-qualification checklist (recorded/)

Status: **EXECUTED 2026-10-21 (T-05).** Boxes are ticked only where capture
evidence exists; per-item verdict tables, defect notes and evidence pointers
live in `CAPTURE-REPORT.md` in this directory. One machine check fails
honestly (MVT layer version 1 — genuine NeoServer 0.3.0 output, defect D5).
Test references: T-05 (protocol/spatial), T-08 (cache/privacy), T-14
(operations) in
`docs/product/baseline/04-ai-development-and-testing.md`.

How this run was executed (from the repo root):

```bash
cd infra/neoserver
cp .env.example .env            # fill the three secrets (local only)
docker compose pull             # digests re-verified, both match pins
# Git Bash/Windows: prefix container-path commands with MSYS_NO_PATHCONV=1 (defect D9)
docker compose run --rm neoserver init --store-path /data/neoserver.db
docker compose up -d postgis    # initdb seeds the synthetic station layer
# workspaces + layers + viewer API key provisioned via the management API
# (every request logged in recorded/configuration-requests.log), then:
node qualification/capture.mjs  # final run: 14/14 captures, 1 honest FAIL
```

## 0. Release pinning (prerequisite)

- [x] `docker compose pull` confirms `tobilg/neoserver` at digest
      `sha256:dab746cc…a05b7d0` (tag 0.3.0, read from Docker Hub 2026-10-21)
      and `postgis/postgis:17-3.5` at `sha256:01a6a70e…daeb6f6`. A digest
      mismatch means the registry moved: STOP and re-pin deliberately
      (architecture: "Reviewed upstream `main` documentation is evidence
      about a design seam, not a reproducible release pin").
      → PASS: `environment-image-digests.txt` (both digests identical to pins).
- [x] The deployed OpenAPI/conformance documents captured below are archived
      with the image digest in the run book.
      → PASS: `ogc-openapi.json` + `ogc-conformance.json`; digest recorded in
      CAPTURE-REPORT.md section 1.

## 1. Tile path — matrix z/y/x (T-05, swap detection)

- [x] The capture log shows the control tile for the synthetic station
      `sta-bear-corinne` (41.6337 N, 112.1965 W) at zoom 10 computed as
      **z/y/x = 10/381/192**, and that `mvt-tile-control-z10.pbf` (200,
      MVT bytes) was fetched from
      `/tiles/WebMercatorQuad/10/381/192` — matrix/ROW/COLUMN order.
      → PASS (manifest + `manual-probes/t05-capture-console-run4.log`).
- [x] The tile's northwest corner (capture log) lies inside northern Utah
      (~41.7 N, ~112.5 W). A swapped x/y submission (10/192/381) addresses
      ~73.8 N — outside Utah — and MUST be recognizable from the recorded
      control coordinates; record one deliberate swapped request
      (`curl …/tiles/WebMercatorQuad/10/192/381`) and note the mismatch.
      → PASS: NW corner 41.771,-112.500; swapped request returned a 17 B
      EMPTY tile vs the 129 B control (`manual-probes/tile-swapped-10-192-381.pbf`).
- [x] No format suffix is required or accepted on the tile path
      (`…/381/192.pbf` answers 404/error, not a tile).
      → PASS: `…/192.pbf` → 400 `application/json` (error, not a tile).

## 2. MVT source-layer from the ACTUAL TileJSON (T-05)

- [x] `tilejson.json` capture contains `vector_layers[0].id` (e.g.
      `stations_public` or the deployed layer id) — the capture records it.
      → PASS: `vector_layers[0].id = "stations"` (`tilejson.json`).
- [ ] The decoded MVT header check in `mvt-tile-control-z10` shows the
      tile's first layer name **equals** `vector_layers[0].id` and the layer
      version is 2. The source-layer id is taken from this evidence, never
      guessed from the collection name.
      → PARTIAL: name check PASSES (`tile="stations" tilejson="stations"`);
      version check **FAILS** — NeoServer 0.3.0 emits layer version **1**
      (independently verified by from-scratch protobuf decode; defect D5,
      no config knob). Check deliberately left unticked.
- [x] The gateway unit tests in `services/geo-gateway` already enforce this
      on synthetic samples (`SOURCE_LAYER_MISMATCH` fails loudly); confirm
      the live value differs from or equals the collection id as deployed
      and record it here: `vector_layers[0].id = stations` (equals the
      collection id as deployed; gateway tests must additionally accept
      layer version 1 — see D5).

## 3. Relative TileJSON links resolve against the TRUSTED service URL (T-05)

- [x] The `tilejson` capture's `checks[]` records whether the advertised
      `tiles[0]` template is **relative** or **absolute**
      (`NEOSRV_SERVER_URLBASE` influences this). Record the observed shape.
      → OBSERVED: **absolute** — `http://localhost:9000/…/WebMercatorQuad/{z}/{y}/{x}`
      (manifest check `tile template shape recorded`).
- [ ] With a relative template, the browser-facing document served by the
      gateway (rewrite happens in `services/geo-gateway/src/tilejson.ts`)
      contains ONLY same-origin gateway paths — no `localhost:9000`, no
      upstream host anywhere in the JSON (asserted by
      `tilejson.test.ts` on synthetic samples; repeat by fetching
      `/geo/workspaces/water-public/ogc-tiles/.../tilejson.json` through the
      wired gateway and grepping for the upstream host).
      → N/A live (no gateway in this stack): upstream returns ABSOLUTE
      links, so in production the gateway's absolute→same-origin rewrite is
      the operative path. Synthetic test remains authoritative; flagged to
      spatial_integration in CAPTURE-REPORT.md section 6.

## 4. WFS — explicit GeoJSON output and axis control (T-05)

- [x] `wfs-getfeature-geojson` capture shows `OUTPUTFORMAT=application/json`
      honored (content-type JSON, GeoJSON FeatureCollection body).
      → PASS (`application/json; charset=utf-8`, 3 features).
- [x] The first feature's `coordinates` in that capture are
      **longitude-first** and inside the Utah envelope (lon −114.1..−108.9,
      lat 37.0..42.1). A lat/lon swap would place "lon" ≈ −112 as a latitude
      of the *longitude* slot — the capture's axis check fails loudly.
      → PASS: manifest check records `[-111.8524, 41.6295]`.
- [x] `wfs-getcapabilities` XML snapshot archived; the advertised
      `OperationsMetadata` for Transaction exists upstream but the gateway
      denies it (see item 7) — record that anonymous/portal Transaction
      attempts never succeed.
      → PASS: Transaction IS advertised; live attempts: viewer key → 403
      `forbidden: operation is not granted`, anonymous → 401
      (`manual-probes/wfs-transaction-attempt.xml`).
- [x] If BBOX is used against WFS, record which `SRSNAME` values the server
      honors for lon,lat order (the gateway sends `SRSNAME=CRS:84`;
      `urn:ogc:def:crs:EPSG::4326` is lat,lon in WFS 2.0 — the trap).
      → RECORDED: BOTH `CRS:84` and `urn:…EPSG::4326` are interpreted
      lon,lat by this server (identical results) — the urn lat,lon trap does
      not occur. `wfs-bbox-crs84.json`, `wfs-bbox-urn4326.json`.

## 5. WMS — CRS axis verified with Utah control coordinates (T-05)

- [x] `wms-getmap-epsg3857` capture returned an image for
      `CRS=EPSG:3857&BBOX=<meters>` over Utah (projected envelope recorded
      in the manifest). Confirm the rendered image is non-empty.
      → PASS after capture-script defect fix D4 (original 0.5° margin
      excluded all stations): 345 non-transparent pixels
      (`manual-probes/probes-tiles.log`).
- [x] **EPSG:4326 axis order probe (manual):** issue two GetMap requests
      with `CRS=EPSG:4326`, one `BBOX=37,-114.1,42,-108.9` (lat,lon) and one
      `BBOX=-114.1,37,-108.9,42` (lon,lat). WMS 1.3.0 defines EPSG:4326 as
      **latitude,longitude**; record which request renders Utah and note
      that MapLibre routing therefore stays on EPSG:3857.
      → PASS: lat,lon BBOX renders 339 non-transparent pixels; lon,lat
      renders 0 — identical to the empty Atlantic baseline. Lat,lon order
      confirmed; MapLibre stays on EPSG:3857.

## 6. Paging followed (T-05)

- [x] `ogc-items-page1` plus `ogc-items-page2…` captures show the capture
      followed the `next` link(s) of the items collection up to
      `--max-pages`, with the continuation URL recorded in the manifest.
      The portal follows pagination links rather than assuming one page.
      → PASS: with limit=100 (3 features) no next link exists; manual
      limit=1 probe followed 3 pages via `next` (offset=1, offset=2),
      `numberMatched=3`, last page has no next
      (`manual-probes/paging-page{1,2,3}.json`).

## 7. Denied cohort reveals no private content (T-08)

- [x] `negative-cohort-without-credential` capture shows the cohort
      workspace layer refusing an uncredentialed read (401/403).
      → PASS: 401.
- [x] The private canary check passed on EVERY captured text artifact:
      the strings `SYNTHETIC-NEVER-PUBLISH`, `internal note` and `gate_code`
      appear nowhere (they exist only in the base table
      `qualification.station_all`, never in the publication views).
      → PASS and extended: a byte-level sweep of ALL 39 recorded files
      (including .pbf/.png binaries) found ZERO occurrences in any
      server-served byte (`canary-sweep.log`).
- [ ] Manual: warm the public tile/feature caches, then attempt the cohort
      layer via the gateway as an unentitled principal — responses must be
      denials (401/403/404), never cached private bytes (gateway cache
      policy for cohort content is `private, no-store`).
      → N/A live: gateway not part of this stack; synthetic gateway suite
      remains authoritative.

## 8. External-write cache refresh gate (T-08, ADR-10)

- [x] With the tile cache enabled upstream: modify the synthetic layer
      through an EXTERNAL database write (psql UPDATE on
      `qualification.station_all`), confirm the stale tile serves until an
      explicit NeoServer cache refresh/truncation runs, then confirm the new
      revision serves afterward. Record timing + the refresh command.
      → PASS (`manual-probes/probe-cache-refresh.log`; refresh =
      `POST /api/v1/workspaces/water-public/cache/clear`).
- [x] Confirm no spontaneous invalidation happened before the explicit
      refresh (the whole reason the outbox design exists).
      → PASS: fetch 9 ms after the external UPDATE served the byte-identical
      stale tile; the revision appeared only after the explicit clear.

## 9. One-active-store ownership gate (T-14, ADR-09)

- [x] Start a second NeoServer container attached to the same `serverdata`
      volume (or `--scale neoserver=2`) and record that it FAILS to start /
      locks (single active writer per encrypted catalog store).
      → PASS: second container exit(1), "another process is holding
      /data/neoserver.db; neoserver requires a single active node per store"
      (`manual-probes/probe-store-drills.log`).
- [x] Restart drill: `docker compose restart neoserver`, confirm the store
      reopens with `NEOSRV_STORE_KEY` and serves identical content.
      → PASS: tile sha256 identical to the manifest value after restart.
- [x] Quiesced backup/restore: stop, copy the `serverdata` volume, restore
      into a fresh compose project, confirm the recovered store serves the
      same sha256 tile/TileJSON artifacts as `manifest.json` recorded.
      → PASS: recovered instance (fresh volume, same store key) served the
      identical tile sha256 and the same 3 features. Caveat D7: tile bytes
      are only reproducible when the sql_view's `row_number()` ids happen to
      repeat; compare semantics unless a stable integer id is seeded.

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
- Live input for this suite: NeoServer 0.3.0 emits MVT layer version 1
  (defect D5) — the synthetic samples must not hard-require version 2.

## Sign-off

| Field | Value |
| --- | --- |
| Executed by | qa_accessibility (T-05 qualification agent) |
| Date | 2026-10-21 |
| Image digest verified | neoserver `sha256:dab746cc…a05b7d0`, postgis `sha256:01a6a70e…daeb6f6` (both match pins) |
| Manifest sha256 (manifest.json) | `bbf030adc74115a4901d29f7467b8d1666cf1ddf359322150fbffbd2492f1f2c` |
| Deviations from this checklist | WMS GetMap BBOX widened to the full Utah envelope (defect D4); layer published via sql_view `row_number() OVER () AS id` because NeoServer MVT needs an integer feature id (defect D7); one box left unticked (MVT layer version, defect D5); two boxes N/A live (gateway-side repeats); full detail in CAPTURE-REPORT.md |
