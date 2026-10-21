# Utah Water Measurement Data Dashboard - researcher API

Programmatic access for researchers and scripts (FR-065: documented and
bounded programmatic queries; FR-063: exports). Everything here runs against
the documented `/api/v1` contract in [`packages/contracts/openapi.json`](../../packages/contracts/openapi.json);
the example payloads under [`examples/`](examples/) are generated from the
frozen fixture world (`fixtures/contracts`, seed `utah-water-fixture-v1`,
public streams only) and match the contract schemas field for field.

**Integration status:** these are contract examples, not a deployed endpoint.
`services/api` currently supplies domain functions and fixture tests; the HTTP
transport, persistent stores and staging identity connection still need to be
wired and verified. The hostname below is a placeholder. Replace it only with
an approved environment after those integrations pass acceptance.

Credential policy, lifetimes, rotation and logging rules live in
[TOKEN-POLICY.md](TOKEN-POLICY.md). Summary: a token is scoped, expiring and
revocable; its secret is shown ONCE at creation; it can never exceed your
account's current authority.

## Quickstart

1. Sign in to the dashboard and open **Account -> Developer access**.
2. Create a token: pick a label and scopes (bounded by what your account may
   do today). The panel shows the secret exactly once - copy it into your
   environment then. It is never displayed again.
3. Export it and call the API:

```bash
export UWDAT_TOKEN='uwdat_PASTE_THE_SECRET_YOU_COPIED_AT_CREATION'

curl -sS "https://waterdata.example.utah.gov/api/v1/sites?limit=2" \
  -H "Authorization: Bearer $UWDAT_TOKEN"
```

Every example below uses `Authorization: Bearer $UWDAT_TOKEN` with a
placeholder - never a real secret. Tokens are never placed in URLs, query
strings or request bodies (they would leak into logs and shared links).

## List sites (with paging and a property filter)

Cursor pagination; `limit` is advisory (the server applies its own maximum
bounds - a page limit is not an authorization control). Filters use the
canonical `FilterSet` serialization; multi-value dimensions are OR within,
AND across dimensions. This request selects public discharge sites:

```bash
curl -sS -G "https://waterdata.example.utah.gov/api/v1/sites" \
  -H "Authorization: Bearer $UWDAT_TOKEN" \
  --data-urlencode "filter={\"observedPropertyIds\":[\"discharge\"],\"stateCodes\":[\"UT\"]}" \
  --data-urlencode "limit=2"
```

Response: [`examples/list-sites/response.json`](examples/list-sites/response.json)
(a `SitePage`: two sites, `hasMore: true`, opaque `nextCursor`). Follow pages
with `?cursor=<nextCursor>`; stop when `hasMore` is `false`. Restricted and
internal sites never appear for a scoped researcher token.

## Bounded observations (date range + property + processing level)

Series endpoints are BOUNDED: `start` and `end` are both required and form a
half-open interval `[start, end)`. The property is inherent to the datastream
(`str-corinne-q` is discharge); `processingLevel` selects raw, provisional,
reviewed or `best-available` (FR-066).

```bash
curl -sS -G "https://waterdata.example.utah.gov/api/v1/streams/str-corinne-q/observations" \
  -H "Authorization: Bearer $UWDAT_TOKEN" \
  --data-urlencode "start=2026-03-08T09:00:00Z" \
  --data-urlencode "end=2026-03-08T21:00:00Z" \
  --data-urlencode "processingLevel=best-available" \
  --data-urlencode "limit=100"
```

Response: [`examples/observations/response.json`](examples/observations/response.json)
(an `ObservationPage`). Note the `coverage` block: the declared
2026-03-08T12:00-18:00Z logger outage is reported as a gap with a reason -
missing readings are never zero-filled and never silently interpolated.

### Provenance fields, explained

