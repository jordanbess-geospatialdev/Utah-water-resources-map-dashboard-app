# Rating curves and shifts

Creating or superseding a version requires the station's scoped `edit-site-metadata` capability. Approving a draft curve or shift requires a separate, explicit `approve-rating-curves` grant covering that station. QC review and general statewide administration do not satisfy approval.

The shared policy engine checks current assignment scope, revocation, principal status and delegation dates before changing approval state. Existing version history, effective periods, conversion lineage and audit records remain retained. The default engineer can author but has no approval grant. Accountable approver roles and actual production assignments still require program-owner ratification.

The sample steward has an explicit approval grant. Tests add scoped commissioner/deputy grants locally, and independently verify that their default QC grants and general administration alone cannot approve. The web rating-curve panel is read-only.

Run the domain tests from the repository root:

```sh
node --test --experimental-strip-types services/api/src/workflows/rating-curves/test/*.test.ts
```
