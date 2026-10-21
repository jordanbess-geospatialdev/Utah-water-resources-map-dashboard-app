# exports (WD-008) - CSV domain and bounded async export jobs

Implements FR-063 (single-site and multi-site CSV exports) and the technical
specification's export rules ("Proposed application API", last paragraph).

- `csv.ts` - RFC 4180 rendering with **CRLF** line endings (documented
  choice; RFC 4180 section 2.1 and what spreadsheet consumers expect).
  Columns per the tech spec: station/stream ids, property/unit, observation
  time + retained source offset, value, processing level, qualifiers,
  source and revision identifiers. Formula-injection neutralization
  (leading `=`, `+`, `-`, `@`, TAB, CR -> prefixed `'`) applies to
  user-controlled TEXT columns (station display name, joined qualifiers);
  numeric value columns are exempt so legitimate negatives like `-1.2`
  round-trip, and system identifiers/timestamps stay machine-readable.
  Missing values render as empty fields, never `0`. Multi-stream ordering:
  station, then stream, then observation time ascending. Manifest sizes count
  UTF-8 bytes, including non-ASCII station names.
- `exportJob.ts` - `ExportJobManager`: bounded asynchronous job model with
  lifecycle `queued -> running -> succeeded | failed`, row cap (413 at
  creation - never silent truncation), wall-clock time cap enforced by the
  worker `tick()` and before/after completion, expiring download manifest, and the **same grant gate as
  chart APIs** re-run at creation, completion and EVERY download. A grant
  revoked after the artifact exists fails the job closed (terminal `failed`,
  typed 403 `DENY_ASSIGNMENT_REVOKED`); the bytes are never handed out.
  Each download checks the requester's current authority and the downloader's
  authority. An unrelated caller's denial cannot delete a valid artifact.

## Reauthorization-on-download hook (for the HTTP layer)

`GET /api/v1/exports/{id}` must call `ExportJobManager.download(jobId,
actor)` (the clock is injected in the manager) - never issue a presigned/reusable storage URL. That keeps the
per-download grant check un-bypassable ("Export jobs cannot outlive a
revoked permission without a new authorization check"). Serve private
artifacts with `Cache-Control: private, no-store`; only separately approved
public artifacts may use cacheable URLs.

## Run the tests

```bash
cd services/api
node --test --experimental-strip-types src/exports/test/exports.test.ts
```

(Repo-wide glob wiring is noted in `../series/README.md` - package.json is
outside WD-008's write scope.)
