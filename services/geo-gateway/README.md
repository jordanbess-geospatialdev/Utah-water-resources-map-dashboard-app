# @utah-water/geo-gateway (WD-005)

Authorized same-origin gateway for NeoServer spatial services. Pure
TypeScript, **zero runtime dependencies** (Node built-ins only), tested with
`node --test --experimental-strip-types`.

## STATUS — honest

- **Authored and green:** route allowlist, upstream URL building
  (matrix z/y/x, EPSG:3857 WMS, explicit WFS GeoJSON), trusted TileJSON
  resolution + same-origin re-mapping, the full gateway pipeline (policy
  gate via `@utah-water/policy` `evaluatePublicRead`/`evaluate`, credential
  isolation, response caps, cache policy), and the synthetic-sample test
  suite under `test/` (all samples clearly labeled SYNTHETIC).
- **Pending execution:** every claim about REAL NeoServer behavior. This
  environment has no Docker daemon; the pinned image digests in
  `infra/neoserver/docker-compose.yml` were read from Docker Hub metadata on
  2026-10-21 and must be re-verified at first `docker compose pull`. The
  qualification harness (`infra/neoserver/qualification/capture.mjs` +
  `recorded/EXPECTATIONS.md`) is ready to run; nothing there has executed.
  No captured-from-server data exists anywhere in this package — by design,
  fabrication was not an option.

## Layout

| File | Role |
| --- | --- |
| `src/allowlist.ts` | Route table (workspace/service/collection/operation), admin-path and WFS-mutation denial, WXS KVP operation resolution. Table is data — deployments pass their own frozen table. |
| `src/url.ts` | Pure upstream URL building: matrix z/y/x tiles, EPSG:3857 WMS bboxes (degree-shaped bboxes rejected loudly), explicit WFS GeoJSON output, limit clamping, `assertTrustedUpstream`. |
| `src/tilejson.ts` | Trusted TileJSON resolution: relative links resolved against the trusted service base (never the browser), only allowlisted templates re-mapped same-origin, actual `vector_layers[0].id` extraction with loud mismatch failures. |
| `src/gateway.ts` | Transport-agnostic pipeline: method gate → allowlist → policy → URL build → fetch (timeout, narrow service credential from a secret-reference resolver) → content-type/size caps → TileJSON rewrite → cache policy. |
| `src/index.ts` | Public barrel. |
| `test/` | `node --test` suites + `test/fixtures/` SYNTHETIC samples. |

## Security properties (each with a test)

- **Credential isolation:** `GatewayRequest` carries no headers. The only
  credential sent upstream is the one resolved from the route's
  `secretref://…` reference via the injected `SecretResolver`; an unresolved
  reference fails **closed** (503, no anonymous upstream call).
- **No arbitrary upstream URLs:** URLs are built exclusively from typed,
  allowlist-derived parameters; `assertTrustedUpstream` re-checks origin,
  userinfo, traversal and the `/workspaces/` surface before every fetch.
- **Admin surface never proxied:** `/api/`, `/admin`, `/auth/` and any
  traversal are denied regardless of the route table.
- **WFS mutations denied:** `REQUEST=Transaction|Insert|Update|Delete|`
  `Replace` (and `GetFeatureWithLock`) are denied before any upstream call;
  POST is not routable at all (405). Dashboard writes go through the domain
  API (FR-010).
- **Public vs cohort caching (T-08):** only successful public-audience
  tile/TileJSON responses via the public-read policy branch get
  `public, max-age=…, must-revalidate`; cohort content and non-revisioned
  JSON are `private, no-store`.
- **Hidden-layer non-disclosure:** unknown workspace/collection and
  unpublished guard objects return 404, not 403 (existence is not leaked).

## Policy integration (WD-004)

`authorizeRoute()` in `src/gateway.ts`:

- `audience: 'public'` workspaces call **`evaluatePublicRead`** (action
  `browse-published`) over the route's guard object — the published public
  projection branch; anonymous callers may pass.
- `audience: 'cohort'` workspaces call **`evaluate`** with the session
  principal (action `view-restricted-details`, fields `public+restricted`)
  over the guard object. The server-held workspace credential only ever
  reads a projection safe for every cohort member, and each member's
  entitlement is re-evaluated per request from the injected `worldLoader`
  (no entitlement caching — a revoked member fails the next request even
  with warm artifacts).

The policy package is imported via a relative path
(`../../../packages/policy/src/index.ts`), the same convention as
`services/api/src/auth`; the workspace-wiring chore branch may later switch
these to the `@utah-water/policy` specifier.

## Wiring into a server later (Fastify sketch)

`handleGatewayRequest` is transport-agnostic on purpose. When the API
service exists, the adapter is roughly:

```ts
app.get('/geo/*', async (req, reply) => {
  const res = await handleGatewayRequest({
    method: req.method,
    path: req.url.slice('/geo'.length).split('?')[0],
    query: req.query,                       // Fastify gives an object; wrap in URLSearchParams
    session: { principal: req.sessionPrincipal }, // from services/api session resolution
  }, gatewayConfigFromEnv());
  reply.code(res.status);
  for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
  return res.body;                          // string (rewritten JSON) or Uint8Array (bytes)
});
```

No Fastify (or any HTTP framework) dependency exists in this package today;
`fetchImpl`, `worldLoader`, `resolveSecret`, clock and limits are all
injected via `GatewayConfig`, which is what made the synthetic test suite
possible without a server.

## Tests

```bash
npm test    # node --test --experimental-strip-types test/*.test.ts
```

Every fixture under `test/fixtures/` carries a `$note` marking it
SYNTHETIC; control coordinates are the frozen contract-fixture stations
(41.6337/−112.1965 and 41.6295/−111.8524), and the z10 matrix tile
(10/**381**/192) plus its inverse projection are recomputed independently in
the tests so the module under test cannot validate itself.

## Qualification (live capture) — pending

See `infra/neoserver/docker-compose.yml` (pinned disposable stack),
`infra/neoserver/qualification/capture.mjs` (zero-dep recorder with machine
checks: z/y/x control tile, MVT header/source-layer agreement, GeoJSON axis
control, private-content canary, negative controls) and
`infra/neoserver/qualification/recorded/EXPECTATIONS.md` (the full human
checklist, including the WMS EPSG:4326 lat/lon axis probe, cache refresh and
single-active-writer drills).
