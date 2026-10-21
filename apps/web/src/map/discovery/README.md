# map/discovery (WD-007, FR-001)

Bounded, public-projection-only map retrieval for the discovery surface.

## Files

| File | Role |
| --- | --- |
| `discoverySource.ts` | The public catalog (fixture stations through WD-006's public viewer, read-only reuse of `shell/data/projection`), bbox-bounded feature retrieval with hard limit caps (default 250, max 1000, mirroring `map/shell/gateway.boundedFeatures` whose URL builder is reused for the gateway query), GeoLibre source+layer descriptors with a strict property whitelist, and a request-guarded async source that rejects stale responses after a filter change (reuses `map/shell/requestGuard`). |
| `discoverySource.test.ts` | `node:test` suite (11 tests): public-projection-only catalog, axis-order assertions, restricted-field leak scan over features and layers, bbox/limit validation and truncation, filter composition inside bounded requests, layer ids/selection/metadata, gateway query parity with the shell builder, stale-response rejection, transport notes. |
| `index.ts` | Public exports. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/map/discovery/discoverySource.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob only covers
`tests/*.test.ts` and `src/features/**/*.test.ts`; this map-local suite is run
with the command above.)

## MVT vs GeoJSON transport selection

`TRANSPORT_NOTES` documents the rule against WD-005's allowlisted transports
(`services/geo-gateway/src/allowlist.ts`): GeoJSON via the gateway's
collections items route (explicit JSON output, bbox + capped limit —
`gatewayFeaturesQuery()` builds the same-origin `/geo/…` URL by reusing
`map/shell/gateway.boundedFeatures`) while a bounded viewport fits
`MAX_DISCOVERY_LIMIT` features; WebMercatorQuad MVT tiles (`{z}/{y}/{x}`,
matrix/row/column, never a guessed `.pbf` suffix) with the tile template and
source-layer id resolved from the collection TileJSON
(`services/geo-gateway/src/tilejson.ts`) once the public catalog outgrows
per-viewport GeoJSON. Either transport serves the same public projection with
the same property whitelist, limit caps and stale rejection.

## Pending shell wiring (persona_ui's next slice)

One import beside the existing map shell; conceptually:

```tsx
import { createDiscoverySource, buildDiscoveryLayers } from './map/discovery';

// const source = createDiscoverySource();
// const result = await source.load({ filters, bbox, limit }); // null = stale, never applied
// engine.sync(buildDiscoveryLayers(projectionsFor(result), selectedStationId));
```

WD-007 does not edit `apps/web/src/shell/App.tsx` or `apps/web/src/map/shell/**`.
