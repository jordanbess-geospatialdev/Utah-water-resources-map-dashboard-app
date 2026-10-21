# Training plan - Utah Water Measurement Data Dashboard (WD-020)

Requirement anchor: FR-068 - "A user can complete a short role-relevant tour
and disable its automatic return; commissioners receive task-based training,
and observed pilot task failures feed a prioritized backlog with named
owners."

## How training is organized

| Audience | Checklist | Personas |
| --- | --- | --- |
| Public users | [tasks-public.md](tasks-public.md) | Donna (public/policy), Wiley (water user), Sarah (researcher) |
| Operational users | [tasks-operational.md](tasks-operational.md) | Cody (commissioner), Fatima (engineer), Diego (steward) |

Each task in a checklist is a short, observable scenario: the trainee does
something specific, and the expected outcome is something a trainer can
watch for - not a feature tour. Every task cites the feature module that
implements it and, where relevant, the requirement it traces to.

## The three FR-068 mechanisms and where they live

1. **Role-relevant tour** - `apps/web/src/features/help/OnboardingTour.tsx`:
   5-7 steps per persona, first visit only, skippable, with the
   disable-auto-return choice persisted per persona. Step ids in the tour
   (`pub-*`, `usr-*`, `res-*`, `com-*`, `eng-*`, `stw-*`) match the
   checklist task groups below.
2. **Task-based training** - the two checklists in this directory.
   The Help panel (`apps/web/src/features/help/HelpPanel.tsx`) summarizes
   the same tasks in-app and links each persona to their checklist.
3. **Feedback into a prioritized backlog** - feedback submitted from Help
   (`services/api/src/support/feedback.ts`) carries a redaction-verified,
   reproducible support context (FR-018) and lands in the steward queue with
   a P1-P4 priority; observed pilot task failures are reported from the task
   screen with the checklist step id in the category "Training feedback".

## Trainer notes

- Run training against the fixture world (seed `utah-water-fixture-v1`).
  Trainee actions cannot break it, and every expected outcome below is
  reproducible there.
- Trainees should be told up front what the dashboard never asks of them:
  no passwords or tokens in any text field, and share links carry only
  filters, map extent and a selected public site (FR-008).
- Task completion measurement is opt-in analytics only
  (`services/api/src/support/analytics.ts`); without consent, training
  verification stays manual. The consent ask and retention proposal are in
  [PRIVACY-PROPOSAL.md](PRIVACY-PROPOSAL.md) - PENDING agency owner decision.

## Recording pilot failures

When a trainee cannot complete a task, the trainer reports it from the Help
panel on the exact screen, category "Training feedback", including the
checklist step id (for example `pub-indicator-read`). The steward queue then
carries a reproducible link (public view state only) and assigns priority
per FR-018. Named owners for the resulting backlog items are assigned by
the program (a steward decision, not a code default).
