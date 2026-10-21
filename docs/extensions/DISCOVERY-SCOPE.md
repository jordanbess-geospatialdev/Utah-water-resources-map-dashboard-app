# Discovery Scope — Advanced Site Configuration and Right-Network Integrations

Task WD-023 | FR-050, FR-067 | Prepared by the orchestrator, 2026-10-21
Status: **Discovery — no production gate depends on this scope** (per the development plan, Discovery items never block MVP or R2 acceptance).

## FR-050 — Advanced field configuration and access information

The requirement (S1 PDF pp. 47-50) calls for equipment addresses, communications
links, custom ingestion headers, and optional access points. These fields are
operationally sensitive (they describe how to reach and command physical
infrastructure) and their source systems are not yet identified.

### Required before any implementation slice
1. **Data availability inventory** (owner: DWRi Data Services): where equipment
   addresses, comm-link configs, and access-point records live today; volumes;
   change cadence; whether WCAT or vendor systems are authoritative.
2. **Classification decision** (owner: governance/privacy): these fields are
   internal-only by default under the FR-049 visibility wall; the decision
   record must confirm no public/cohort projection will ever carry them.
3. **Contract**: a field-level schema (ids, formats, retention) ratified by the
   steward before the first fixture exists — the same contract-first discipline
   as WD-002.
4. **Acceptance fixture**: approved fixtures demonstrating correct access and
   parsing BEFORE any such field is exposed (per the FR-050 acceptance row).

## FR-067 — Extended modeling and transaction transparency

Rights-to-field links, change-application effective history, OpenET comparison,
depletion, apportionment, and machine-readable transaction schedules (S1 PDF
pp. 35, 50-51, 69-70).

### Required before any implementation slice
1. **Authoritative source ownership** (owner: DWRi + Water Rights): which
   system is authoritative for rights, ownership change history, and
   transactions; API or bulk-export availability; refresh cadence.
2. **OpenET**: licensing terms, API quotas, area-of-interest limits, and the
   privacy review for sending field boundaries to an external service
   (mirrors the WD-020 analytics-consent discipline; no external call before
   approval).
3. **Modeled-vs-measured separation**: every modeled artifact must carry
   provenance distinct from measured values (the FR-067 acceptance demands
   fixtures distinguishing measured inputs from modeled results — reuse the
   lineage patterns from WD-011-R2/WD-025-R2).
4. **Separate delivery scope**: a Jira epic (see jira_stories.md EP-10) with
   its own acceptance; nothing here enters MVP/R2 release notes as
   functionality.

## Non-goals

This document does not approve implementation; it defines what must be true
before a separately approved Discovery contract begins. No initial production
gate depends on unresolved Discovery.

Agent: orchestrator
