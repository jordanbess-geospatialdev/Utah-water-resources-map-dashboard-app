# fixtures/ai (WD-019, FR-003 / NFR-010 / T-13)

Curated evaluation data for the deterministic natural-language filter layer
(`services/api/src/ai/filter-parser/`). Both files pin the fixture seed and
the fixed clock (`2026-03-09T07:00:00Z`, from
`fixtures/contracts/seed-manifest.json`) so every expectation is
reproducible: same inputs, byte-identical proposals.

## Files

| File | Role |
| --- | --- |
| `curated-utterances.json` | 21 curated utterances (the FR-003 three metadata examples plus 18 more: synonyms, OR-within-dimension, AND-across-dimensions, ambiguity, unknown terms, relative/absolute dates, water-year, computed questions, internal-diagnostic and restricted-classification no-leak cases). Each case carries the expected FilterSet, the DOCUMENTED manual-filter equivalent, matched/unknown term attribution, clarification/date/unsupported projections and the expected public station ids. |
| `injection-corpus.json` | 16 adversarial utterances (instruction overrides, role assertions, grant requests, private-data requests, SQL fragments, URL/credential exfiltration, write requests, restricted identifiers) with the required safe outcome per case. |

## Consumption

- `services/api/src/ai/filter-parser/equivalence.test.ts` runs every curated
  case through `interpret()` and the REAL WD-007 discovery engine
  (`apps/web/src/features/discovery/filters.ts`): the NL `filterSet` must
  deep-equal `manualEquivalent`, survive the manual canonicalizer unchanged,
  and `filterPublicStations` must return `expectedStationIds` for both the NL
  and the manual set — identical site lists, not just identical filters.
- `services/api/src/ai/filter-parser/security.test.ts` runs the injection
  corpus and asserts every outcome is a `valid-public-filter` or
  `needs-clarification`, that the output type is always `FilterSetProposal`,
  and that no path produces SQL, URL fetching, permission claims or anything
  outside the FilterSet schema.

## Shape notes

- `matchedTerms[].input` is the normalized matched phrase (lowercased,
  punctuation split into spaces) — deterministic across casings.
- `manualEquivalent` may list dimension values in any order (a human wrote it
  by hand); the tests canonicalize before comparing, and `filterSet` itself
  is always sorted/deduplicated (OR within a dimension).
- Clarification `message` fields, date `limitation` text and security
  `note`/`excerpt` fields are display text asserted for presence and bounds,
  not exact wording; only the structural fields mirrored here are
  deep-compared.
- `expectedStationIds` are the PUBLIC catalog rows (WD-006 projection) in
  fixture order.

## Provenance caveat

The exact wording of "the three metadata examples on S1 PDF p. 15" is not
reproduced anywhere in this repository (the baseline docs reference the PDF
by page only). `fr003-metadata-1..3` are the canonical reconstructions —
system+telemetry, site type+property, processing+provider — chosen to cover
the three metadata axes FR-003 names; the equivalence property (NL result =
manual result, same site ids) is what the requirement actually acceptance
-tests and is asserted for every case, including these three.

## Requirement traceability

- **FR-003** — NL metadata filtering: curated examples equal manual results;
  inspectable proposal; unsupported computed questions get clear limitations.
- **NFR-010** — responsible AI: structured-output validation (the proposal IS
  the validated AST), deterministic manual fallback (the same filter engine
  runs both paths).
- **T-13** — NLP/manual equivalence, inspectable filters, clarification over
  guessing, injection cannot expand grants, no generated SQL execution.
