# MVP UAT Plan and Sign-Off Record

Prepared 2026-10-21 | Machine qualification: PASSED (fixture evidence) | Human acceptance: **PENDING — named owners below**

Personas execute the task scripts in `jira_stories.md` §4 (per-persona UAT
scripts) against the staging environment once provisioned; facilitators record
task completion, timing and defects. The commissioner pilot criterion from the
requirements: at least 60% of a representative commissioner cohort completes the
core tasks unaided (cohort size and baseline times agreed with the product owner
before the pilot; the source's "about 30" approximation is not used as an exact
count).

## Sign-off register

Acceptance is personal and named. No line below may be signed by the delivery
agents; each owner signs only after reviewing the evidence cited in their row.

| # | Acceptance scope | Named owner (role) | Evidence to review | Name / Date | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | MVP scope, personas, terminology, Figma reconciliation | DWRi product owner | PRD baseline, figma-reconciliation.md, UAT results | ____________ | PENDING |
| 2 | Annual distribution report formulas, goldens, season definitions | Measurement/data governance owner | WD-008/WD-025 golden derivations, decision register DR-002/DR-014 | ____________ | PENDING |
| 3 | Permission matrix, deputy rules, raw-withdrawal policy | Data governance steward | Authorization matrix + policy suite (30 tests), DR-001/DR-010 | ____________ | PENDING |
| 4 | Identity, sessions, researcher token policy | Security/identity owner | Token policy, DR-006/DR-011, T-03 evidence plan | ____________ | PENDING |
| 5 | Accessibility conformance | Accessibility reviewer | Manual keyboard/screen-reader/zoom review on staging (T-11) — BLOCKED until browser environment available | ____________ | PENDING |
| 6 | Operations: monitoring, backup/restore, rollback, capacity | Platform/operations owner | ops/ runbooks, T-12/T-14 drill execution in staging — BLOCKED until staging | ____________ | PENDING |
| 7 | Database qualification (Cloud SQL vs self-managed, PostGIS/TimescaleDB) | DWRi DBA/cloud owner | DR-009 inventory, migration qualification run | ____________ | PENDING |
| 8 | Analytics privacy/consent/retention | Governance/privacy owner | PRIVACY-PROPOSAL.md decisions D-1..D-6 | ____________ | PENDING |
| 9 | Commissioner representative UAT | Named commissioner(s) | Task-based UAT scripts, 60% unaided criterion | ____________ | PENDING |
| 10 | Engineer/steward representative UAT | Named engineer + steward | Task-based UAT scripts | ____________ | PENDING |
| 11 | Public/researcher representative UAT | Named public or researcher user | Task-based UAT scripts | ____________ | PENDING |
| 12 | Production change authorization | Approving authority | All rows above + release notes + rollback rehearsal | ____________ | PENDING |

## Rules

1. A PENDING row with a BLOCKED evidence citation cannot be signed; unblock the
   environment first (staging identity, database, browser access).
2. Defects found in UAT are filed against the Jira program (jira_stories.md)
   with severity; the qualification tripwires must remain green during fixes.
3. Deferred R2/Discovery items (release notes) do not block any row above.
4. This record, once fully signed, authorizes production change request — it is
   not itself the deployment approval.

Agent: orchestrator
