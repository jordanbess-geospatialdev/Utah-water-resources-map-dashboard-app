# Operational user training checklist (WD-020, FR-068)

Audience: Cody (commissioner), Fatima (field engineer), Diego (data
steward). Fixture world: seed `utah-water-fixture-v1` - assignments are
Bear River (Cody, Fatima) and statewide (Diego). Every task cites its
feature module and the observable outcome a trainer checks. Task ids match
the onboarding tour steps.

## Cody - commissioner

### com-morning-review - Morning review
- Module: `apps/web/src/features/operations` (OperationsWorkspace,
  assignedScope via the policy engine).
- Steps: open the assigned workspace; identify stations with stale or
  missing readings; open one site detail to compare against the previous
  day.
- Observable outcome: the trainee lists which of the assigned stations
  reported late and names the freshness state of each (shape + label), and
  sees nothing outside the Bear River assignment.

### com-enter-reading - Enter a single reading
- Module: measurement entry surface (technical specification, "Measurement
  entry"; validation in `services/api/src/series`).
- Steps: enter a reading with the wrong unit; correct the unit; commit with
  a valid value.
- Observable outcome: the wrong-unit attempt is refused with a row-level
  error before commit; the committed reading appears with the actor and
  time recorded.

### com-bulk-paste - Bulk paste a season of readings
- Module: imports workflow (`services/api/src/exports`, staged
  validate/commit per the technical specification "Bulk paste/import";
  366-row minimum scenario).
- Steps: paste a full season of daily readings including one bad row and
  one duplicate; validate; inspect the row report; fix and commit.
- Observable outcome: the trainee sees per-row errors and duplicates BEFORE
  commit, and states the batch rule - the whole validated batch commits
  once, or the precise row report explains what did not.

### com-correction - Correct a value with an audit trail
- Module: `apps/web/src/features/quality-history` (derivation),
  `services/api/src/workflows/revisions` (append-only revisions).
- Steps: select a point in QA review; append a correction with a qualifier
  and a written reason; open the history.
- Observable outcome: the original value is still visible, the correction
  carries actor/time/qualifier/reason, and the trainee explains why
  corrections append rather than overwrite.

### com-deputy - Understand delegation (awareness task)
- Module: policy engine delegation tests (`packages/policy`,
  deputy commission in `fixtures/contracts/principals.json`).
- Steps: review that deputy authority (Ana in the fixture world) exists
  only inside its effective/expiry window.
- Observable outcome: the trainee states that a deputy's actions are scoped
  and time-bounded, never automatically statewide.

### com-feedback - Report a defect reproducibly
- Module: `apps/web/src/features/help/HelpPanel.tsx` (FR-018).
- Steps: from the exact screen, report a defect; read the preview,
  including any "selected site omitted" notice when the view contained a
  restricted selection; send.
- Observable outcome: the trainee explains that the steward receives a
  reproducible PUBLIC link even when the reporter's own view included
  restricted data.

## Fatima - field engineer

### eng-diagnostics - Diagnose a station
- Module: `apps/web/src/features/operations` (internal diagnostics via the
  projection layer's entitlement path).
- Steps: open a Bear River station's diagnostics; check the internal
  battery-voltage stream and the equipment/deployment history.
- Observable outcome: internal blocks are visibly marked internal and
  unavailable to personas without the grant (cross-check with the public
  persona).

### eng-connection-health - Connection health
- Module: connection digests (technical specification "QC tasks ...
  connection digests"; steward console routes).
- Steps: open the connection digest; distinguish a failed provider from
  failed tasks; open the filtered task view.
- Observable outcome: the trainee names which layer failed and what Monday
  weekend coverage means for the timing.

### eng-field-work - Record field documentation
- Module: field work surface (technical specification "Engineer field
  work").
- Steps: record an inspection with an internal attachment; verify the
  attachment's visibility class.
- Observable outcome: the attachment stays internal; public viewers see no
  trace of it.

### eng-qa-review - QA review and correction
- Same as `com-correction`, performed on an interval rather than a point.
- Observable outcome: identical audit guarantees; the trainee additionally
  explains the raw vs best-available distinction after correction.

### eng-feedback - Report defects
- Same as `com-feedback`.

## Diego - data steward

### stw-assignments - Manage users and assignments
- Module: steward console (`GET /admin/connections`, `PUT
  /admin/assignments/{id}` contract rows; policy engine).
- Steps: review an assignment; revoke it; observe the effect on the
  affected user's next request.
- Observable outcome: revoked access is denied on the next protected
  request - the trainee states that caches cannot extend access.

### stw-vocabulary - Govern the universal vocabulary
- Module: universal vocabulary governance (steward console).
- Steps: inspect the observed-property and processing-level vocabularies;
  confirm unknown values in old links remain inspectable.
- Observable outcome: the trainee explains how a vocabulary change does not
  break old share links (values stay visible and inspectable).

### stw-health - QC configuration and connection health
- Module: QC rule configuration (versioned rules; technical specification
  "QC tasks").
- Steps: review the configured checks (range, rate of change, persistence,
  missing, zero); open the task-failure isolation view.
- Observable outcome: the trainee explains versioning of a QC rule and
  where its run history lives.

### stw-queue - Triage the feedback queue
- Module: `services/api/src/support/feedback.ts` (steward queue, P1-P4;
  FR-018).
- Steps: open the queue; open a report's reproducible link; assign
  priorities; resolve or dismiss one report.
- Observable outcome: the queue is ordered by priority then recency; the
  trainee confirms a report's link reproduces the user's PUBLIC view and
  that no secrets or restricted identifiers are present anywhere in the
  record.

### stw-consent - Analytics consent administration (awareness task)
- Module: `services/api/src/support/analytics.ts`;
  [PRIVACY-PROPOSAL.md](PRIVACY-PROPOSAL.md).
- Steps: review that collection is opt-in per account and that withdrawal
  deletes pending events immediately; review the retention proposal.
- Observable outcome: the trainee states that nothing is collected without
  consent and that retention windows are PENDING the agency owner's
  decision - not to be represented as agreed.

## Recording failures

Any task a trainee cannot complete is reported from the Help panel on the
task's screen, category "Training feedback", quoting the task id (for
example `com-bulk-paste`). The steward queue prioritizes it per FR-018 and
the program assigns a named owner for the backlog item (FR-068).
