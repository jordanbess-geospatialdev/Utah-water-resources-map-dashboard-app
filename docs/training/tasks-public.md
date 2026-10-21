# Public user training checklist (WD-020, FR-068)

Audience: Donna (public/policy overview), Wiley (water user), Sarah
(researcher). Fixture world: seed `utah-water-fixture-v1`. Every task lists
the feature module, the steps, and the observable outcome a trainer checks.
Task ids match the onboarding tour steps
(`apps/web/src/features/help/OnboardingTour.tsx`).

## Donna - public / policy overview

### pub-discover - Discover stations
- Module: `apps/web/src/features/discovery` (DiscoveryFiltersPanel, map/table
  parity).
- Steps: open the dashboard without signing in; confirm the map and the
  table show the same stations; pan/zoom and watch the table follow.
- Observable outcome: the trainee can name how many stations are currently
  in view from either surface, and the counts agree.

### pub-filter - Filter the view
- Module: `apps/web/src/features/discovery/filters.ts` (typed FilterSet).
- Steps: filter to the Bear River distribution system; add a site type
  filter (flume); set telemetry to "manual"; then clear one filter.
- Observable outcome: the trainee states the rule ("values within a filter
  are OR, filters combine as AND") and the row count changes as each filter
  is applied and removed; an empty result says so - never a fake zero.

### pub-indicator-read - Interpret an indicator
- Module: `apps/web/src/components/StatusIndicator.tsx` (shape + text, never
  color alone).
- Steps: find a Reporting station, a Stale station and the inactive station
  (sta-summit-creek-inactive in the fixture world); open each site card.
- Observable outcome: the trainee reads value, unit, observation time and
  freshness from the card, and explains that "No data" is a real state, not
  a zero reading.

### pub-share - Share a view
- Module: `apps/web/src/features/discovery/shareUrl.ts` (FR-008 versioned
  codec).
- Steps: set filters, an extent and a selected site; copy the share link;
  open it in a private window.
- Observable outcome: the private window reproduces filters, extent and
  selection; the trainee can say what a link never carries (persona,
  credentials, internal notes, restricted sites).

### pub-feedback - Report a problem
- Module: `apps/web/src/features/help/HelpPanel.tsx` (FR-018).
- Steps: open Help; start a report; read the support-context preview BEFORE
  submit; send.
- Observable outcome: the trainee points at the preview and states exactly
  what will ship (share link, app version, timestamp) and what was omitted.

## Wiley - water user

### usr-signin - Work with organization data
- Module: `apps/web/src/features/operations` (assigned scope via the policy
  engine).
- Steps: switch to the water-user persona (organization org-cache-water);
  locate the organization's restricted delivery station alongside public
  ones.
- Observable outcome: the trainee sees the owner station's public companion
  data and understands restricted records appear only through the owner
  organization's grant.

### usr-favorite - Favorite a site
- Module: `apps/web/src/features/favorites` (FR-009/FR-052).
- Steps: favorite one station; open My Sites; remove the favorite; re-add
  it.
- Observable outcome: the favorite persists across reloads; the trainee
  states that favoriting never grants access to anything.

### usr-alert - Manage notification preferences
- Module: `apps/web/src/features/favorites/notificationPrefs.ts` (FR-025).
- Steps: subscribe a favorite to "no signal" alerts at daily cadence; try to
  subscribe to a site outside the readable scope.
- Observable outcome: the in-scope subscription saves; the out-of-scope one
  rejects with the engine's reason next to the form.

### usr-share and usr-access - Share safely, report access problems
- Same as `pub-share`; for access problems use Help category "Access
  problem".
- Observable outcome: same as pub-share plus: the report is anonymous or
  attributed to the signed-in account, as the trainee chooses.

## Sarah - researcher

### res-filter-variables - Filter to research variables
- Module: `apps/web/src/features/discovery/filters.ts` (observed property,
  processing level, method type dimensions).
- Steps: filter to discharge at "reviewed" processing level; then add
  method type "rating"; inspect any chip the vocabulary does not know.
- Observable outcome: unknown-but-valid values stay visible and are listed
  for the data dictionary (FR-060), not silently dropped.

### res-site-detail - Read a series with provenance
- Module: `apps/web/src/features/series` (chart/table, raw vs
  best-available selector).
- Steps: open a site; switch the processing selector raw -> best available;
  open the quality history.
- Observable outcome: the trainee explains the difference and can find the
  revision that produced a best-available value.

### res-dictionary - Use the data dictionary
- Module: `apps/web/src/features/discovery/DataDictionaryPanel.tsx`.
- Steps: open the dictionary; look up one filter term and one unknown value
  encountered above.
- Observable outcome: definitions found; the unknown value is clearly
  marked as not in the current vocabulary.

### res-export - Export a reproducible extract
- Module: `apps/web/src/features/series/ExportPanel.tsx`, then
  `apps/web/src/features/developer-access` (FR-064 scoped tokens).
- Steps: export the filtered view as CSV; copy the share link of the same
  view; (account permitting) review a scoped API token's lifetime and
  scopes.
- Observable outcome: the CSV's filters match the link's filters; the
  trainee states that tokens are revocable and never exceed current grants.

### res-feedback - Report data questions
- Module: `apps/web/src/features/help/HelpPanel.tsx`, category "Question
  about the data".
- Observable outcome: same preview discipline as pub-feedback.
