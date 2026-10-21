# Source Baseline Register

Task WD-001 | 21 October 2026

This register records the source documents underlying the Utah Water Measurement Data Dashboard specifications. The specification snapshot itself lives in [baseline/](baseline/MANIFEST.md).

## Source documents

| ID | Source | Extent | Role |
| --- | --- | --- | --- |
| S1 | *Updated 2026 User-Centric Design Requirements for the Water Measurement Data Dashboard*, September 2026 draft | 72 PDF pages | Requirements draft: user needs, personas, journeys, and interface expectations for the dashboard. |
| S2 | *Tech Services Staff Augmentation Scope of Work*, September 2026 | 5 PDF pages | Staff augmentation scope: broader DWRi modernization engagement (legacy infrastructure, staffing, MapServer assessment, new applications) of which this dashboard is one part. |
| U1 | User instruction (stack direction) | n/a (instruction) | User stack direction: use GeoLibre with MapLibre GL JS, NeoServer for published geospatial services, and Google Cloud PostgreSQL with PostGIS plus a proposed TimescaleDB component; do not add SensorThings unless a specific compatibility need is established. |

## Evidence scheme

Requirement rows in the specification and traceability CSV cite evidence as:

- **S1** — an explicit source requirement in the S1 requirements draft (PDF page references use the PDF page number, not the printed footer, which is usually one lower).
- **S2** — an explicit statement in the S2 staff augmentation scope of work.
- **U1** — the user's stack and integration direction.
- **S1 + proposal** — an S1-derived need with an added stated implementation or policy decision that requires DWRi confirmation.

S1 supplies user needs; it does not approve a final permissions policy or database schema. S2's broader modernization workstreams remain separate from this dashboard build.

## Location of source artifacts

The source PDFs (S1, S2, and the 2024 technology modernization roadmap) were consolidated into [`docs/delivery/sources/`](../delivery/sources/) on 21 October 2026. The [`delivery package register`](../delivery/README.md) records that consolidation. The `docs/product/baseline/` snapshot captures the derived specification documents; it does not replace the source PDFs.
