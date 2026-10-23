# Scoped operational and approval permissions

WD-027 | 21 October 2026 | Implementation amendment, policy vocabulary 0.2.0

The roadmap/persona review identified overloaded review permissions, implicit
raw-withdrawal authority, and a mismatch between runtime and persisted supplier
roles. This amendment supplements the preserved product baseline. It keeps the
six UX personas and makes operational actions independently assignable.

## Capability contract

| Capability | Authorized operation | Grant boundary |
| --- | --- | --- |
| `record-data-issues` | Record known stream issues and change their status | Assigned stream/site/system; independent of measurement review |
| `manage-thresholds` | Create, revise and promote site/system diagnostic thresholds | Assigned scope; independent of program-wide rules |
| `manage-qc-rules` | Author, revise, test and promote program-wide automated QC rules | Steward capability; governance object scope still required |
| `review-data` | Assert the reviewed processing level or perform an explicit level advance | Assigned scope; correction also requires `revise-best-available` |
| `approve-rating-curves` | Approve a curve or shift | Explicit scoped grant; no implication from review or administration |
| `finalize-accounting` | Finalize or supersede an accounting record | Explicit scoped grant; no implication from review or administration |
| `withdraw-raw` | Exclude an erroneous original while retaining provenance | Explicit scoped grant, including for a steward |

Field, automation and regional engineer profiles permit issue recording,
threshold management and measurement review as separately assignable actions.
The modeler profile remains read/export oriented. Profile membership is a grant
ceiling, not an automatic grant. Approval capabilities can be explicitly assigned
within the commissioner, deputy or steward families; actual assignees remain a
governance decision. Deputy grants retain their delegation window.

General statewide application administration retains operational issue,
threshold and QC-rule management. It does not satisfy raw withdrawal, curve
approval or accounting finalization. New actions do not confer internal
diagnostic-field access. Scope, active-account status, expiry, revocation and
target lifecycle checks continue to apply.

Ordinary provisional and best-available corrections remain available to assigned
editors. Asserting `reviewed`, or using an explicit `level-advance`, additionally
checks `review-data` before idempotency replay. Removing review authority therefore
also blocks a retry of an earlier reviewed correction.

## Contract and migration

The `public` and `water-user` role families already supported by runtime code
are now represented in both OpenAPI assignment shapes, the entitlement JSON
schema and the SQL assignment constraint. Contract version 0.1.1 includes a
forward migration; existing migrations are unchanged. Automated consistency
checks compare the runtime, grant validator, wire contracts and effective SQL
role vocabulary, including a representative organization-scoped supplier grant.

This migration only changes accepted role names. It assigns no new authority to
existing users. An existing account that needs raw withdrawal or approval must
receive the corresponding explicit grant through the approved process; no
automatic expansion from `review-data` or `statewide-administration` is performed.

Demo fixture grants are illustrative: Diego explicitly holds the three sensitive
actions; Fatima and Priya hold issue recording within their existing systems;
Cody holds issue recording and threshold management. No engineer fixture gains
processing review automatically, and Cody/Ana do not gain approval by default.

## Decisions retained for DWRi

DR-001/002/003/004/010 remain open. This implementation does not ratify the
identity of reviewers, regional membership rules, retention policy, ingestion
ownership, or the supplier approval state machine. The existing supplier
`owner`-as-reviewer mapping remains provisional. Named QC technician and external
submitter profiles can use the scoped engine once their grants are approved.

Roadmap basis: Task 2.3 (PDF p. 24), Task 3.1 (pp. 27-28), Task 3.2 (pp. 28-29),
Task 3.3 (p. 30), and personnel/governance (pp. 37-39). Requirements basis:
FR-010/011/022/038/039/040 and the engineer, steward and supplier permission rows.
