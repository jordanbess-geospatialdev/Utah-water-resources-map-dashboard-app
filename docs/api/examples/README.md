# Example payloads

Request/response pairs for the documented researcher API, generated from the
frozen fixture world (`fixtures/contracts`, seed `utah-water-fixture-v1`,
public streams only) and matching the schemas in
[`packages/contracts/openapi.json`](../../packages/contracts/openapi.json)
(`ApiTokenCreateRequest`/`ApiTokenIssued`, `SitePage`, `ObservationPage`,
`ExportCreateRequest`/`AsyncJob`, `Problem`).

Every `Authorization: Bearer $UWDAT_TOKEN` in the parent README refers to
these; no file here contains a real secret - the issue-token response carries
an explicit placeholder.

| Directory / file | Operation | Notes |
| --- | --- | --- |
| `issue-token/` | `POST /me/api-tokens` | The secret placeholder appears exactly once, as at creation. |
| `list-sites/` | `GET /sites` | FilterSet filter + cursor paging; public projection (no `internal` block). |
| `observations/` | `GET /streams/{id}/observations` | Bounded half-open window, `best-available` processing, coverage gap reporting, full provenance fields. |
| `create-export/` | `POST /exports` | Async CSV job with explicit row limit; `downloadUrl` is null until `succeeded`. |
| `error-responses.json` | errors | `Problem` bodies for the 401/403/404/409/422/429 rows of the README table. |