| Field | Meaning |
| --- | --- |
| `observedAt` | UTC instant the water was measured (RFC 3339, `Z`). |
| `sourceOffset` | Source-local UTC offset at capture (`-07:00` MST, `-06:00` MDT), so DST transitions stay reconstructible. |
| `receivedAt` | UTC instant the backend accepted the record - late arrivals are visible. |
| `sourceId` / `sourceEventId` | Ingestion source record and provider event id; retransmissions get a new event id and may duplicate an instant. |
| `valueType` | `observed` vs `estimated` vs `computed` - preserved end to end, never silently converted. |
| `processingLevel` | Level of THIS record (`best-available` rows carry the effective value and reference the governing revision). |
| `value: null` | A reported-but-empty reading. NOT zero, and not a missing reading - absence plus a declared gap is a missing reading. |
| `dataRevision` (page) | Snapshot revision of the whole response. |
| `freshness` (page) | Latest `receivedAt` visible to this caller. |

Full revision chains (who corrected what, when, why) live behind
`GET /observations/{key}/history` and `GET /observations/{key}/revisions`.

## Create an export job

Large selections are queued, never silently truncated
([FR-063](../product/baseline/01-product-requirements.md)). The job
re-authorizes on every download; a download link is proxied and expiring.

```bash
curl -sS -X POST "https://waterdata.example.utah.gov/api/v1/exports" \
  -H "Authorization: Bearer $UWDAT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @examples/create-export/request.json
```

Request/response bodies: [`examples/create-export/`](examples/create-export/)
(a `202` `AsyncJob`: `queued`, coarse `progressPercent`, explicit `rowLimit`).
Poll `GET /exports/{id}`; `downloadUrl` appears on `succeeded` and expires.

## Issuing, rotating and revoking tokens

Tokens are managed from the dashboard's Developer access panel (the secret is
copy-once), or over the session-authenticated API:

- `POST /me/api-tokens` - issue; the secret appears exactly once in the `201`
  ([example](examples/issue-token/)). Requested scopes can never exceed the
  account's current authority.
- `DELETE /me/api-tokens/{id}` - revoke; authoritative for the NEXT request.

Rotation (revoke old + issue new, same label) is one panel action; see the
[runbook](TOKEN-POLICY.md#rotation-runbook).

## Error responses

Typed `Problem` bodies (RFC 9457-aligned; `code` is stable, `message` is
human-readable). Examples: [`examples/error-responses.json`](examples/error-responses.json).

| Status | Code | When a scoped token sees it |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | Missing, malformed, unknown, revoked or expired credential. Re-authenticate or rotate; a revoked secret never works again. |
| 403 | `FORBIDDEN` | Action or data outside the token's scopes, OR outside the account's CURRENT authority (e.g. the underlying grant was revoked). Also: query windows beyond the token's date range are rejected, never clamped. |
| 404 | `NOT_FOUND` | Unknown id - and deliberately, restricted/internal objects that are out of scope (existence is not disclosed). |
| 409 | `CONFLICT` | Revoking or rotating an already-revoked token; idempotency-key conflicts. |
| 422 | `VALIDATION_FAILED` | Malformed label/scopes/expiry (e.g. expiry beyond the maximum lifetime). |
| 429 | `RATE_LIMITED` | Per-token budget exceeded; `retryAfterSeconds` is present. See below. |

## Rate-limit expectations

Per-token fixed window, INDEPENDENT of any interactive session budget
(proposed defaults, owner-ratifiable - see
[TOKEN-POLICY.md](TOKEN-POLICY.md#rate-limits-proposed)): **120 requests per fixed
60 seconds** per token. Exceeding it returns `429` with `retryAfterSeconds`;
the window resets on its own - no unlock call. Batch work should page at a
modest pace or use export jobs instead of tight observation loops.

## What a token can never do

- Exceed the account's CURRENT authority: revoking the underlying assignment
  blocks the token on the next request, even while the token itself is
  unrevoked.
- Outlive revocation: `DELETE /me/api-tokens/{id}` denies the next request.
- Appear in logs, URLs or bundles: only the token ID is ever logged; the
  secret exists once, at creation, in front of your eyes.
