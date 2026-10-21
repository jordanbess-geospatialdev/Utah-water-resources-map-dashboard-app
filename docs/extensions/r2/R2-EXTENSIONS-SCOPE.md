# R2 Extensions Scope — As-of Reconstruction, Voice Notes, WCAT

Task WD-023-R2 | FR-044, FR-047, FR-051 | Prepared by the orchestrator, 2026-10-21
Status: **Bounded contracts defined; implementation of the internal as-of path is authorized; voice and WCAT remain contract-gated on external approvals.**

## FR-044 — Historical as-of reconstruction (AUTHORIZED for implementation)

**Bounded contract.** Given an as-of instant T, a query returns the revisions
*recorded at or before T* (recorded-time semantics; observation time and
revision time remain distinct per the tech spec). The revision store already
retains everything required — no schema change needed.

1. Inputs: logical observation key (or stream + range), as-of instant T.
2. Output: the observation state as known at T — value, processing level,
   qualifiers, the revision id that produced it, plus an `asOfBasis` block
   (asOf instant, latest revision id considered, count of later revisions
   excluded).
3. Determinism: identical inputs produce byte-identical outputs; a later
   correction (recorded after T) provably does not change the T-view.
4. Exports carry the as-of basis label per FR-044; the result reproduces after
   later corrections (tested).
5. Boundary: revision recorded exactly AT T is included (closed lower, open
   upper on recorded-time ordering — documented and tested at boundary
   instants).

## FR-047 — Voice notes with optional AI assistance (STUB ONLY until provider/privacy approval)

**Contract.** A user records audio; transcription is requested explicitly;
**the transcript is an editable draft the user must review before save**; no
AI text ever changes measurements or inspection status (FR-047/NFR-010).

1. Implementation now: the draft model (audio attachment reference with
   retention class, transcript draft with provenance, review-required state
   machine) and a `TranscriptionProvider` interface with a deterministic local
   stub returning an empty transcript marked provider-pending.
2. **Blocked on owners**: provider selection and the privacy review required
   before internal audio/text is sent to any external service (NFR-010: state-
   policy review precedes external processing). No network code may exist
   before that approval; the interface is the seam.
3. Original media follows the attachment retention policy (WD-012 wall applies).

## FR-051 — WCAT integration (ADAPTER SEAM ONLY until the external contract is agreed)

**Contract.** An adapter exchanges identified stream/model inputs or results
with WCAT; sync is repeatable, reports changed inputs, and preserves
observed-vs-calculated-vs-modeled distinctions and authoritative ownership.

1. Implementation now: the `WcatAdapter` interface (typed request/response
   contracts, provenance on every exchanged artifact, dry-run/replay modes) and
   a fixture-backed fake for tests; zero network transport.
2. **Blocked on owners** (per the architecture's release-qualification table):
   actual WCAT schemas, IDs, API contracts, ownership and the reconciliation
   plan — the "Existing ingestion and WCAT integration" row names Technical
   Services/data ownership. Until agreed, the adapter seam compiles and its
   provenance rules are testable against fixtures only.
3. Deterministic manual fallback: every adapter operation has a documented
   manual path (the established simulated-channel discipline).

## Verification owed by the implementation slice

Tests for: as-of boundary instants and post-correction reproduction;
transcript review-required enforcement (no unreviewed transcript can attach to
an official record); WCAT provenance preservation and observed/modeled
separation on the fake; determinism throughout; no network calls anywhere
(static scan).

Agent: orchestrator
