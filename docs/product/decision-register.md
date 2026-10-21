# Open Decision Register

Task WD-001 | 21 October 2026

This register consolidates, without resolving any of them, every row of the "Open product decisions" table in [baseline/01-product-requirements.md](baseline/01-product-requirements.md) (source PRD) and the "Release qualification and open decisions" table in [baseline/03-architecture.md](baseline/03-architecture.md) (source ARCH). Decision wording, owners, and consequences are quoted from the source tables.

| ID | Decision needed | Accountable owner | Consequence / blocks | Status | Source |
| --- | --- | --- | --- | --- | --- |
| DR-001 | Role grants, deputy delegation, engineer regional scope, public provisional visibility and diagnostic visibility | DWRi governance and section leads | Freezes the permission matrix and denial test cases before real records are connected. | open | PRD |
| DR-002 | Raw withdrawal and retention policy; vocabulary overlap; official processing-level definitions | Data steward and records owner | Defines audit behavior, deletion semantics and supported historical reconstruction. | open | PRD |
| DR-003 | Steward versus engineer ingestion setup responsibility | Data Services and Automation leads | Separates request, validation and production promotion permissions. | open | PRD |
| DR-004 | Supplier reporting ownership, boundary approval and reviewer state machine | Water Use Program owner | Confirms R2 interface and prevents a report workflow being inferred from the commissioner role. | open | PRD |
| DR-005 | Existing PostgreSQL host, TimescaleDB feasibility, observation schema, API ownership and HydroServer migration boundary | DWRi and DTS platform teams | Determines the time-series deployment and adapter work without changing the agreed map experience. | open | PRD |
| DR-006 | Identity and UtahID integration, external researcher registration and token policy | DWRi and DTS security owners | Resolves single sign-on and the proposed one-time secret-display deviation. | open | PRD |
| DR-007 | Persona prototype validation and water-user link target | Product and design owners | Review all six supplied Figma flows against the source journeys. The water-user and commissioner links share node 1193-1908 with different page parameters, so verify the intended water-user frame before accepting visual fidelity. | open | PRD |
| DR-008 | Pilot cohort, data-volume profile, operational objectives and final release scope | Product owner with operational teams | Converts proposed performance and usability targets into approved release acceptance. | open | PRD |
| DR-009 | Database service and extensions | DWRi DBA/cloud owner | Inventory, private connection, privileges, backup and restore | open | ARCH |
| DR-010 | Entitlements and automation deletion | Data governance steward | Approved action/scope matrix, retention and exclusion policy | open | ARCH |
| DR-011 | Identity and research token lifecycle | Security/identity owner | OIDC issuer, session controls, token policy and revocation test | open | ARCH |
| DR-012 | Figma design baseline | Product/design owner | All six prototype flows inspected, commissioner/water-user shared node link verified, usability acceptance | open | ARCH |
| DR-013 | Existing ingestion and WCAT integration | Technical Services/data owner | Actual schemas, IDs, API contracts, ownership and reconciliation plan | open | ARCH |
| DR-014 | Water totals and report definitions | Hydrologist/program owner | Time zones, units, seasons, aggregation boundaries and golden examples | open | ARCH |
| DR-015 | Public release and internal attachments | Governance/privacy owner | Field projection, public/provisional policy and attachment visibility | open | ARCH |
| DR-016 | NeoServer service maturity and recovery | Platform owner | Multi-format isolation tests, cache freshness, backup/restore and fenced restart | open | ARCH |
| DR-017 | Offline capture and device retention | Field operations/security | Revocation/conflict/loss scenarios and supported browser behavior | open | ARCH |
| DR-018 | Operational targets and budget | Product/platform owners | Agreed load dataset, measured latency, SLO and cost model | open | ARCH |

Column mapping to sources: PRD rows carry the source's "Decision", "Owner to confirm", and "Consequence" columns; ARCH rows carry the source's "Decision", "Accountable owner", and "Required evidence before production" columns.

Count: 18 decisions (8 from PRD, 10 from ARCH), all open. No decision in this register has been resolved; updates require a new owner-confirmed status with recorded evidence, not an edit in place by an implementing agent.
