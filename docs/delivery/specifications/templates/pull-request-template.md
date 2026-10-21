# PR: <task ID> — <one-line outcome>

<!--
Copy to .github/pull_request_template.md in the production repository.
CI blocks merge when this template's scope, lockfile, migration or trailer
checks fail. The implementer never approves its own PR.
-->

**Task:** WD-xxx
**Agent role:** <owner key from backlog.json>
**Base branch:** integration

## Requirement coverage

- FR-xxx: <how this PR advances it; "partial" is acceptable and must be stated>
- NFR-xxx: <if applicable>

## Commands executed and results

<!-- Only checks actually run in this branch. A proposed command is not a result. -->

| Command | Result |
| --- | --- |
| `pnpm test` | <pass/fail, counts> |
| `pnpm run typecheck` | <pass/fail> |
| <task-specific checks, e.g. T-xx scripts> | <result> |

## Evidence

- <path or URL to artifacts: fixtures, screenshots, logs, golden-value diffs>
- Reviewer reproduction instructions: <exact commands + fixture seed>

## Scope declaration

- Changed paths outside `write_scopes` for WD-xxx: **none** / listed below with reason
- `pnpm-lock.yaml` changed: **no** (must be no outside `chore/deps-*`)
- Migration files: appended only / **none**
- Commit trailers `Task:`/`Refs:`/`Tests:`/`Agent:` present on every commit: **yes**

## Decisions and open questions

- <assumptions taken, contract versions used, items escalated to the orchestrator>

## Checklist

- [ ] Independent reviewer (different agent or human) reproduced the checks
- [ ] No secrets, personal data, or unpublished measurements in diffs or logs
- [ ] Synthetic fixtures only
- [ ] Handoff note recorded with status, blockers and next owner
