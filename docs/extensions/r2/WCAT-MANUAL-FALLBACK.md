# WCAT manual fallback (FR-051, WD-023-R2)

Every `WcatAdapter` operation has a deterministic manual path — the
established simulated-channel discipline. This document is the target of
`WcatAdapter.manualFallback()` and of the `manualFallbackDoc` pointer every
sync receipt carries. It exists NOW, while the adapter seam runs against
fixtures only, because the manual path must be in place before any real
exchange is agreed (the architecture's release-qualification table gates
the external WCAT schemas, ids, API contract, ownership and reconciliation
plan on Technical Services / data ownership).

Scope note: no network transport exists anywhere in
`services/integrations/r2/` (statically scanned). The procedures below are
the documented manual channel an operator follows instead of — or to
verify — an adapter run.

## sync

Manual path (repeatable, offline):

1. Assemble the exchange artifacts in one provenance class only (observed
   OR calculated OR modeled; classes never mix in one exchange).
2. For each artifact, record the provenance block verbatim:
   `{source, observedOrModeled, ownerSystem, correlationId}`; the
   correlation id is the exchange id on every artifact.
3. Compute the content digest of each artifact exactly as
   `artifactDigest()` does (canonical sorted-key JSON of identifier, kind,
   class and payload, sha256-hex).
4. Diff the digests against the previous exchange log for the same
   identifiers (`added`, `value-changed`, `removed`) — this diff IS the
   changed-input report the receipt must state.
5. Append the new digests and the report to the exchange log; the log is
   append-only, so the exchange is repeatable by construction.

## dry-run

Manual path: steps 1–4 of `sync`, writing NOTHING to the exchange log. The
diff is reported and discarded; a dry run leaves no state behind.

## replay

Manual path: locate the exchange log entry by correlation id and re-read
its recorded receipt. The recorded receipt is the replay — it is never
recomputed, so later exchanges cannot alter what an earlier one reported.

## Ownership and class discipline (all operations)

- The `ownerSystem` of an artifact is the authoritative owner of the value;
  operators never rewrite it while exchanging — a change of ownership is a
  new provenance version, not an edit.
- `observed`, `calculated` and `modeled` artifacts are exchanged in
  separate operations, never combined, so the distinction survives the
  channel (FR-051).

Owner: blocked on the WCAT external contract owners named above; this
document's procedures are the fallback until then and the verification
channel after.
