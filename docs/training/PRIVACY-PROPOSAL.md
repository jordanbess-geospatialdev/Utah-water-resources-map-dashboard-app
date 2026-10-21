# Analytics privacy, consent and retention proposal (WD-020)

Status: **PROPOSED - NOT OPERATIONAL. NO analytics of any kind are being
collected today.** This document is the proposal the agency owner decides
on. The owner agreement itself is a decision we cannot claim: every open
decision below is marked **PENDING** and stays PENDING until the agency
owner records it.

Requirement anchors:
- FR-017 (usage and operational analytics): "Approved analytics report
  visitor, user and download counts by day, month and year; credentials,
  sensitive query content and internal records are excluded from
  third-party telemetry."
- Technical specification, "Proposed service targets and operations":
  "Obtain a privacy decision before session-replay analytics; mask
  sensitive fields and exclude administrative/field content by default."
- FR-068 (training): task-completion measurement for training checklists.

Implementing modules (behavior exists and is tested; collection stays off
without consent):
- `services/api/src/support/analytics.ts` - the consent gate, the static
  event field allowlist, retention windows, withdrawal deletion.
- `apps/web/src/features/help/consent.ts` - the browser consent record.

## 1. What would be collected (PROPOSED)

First-party application analytics only, in two event shapes:

| Event | Fields (the complete allowlist) |
| --- | --- |
| page-view | kind, routeId, dimensionKeys, appVersion, occurredAt, day |
| task-completed | kind, routeId, taskStepId, appVersion, occurredAt, day |

- `routeId` is a governed route identifier (for example `discovery`,
  `site-detail`, `help`).
- `dimensionKeys` records WHICH filter dimensions were used - dimension
  identifiers only, never the values selected. "Query content beyond
  dimension ids" never leaves the browser (FR-017).
- `taskStepId` is a training checklist step id (docs/training).
- `day` is the reporting day keyed in the program zone (America/Denver), so
  a user's browser timezone never redefines a reporting day.
- Reported aggregates (the only outputs): visitor/user/download counts by
  day, month and year (FR-017). Aggregates carry no account identifiers.

## 2. What would NEVER be collected (the exclusion list)

Enforced structurally by the static field allowlist - there is no field a
caller could put these into, and events carrying any non-allowlisted field
are dropped whole (tested):

- Credentials of any kind (passwords, tokens, API keys, session material).
- Query content beyond dimension identifiers - filter VALUES, search text,
  natural-language search utterances.
- Internal records: internal notes, gate codes, contact and ownership
  details, restricted or internal station data.
- Screenshots or attachments (feedback references are attachment ids, and
  are not analytics events at all).
- Persona labels, roles and entitlement grants.
- Free text of any kind.

Session replay, heatmaps and any third-party telemetry are **out of scope
for this proposal** and would require a separate privacy decision per the
technical specification (decision D-6).

## 3. Consent mechanism

- **Opt-in only, per account, explicit.** No event is recorded unless the
  account has granted consent; refusal stores nothing - not even a denial
  placeholder (tested).
- The consent decision names the policy version it answered
  (`ANALYTICS_POLICY_VERSION = '2026-10-21.1'`, this document's revision).
  Changing this proposal invalidates stored consent: users are re-asked,
  never carried over (tested).
- **Withdrawal** is one action, effective immediately: collection stops on
  the very next event and the account's pending raw events are deleted in
  the same call (tested). The browser additionally clears its stored grant
  so no consented call can be attempted from that device.
- Anonymous (not signed-in) visitors: no account exists to hold consent, so
  no analytics are recorded for them under this proposal. Whether anonymous
  aggregate counting is desired at all is decision D-5.

## 4. Retention (PROPOSED)

| Data | Retention | Basis |
| --- | --- | --- |
| Raw consented events | **90 days** | D-2 (PENDING) |
| Day-keyed aggregates | **13 months** | D-2 (PENDING) |
| Consent records | Life of the account + withdrawal audit window | D-3 (PENDING) |

These windows are implemented in `analytics.ts` (`RAW_RETENTION_DAYS`,
`AGGREGATED_RETENTION_MONTHS`) so the owner approves real behavior, not
intent. Both constants are **PROPOSED** until D-2 is recorded.

## 5. Storage, access and security

- Storage: application backend (the same boundary as audit events); the
  technical specification's rule "Redact tokens and private notes from logs
  and analytics" applies to every pipeline stage.
- Access: program administrators for aggregated reports only; raw events
  restricted to the analytics operator role (D-4 defines who).
- No cross-site tracking, no advertising, no external analytics vendor
  under this proposal (D-1 records the first-party determination).

## 6. Owner decision register

| # | Decision | Options as proposed | Status |
| --- | --- | --- | --- |
| D-1 | Approve first-party analytics scope (two event shapes above) and the exclusion list | Approve as written / amend list / reject | **PENDING** |
| D-2 | Retention windows | Raw 90 days, aggregates 13 months (as implemented) / other windows | **PENDING** |
| D-3 | Consent record retention and whether withdrawal deletes the decision history | Keep decisions for audit / delete on withdrawal | **PENDING** |
| D-4 | Who may read raw events vs aggregates | Program administrators (aggregates) + named analytics operator (raw) / other | **PENDING** |
| D-5 | Anonymous visit counting (no consentable account exists today) | None (as implemented) / IP-truncation based counting under a separate decision | **PENDING** |
| D-6 | Session replay / heatmap tooling | Out of scope (as implemented) / separate proposal with its own privacy decision | **PENDING** |

Decision recording: replace a PENDING cell with the decision, the deciding
role, and the date; bump `ANALYTICS_POLICY_VERSION` in BOTH
`services/api/src/support/analytics.ts` and
`apps/web/src/features/help/consent.ts` so existing consent is re-asked
against the amended proposal.

## 7. What we are NOT claiming

- No analytics collection is live; the consent gate ships dark.
- No agreement by the agency owner is claimed or implied by this file.
- Session replay is not proposed here and not implemented anywhere in this
  repository.
