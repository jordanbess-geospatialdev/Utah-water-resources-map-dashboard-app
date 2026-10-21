# NeoServer 0.3.0 — known server behavior (operator-facing)

Applies to the digest pinned in `../docker-compose.yml`:
`tobilg/neoserver:0.3.0@sha256:dab746cc669d00d4dd3667cbe871ba87b0e1f3d310456284ebaee0204a05b7d0`.

Sources of evidence:

- The T-05 live qualification capture (`recorded/CAPTURE-REPORT.md`, defects
  D5–D9). `recorded/` is IMMUTABLE captured evidence — never edit it.
- The T-05 findings re-verification (branch `fix/T-05-findings`, 2026-10-21):
  a fresh disposable stack used to prove the D7 deterministic-id fix; D7
  proof numbers quoted below come from that run.

This file is the living complement to the frozen report: new observations
against the same digest get added here, not to `recorded/`.

## D5 — MVT layer version: accept v1 AND v2, reject everything else

- **Observed (recorded capture):** live tiles decode MVT layer `version=1`
  (not 2) — verified twice by independent protobuf decode of the captured
  control tile (`recorded/mvt-tile-control-z10.pbf`, 129 B, layer
  `f15=1`). No `[Tiles]` configuration knob controls the layer version.
- **Observed (D7 re-verification):** a fresh stack emitted `version=2` on
  every route tried — direct-view layer, `sql_view` layer, and the exact
  recorded `row_number()` sql_view shape. The layer version evidently
  depends on the server's internal tile-generation path, not on operator
  configuration, and both versions occur in the wild for this digest.
- **Policy (implemented in `services/geo-gateway/src/tilejson.ts`, exported
  as `ACCEPTED_MVT_LAYER_VERSIONS` / `assertAcceptedMvtLayerVersion`):**
  - version **1** is the supported baseline for the pinned digest —
    rejecting it would reject real tiles this upstream produces;
  - version **2** is accepted as forward-compatible (an upstream that
    emits v2 needs no gateway change);
  - anything else (0, 3, …) fails loudly so a changed upstream triggers
    re-qualification instead of silent absorption.
  MapLibre renders both v1 and v2, so accepting v1 does not weaken the
  browser side of the transport.

## D6 — `PUT …/layers/{id}` silently drops `sql_view`

- **Behavior:** `PUT /api/v1/workspaces/{ws}/services/{s}/layers/{id}`
  answers 200 but does NOT persist `sql_view`; a layer GET never echoes it.
  `sql_view` (schema `sql_view_config`) is only settable at layer CREATE.
- **Operator rule:** always create the layer with its final
  `sql_view_config` in the `POST …/layers` body. To change an existing
  sql_view: `DELETE` the layer and re-`POST` it. Upstream API-contract bug;
  bug-report candidate.

## D7 context — MVT generation needs an integer feature-id column

- **Behavior:** NeoServer 0.3.0 MVT generation requires an integer
  feature-id column; without one tile requests fail
  (`mvt_agg_transfn: Could not find column 'id' of integer type`).
  The sql-view function allowlist excludes hash functions (`hashtext`
  rejected during T-05; `row_number` allowed) — ids cannot be computed in
  a sql_view.
- **Resolution (this repo):** the qualification publication views
  (`initdb/10-qualification-station-layer.sql`) expose a deterministic
  integer `id` (see `qualification.station_key_id`). Create layers
  directly over the view with **no sql_view at all** — that is the
  preferred shape and the one the D7 proof ran.
- **Proof (2026-10-21, disposable stack, synthetic data only):** control
  tile `10/381/192` sha256
  `70f3170e5a332e666a9ed190842c6b83b1f81a91a8315ae30108d81a1cf20326`
  (138 B), decoded feature id `1951498144` =
  `station_key_id('sta-bear-corinne')` — byte-identical across a
  `docker compose restart neoserver` AND across a full `docker compose
  down -v` reseed + re-init + reprovision. Stack torn down afterwards.

## D8 — `test-connection` requires a body

- **Behavior:** `POST …/services/{s}/test-connection` with no body returns
  400 `invalid connection test request`. The endpoint validates a
  PROSPECTIVE `connection_info` (send the candidate connection as the
  request body), not the stored service.
- **Operator rule:** to prove the STORED service works, use
  `POST …/services/{s}/discover` → 200.

## D9 — Windows Git Bash (MSYS) rewrites `/data/...` paths

- **Behavior:** on Git Bash/Windows, MSYS rewrites Unix-style absolute
  paths in docker CLI arguments — `--store-path /data/neoserver.db`
  becomes `C:/Program Files/Git/data/...`, so the store initializes
  OUTSIDE the mounted volume and is silently lost when `--rm` removes the
  container. Affects `docker compose run/exec/cp` and `docker run
  --entrypoint` alike.
- **Operator rule:** prefix every docker command that carries a
  container-side path with `MSYS_NO_PATHCONV=1` (e.g.
  `MSYS_NO_PATHCONV=1 docker compose run --rm neoserver init --store-path
  /data/neoserver.db`).

## Deployment-shape requirements (compose side)

Two stack-level requirements live in `../docker-compose.yml` (defects D2/D3
of the recorded report) and must survive any compose edit:

- `NEOSRV_SERVER_HTTPHOST: 0.0.0.0` — without it NeoServer binds
  `127.0.0.1` INSIDE the container and the host port mapping cannot reach
  it (empty reply on curl). Still loopback-only on the host via the
  `127.0.0.1:9000` ports mapping.
- `NEOSRV_WMS_ENABLED` / `NEOSRV_WFS_ENABLED` / `NEOSRV_TILES_ENABLED:
  "true"` — the GLOBAL protocol flags control whether a protocol's routes
  mount AT ALL (upstream defaults are false); workspace settings alone
  leave `/wfs`, `/wms`, `/ogc-tiles` at 404. Per-workspace `ogc-tiles`
  additionally needs the nested `settings.vector_tiles.enabled=true` PUT,
  and that nested PUT must carry `formats:
  ["application/vnd.mapbox-vector-tile"]` (the server rejects a
  formats-less `vector_tiles` object with 400 "vector tile formats must be
  exactly application/vnd.mapbox-vector-tile").
