# Utah Water Measurement Dashboard Product Requirements

Version 1.0 | 21 October 2026 | Product baseline proposed for DWRi review

The dashboard gives commissioners timely measurements, engineers traceable correction and maintenance tools, water users understandable site data, researchers reproducible downloads, and the public trustworthy summaries. It uses GeoLibre with MapLibre GL JS for the map experience and NeoServer for published geospatial services. Domain APIs enforce permissions and manage measurement, review, reporting, and notification workflows against the existing Google Cloud PostgreSQL and PostGIS environment. TimescaleDB is subject to confirmation of the actual database hosting service and available extension support.

## Product outcomes

1. Commissioners can find their sites, compare current conditions, enter a batch of readings, and verify corrections without transferring data among separate logins.
2. Every published value carries its unit, observation time, quality status, source, and processing level; a correction preserves the evidence behind earlier decisions.
3. Internal photographs, equipment addresses, and owner-specific records remain protected across maps, APIs, exports, reports, and cached responses.
4. Public users can discover and summarize published measurements without creating an account; authenticated users gain capabilities according to their assignment.
5. Data and operations teams can identify failed ingestion connections and QC problems without reviewing every station manually.

The first pilot should measure task success with commissioners of varying technical confidence. The source asks that at least 60% of the approximately 55 commissioners and deputies can use the interface independently; the pilot target is at least 60% completing the agreed core tasks without facilitator intervention. The source's accompanying approximation of "about 30" is not used as an exact acceptance count. A representative pilot cohort and baseline completion times must be agreed before claiming usability improvement.

## Scope and evidence

**S1** is the supplied *Updated 2026 User-Centric Design Requirements for the Water Measurement Data Dashboard*, September 2026 draft, 72 PDF pages. All page references below use the PDF page number, not the printed footer, which is usually one lower. **S2** is the supplied *Tech Services Staff Augmentation Scope of Work*, September 2026, five PDF pages. **U1** is the user's instruction to use GeoLibre and MapLibre, NeoServer mapping services, and Google Cloud PostgreSQL with PostGIS and a proposed TimescaleDB component, without adding SensorThings unless a specific compatibility need is established.

S1 supplies user needs; it does not approve a final permissions policy or database schema. Acceptance criteria, release assignments, operational targets, and the proposed role model below are product design choices derived from those needs. Rows marked **S1** retain an explicit source requirement. Rows marked **S1 + proposal** add a stated implementation or policy decision. S2's modernization engagement includes broader legacy infrastructure, staffing, MapServer assessment, and new applications; those remain separate workstreams rather than being silently included in this dashboard build.

### Release boundaries

| Release | Included work | Exit condition |
| --- | --- | --- |
| Prototype | Six persona entry points; representative map, filters, site detail, quality, scoped actions, and sample workflows using clearly labelled sample data. | Runs locally and passes the prototype checks recorded with the implementation. Role switching demonstrates navigation; it does not establish production authorization. |
| MVP | Public discovery and summaries; authenticated assignments; steward administration; site and stream setup; manual and bulk entry; corrections, provenance and QC; notifications; CSV and annual distribution reports; responsive browser UI. | Core acceptance scenarios pass with real staging identity and data integrations, access tests prove cross-scope denial, and DWRi accepts persona usability results. |
| R2 | Durable offline capture and conflict handling; expanded assets and inspection workflow; rating and shift governance; decision snapshots and historical reconstruction; WCAT integration; Water Use Program reporting. | Domain owners approve workflow contracts and migration/reconciliation results; offline and report acceptance scenarios pass. |
| Discovery | Advanced accounting, water-right-network links, computed natural-language questions, external modeling integrations, and formal visit scheduling. | A separate scoped contract defines ownership, authoritative inputs, semantics, and acceptance before implementation. |

Responsive access is MVP; offline persistence is R2. The source calls commissioner mobile entry a nice-to-have while describing engineer offline capture as a task. R2 preserves that need without claiming it is part of the first operational release. Supplier reporting is grouped in R2 because its review, boundary, validation, and report lifecycle require a separate product owner and interfaces to the existing Water Use Program. Diego's Water Use Manager dashboard is explicitly future work in S1, PDF pages 21-22.

## Personas and proposed permissions

Personas describe task needs. Permissions are capabilities plus server-validated site, system, region, organization, or report assignments. A role name in the browser never grants access by itself. Multiple roles may be held by one person; the API evaluates the requested action and object scope, records the actor, and denies missing or expired assignments. Public visibility is independent of staff edit authority.

| Persona or role | Default workspace | Proposed authority | Important boundary |
| --- | --- | --- | --- |
| Donna, public user or policy reader | Public overview and statewide explorer | Read published sites, documented quality information, summaries, and permitted exports without login. | No special edit authority follows from director, legislator, or auditor status. Sensitive or unpublished data needs an explicit grant. |
| Wiley, registered water user | My Sites and public explorer | Save favorite public sites and personal alerts; view organization records assigned to the account. | Favoriting a site never confers edit or ownership rights. Supplier reports and boundaries need a verified organization assignment. |
| Sarah, researcher or consultant | Explorer, exports, API access | Read approved datasets and manage personal programmatic credentials within approved scopes. | A token cannot exceed the account's current authority or retrieve internal notes. |
| Cody, commissioner or deputy | Assigned distribution systems | Enter readings, review and correct allowed measurements, edit permitted site fields, and generate reports within assignments. | The manage workspace lists assigned sites. Public statewide browsing remains available. Deputy delegation is explicit, time-bounded, and audited. |
| Fatima, engineer | Assigned systems or region | Create and maintain assigned sites and streams; perform QC, inspections, and engineering tasks; access designated internal diagnostics. | Global vocabulary, universal distribution-system deletion, and permission assignment stay with the steward. Automation-specific raw withdrawal needs a separate capability. |
| Diego, data steward | All sites, governance, operations | Universal administrative site authority; users and assignments; authoritative controlled vocabulary and distribution systems; ingestion and QC administration. | Historical records survive deactivation. Application steward authority does not automatically grant infrastructure administrator or database-owner access. |

The server must enforce these boundaries for every read and mutation, including feature lookup, tiles, exports, audit history, batch operations, attachments, notification links, and report downloads. A narrow published view can be served through NeoServer. Owner-specific and internal workflows use domain APIs unless an equivalent server-side geospatial entitlement mechanism has been demonstrated and tested. NeoServer workspace roles must not be treated as a direct substitute for this domain policy.

Distribution, regional, automation and modeling engineers receive separate capability subsets within the engineer family. A modeling assignment does not automatically grant measurement correction, equipment configuration or raw-withdrawal authority; each action requires the corresponding approved capability and object scope.

## Primary journeys

**Commissioner morning review:** Sign in once, open assigned system, see recent flow and freshness for all sites, compare upstream and downstream conditions, inspect a flag, enter or paste readings, review changed values with qualifiers, then save with an audit receipt. A correction conflict leaves the user's intended change available for review and does not overwrite another person's revision.

**Engineer inspection:** Open an assigned site, check battery voltage and known issues, review equipment and inspection history, record maintenance with categorized photographs, and apply a justified best-available correction. Raw values remain distinguishable. Offline drafts later synchronize under the engineer's current authorization; revoked authority prevents submission.

**Steward operations:** Review failed ingestion connections and QC violations, follow a link to the affected tasks, inspect provenance, update an approved rule, test it outside production, and promote the version with a recorded owner. Permission changes and controlled vocabulary changes are audited.

**Public or researcher exploration:** Start with a useful overview, filter by documented metadata, open a site with units and freshness, select a processing level and time interval, compare sites, and export a reproducible dataset with provenance. A natural-language request displays the resulting structured filters before applying them.

**Water supplier reporting in R2:** Open the verified organization's system, inspect sources and prior reports, propose boundary changes with comments, import or enter annual reporting data, resolve validation messages, submit a versioned report, and download the submitted PDF. Approval of a boundary and submission of a report are distinct state transitions.

## Functional requirements

Every requirement has a stable identifier. The traceability CSV repeats the rows below for backlog and test mapping. Acceptance criteria apply to the named release; inclusion here is not evidence that the prototype implements the complete production workflow.

### Shared discovery and account experience

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-001 | Public map and selectable basemaps | MVP | S1 PDF pp. 13, 16 | An anonymous user sees published sites on the map, switches approved topographic and imagery basemaps, and retains selection and filters; attribution remains visible. |
| FR-002 | Controlled manual metadata filters | MVP | S1 PDF pp. 13-16, 59 | Fixture queries for each named dimension return the expected site IDs; AND across dimensions and multi-select OR within a dimension are documented; unknown telemetry differs from no telemetry. |
| FR-003 | Natural-language metadata filtering | MVP | S1 PDF pp. 13-16; S1 + proposal | The three metadata examples on PDF p. 15 produce the same site IDs as manual filters; users inspect and edit the proposed filter set before applying; unsupported computed questions return a clear alternative without fabricated values. |
| FR-004 | Quick site card and detail link | MVP | S1 PDF p. 16 | Clicking a map site displays site and station identifiers, latest available value, unit, observation time and freshness, and a working detail link; missing readings render as unavailable rather than zero. |
| FR-005 | Site profile and measurement charts | MVP | S1 PDF pp. 19-20, 31, 41, 54-55 | A site profile shows authorized photos and location, available discharge or level series, quality status, reservoir storage where applicable, and units; a tabular alternative exposes the same selected data. |
| FR-006 | Aggregation and delivered volume | MVP | S1 PDF pp. 28-29, 31, 35 | Daily, weekly, monthly, and seasonal views produce agreed fixture totals and averages; conversions state units, time zone, coverage and gap policy; incomplete coverage is flagged and never silently filled with zero. |
| FR-007 | Site and year comparisons | MVP | S1 PDF pp. 29, 31, 41, 54-55 | Users compare selected upstream and downstream sites and years using common units and aligned intervals; unavailable periods remain visible as gaps and each series retains its source and quality legend. |
| FR-008 | Shareable dashboard state | MVP | S1 PDF p. 21 | Opening a copied URL reproduces public filters, selected site, time interval and map extent; inaccessible objects are omitted with a clear message and no credentials or internal note text are encoded in the URL. |
| FR-009 | Unified account and saved preferences | MVP | S1 PDF pp. 12, 16, 28 | One authenticated session supports the dashboard modules; favorites and display preferences survive sign-out and return; anonymous exploration remains possible. |
| FR-010 | Server enforcement of scoped capabilities | MVP | S1 PDF pp. 16, 18, 31, 45, 62; U1 | Direct requests outside the actor's scope are denied for single and batch APIs, feature services, exports and attachments; hiding a button or changing a browser role value does not authorize access. |

### Steward administration and operations

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-011 | User lifecycle and scoped assignments | MVP | S1 PDF pp. 18-19 | A steward assigns systems or sites to an engineer or commissioner, delegates a deputy with an expiry, and revokes access; deactivated actors remain identifiable in history and revocation affects the next authorized request. |
| FR-012 | Authoritative vocabulary and distribution systems | MVP | S1 PDF p. 19 | Only an authorized steward creates or retires distribution systems and global sensors, properties, units, qualifiers and processing levels; used terms cannot be deleted in a way that breaks historical records. |
| FR-013 | Provider and ingestion setup | MVP | S1 PDF pp. 19, 40; S1 + proposal | A steward registers a provider and site ingestion configuration, validates required parameters, and tests a connection in staging; engineer requests can be submitted but cannot bypass the approved ownership policy. |
| FR-014 | Connection health and digest | MVP | S1 PDF p. 19 | Health distinguishes a failed connection from failed tasks; a configurable weekday digest links to failed tasks first, and a Monday digest includes the weekend interval without duplicate incident counts. |
| FR-015 | Versioned automated QC rules | MVP | S1 PDF p. 20 | Range including voltage, rate-of-change, persistence, missing-data and zero-value rules detect known fixture violations; each rule stores author and update time, runs independently, and can be tested before promotion. |
| FR-016 | QC subscriptions and violation digests | MVP | S1 PDF p. 20 | Users choose system or stream scope and hourly, twice-daily, daily or weekly cadence; each digest contains only authorized violating streams, supports violation-type sorting, and links to the matching context. |
| FR-017 | Usage and operational analytics | MVP | S1 PDF p. 21; S2 PDF pp. 1-2 | Approved analytics report visitor, user and download counts by day, month and year; credentials, sensitive query content and internal records are excluded from third-party telemetry. |
| FR-018 | Support and defect context | MVP | S1 PDF p. 21 | A user can report a problem with a shareable state link; the steward receives reproducible permitted context and can assign a priority without embedding secrets or granting access to restricted records. |

### Commissioner and deputy work

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-019 | Assigned operations workspace | MVP | S1 PDF pp. 16, 31 | The manage tab lists only currently assigned systems and sites; a separate public explorer remains available; changing a requested system ID cannot reveal another system's private operational records. |
| FR-020 | Manual measurement entry | MVP | S1 PDF pp. 28, 31-32 | Users enter observation time, value, unit, stream and optional note for an assigned site; validation identifies the offending field, preserves valid inputs, and returns a saved record identifier on success. |
| FR-021 | Large batch paste and import | MVP | S1 PDF pp. 28, 40-41 | A user pastes or uploads at least a full 366-day fixture for several sites, previews mapping and row errors, chooses the documented atomic or partial import mode, and retries without creating duplicate readings. |
| FR-022 | Measurement correction and review levels | MVP | S1 PDF p. 32 | An assigned reviewer corrects one point or a selected interval, supplies a reason and qualifiers, and advances an allowed processing level; the raw observation and prior revisions remain distinguishable and concurrent changes produce a reviewable conflict. |
| FR-023 | Site metadata change history | MVP | S1 PDF p. 33 | Authorized edits to name, location, elevation, capacities, system or photographs record actor, time and before-and-after values; history remains after actor deactivation. |
| FR-024 | Annual distribution and multi-station reports | MVP | S1 PDF pp. 33, 35, 43 | For a selected authorized system and period, a report includes daily flow or volume, quality and coverage notes, configurable chart sizing, generation time and data version; exported PDF values reconcile to the selected dataset. |
| FR-025 | Site and system event alerts | MVP | S1 PDF pp. 19, 33, 45-46 | Subscriptions distinguish new sites, site edits, no signal and threshold violations; a test event reaches only eligible subscribers and the alert link repeats the authorization check. |
| FR-026 | Responsive mobile access and entry | MVP | S1 PDF pp. 13, 33-34, 57 | Public browse and core entry tasks work at 360 CSS pixels without horizontal page scrolling; entry controls are usable by touch and keyboard, and data submission survives a recoverable validation failure. |
| FR-027 | Offline field capture and synchronization | R2 | S1 PDF pp. 34, 44; S1 + proposal | In airplane mode, authorized users save reading, visit, photo and audio drafts; after reconnection each draft syncs once, shows status, and routes conflicts or revoked access for resolution without silent loss. |
| FR-028 | Preserve provisional decision evidence | R2 | S1 PDF pp. 22, 35, 68 | A saved distribution decision references the exact observation or revision versions used; later corrections do not change those referenced values or the decision's recorded calculation inputs. |
| FR-029 | Immutable finalized accounting and reports | R2 | S1 PDF pp. 22, 35; S1 + proposal | Finalizing an accounting transaction or report prevents in-place modification or deletion; an authorized correction creates a linked reversal or superseding version while measurement corrections remain separately possible. |
| FR-030 | Flexible accounting periods and supplemental water context | R2 | S1 PDF pp. 31, 35 | A configured season or custom water year, including a mid-month boundary, selects the correct fixture observations; supplemental use is compared only against approved inputs and is labelled advisory until accounting semantics are approved. |

### Engineering and field assurance

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-031 | Engineer site setup and editing | MVP | S1 PDF p. 40 | Authorized engineers create or edit site name, type, capacities, location, elevation, system and photos in their scope; required metadata and coordinate validation run before save. |
| FR-032 | Groups and subgroups | MVP | S1 PDF pp. 13, 40 | A site may be assigned to governed groups and subgroups, and filter results update consistently; the API prevents unauthorized membership changes and orphaned subgroup references. |
| FR-033 | Datastream and sensor setup history | MVP | S1 PDF p. 40 | Engineers select governed properties and sensors; changing a measurement setup creates a distinct effective-dated stream or setup record so old readings retain the original device and method context. |
| FR-034 | Capacity thresholds and map flags | MVP | S1 PDF pp. 39-40 | Out-of-range fixture values trigger labelled map and series indicators; thresholds are scoped and versioned and the UI uses a symbol or text as well as color. |
| FR-035 | Installation, seasonal and model-use facets | MVP | S1 PDF pp. 41, 45, 48-50 | Users filter by installation date, year-round versus seasonal operation and WCAT use; exact site or system irrigation dates determine expected data availability and suppress false missing-data incidents outside the active period. |
| FR-036 | Engineering diagnostics | MVP | S1 PDF pp. 20, 41, 54-55 | Authorized engineer views expose available discharge, level, voltage and other relevant streams; internal diagnostics do not become public merely because a site is public. |
| FR-037 | Water source and rights context | MVP | S1 PDF pp. 41, 48, 51, 69 | Site detail identifies provider, surface or groundwater source, storage or natural-flow context, combined flows and available user or rights associations; unresolved links are explicitly unverified rather than inferred. |
| FR-038 | Known data issues | MVP | S1 PDF p. 42 | Users record a known issue with affected stream and time interval, status and visibility; affected charts and exports carry the permitted issue context and resolution history. |
| FR-039 | Raw layer immutability and withdrawal | MVP | S1 PDF p. 42; S1 + proposal | Raw values cannot be edited; a separately authorized automation role can withdraw an erroneous point with reason and audit evidence; the retained original is available according to the approved retention and visibility policy. |
| FR-040 | Continuously revisable best available measurements | MVP | S1 PDF pp. 42-43 | A permitted engineer corrects a prior-year best-available value after year end without overwriting raw input or prior revisions; correction does not mutate an already finalized accounting transaction or report. |
| FR-041 | Multiple qualifiers and edit justification | MVP | S1 PDF p. 42 | Corrections support multiple governed qualifiers such as interpolation and ice-affected plus justification text; stored qualifiers and reason appear in permitted point history and exports. |
| FR-042 | Point and interval audit history | MVP | S1 PDF pp. 39, 42-43 | Selecting a point or flagged interval displays all authorized revisions with actor, timestamp, original and replacement value, qualifiers and reason, including a revision later superseded by another edit. |
| FR-043 | Recurrent quality issue trends | R2 | S1 PDF p. 42 | Users see chart markers and a sortable table of repeated flags or corrections by site and period; counts reconcile to the selected issue and revision records without counting one incident repeatedly. |
| FR-044 | Historical reconstruction | R2 | S1 PDF pp. 43, 68 | Given a supported as-of timestamp, a query returns the revisions known at that timestamp and distinguishes observation time from revision time; exports state the as-of basis and reproduce the fixture result after later corrections. |
| FR-045 | Rating curves, regressions and shifts | R2 | S1 PDF pp. 43, 50 | Effective-dated curve and shift versions retain author, approval state and provenance; computed values identify the version used, and a revised curve does not erase earlier conversions or inspection evidence. |
| FR-046 | Visits, maintenance and inspection history | MVP | S1 PDF pp. 44-47, 51 | A visit records site, author, visit time, type, measurement or maintenance actions and attachments; last checked or rated dates are structured queryable fields and visit history survives equipment replacement. |
| FR-047 | Voice notes with optional AI assistance | R2 | S1 PDF p. 44; S2 PDF p. 2 | A user records a note and optionally requests an approved transcription or summary; the user reviews it before saving, original media follows retention policy, and no AI text changes measurements or inspection status automatically. |
| FR-048 | Asset inventory and transfers | R2 | S1 PDF pp. 44-47, 49-50 | Equipment records preserve make, model, identifier and serial-number evidence; transferring an asset closes the old site association and opens a dated new association without moving historical inspections to the wrong site. |
| FR-049 | Categorized public and internal attachments | MVP | S1 PDF pp. 44-45, 47 | Users upload several categorized site or asset photos and mark permitted visibility; public APIs, thumbnails, exports and report generation cannot retrieve an internal photo, note, gate code or wiring detail. |
| FR-050 | Advanced field configuration and access information | Discovery | S1 PDF pp. 47-50 | A scoped follow-on design defines equipment addresses, communications links, custom ingestion headers and optional access points; approved fixtures demonstrate correct access and parsing before any such fields are exposed. |
| FR-051 | WCAT and water-right-network integration | R2 | S1 PDF pp. 38, 48, 50-51, 71 | An agreed adapter exchanges identified stream and model inputs or results with WCAT; sync is repeatable, reports changed inputs and preserves observed versus calculated versus modeled distinctions and authoritative ownership. |

### Water user and supplier workflows

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-052 | Water user favorites and notifications | MVP | S1 PDF pp. 54-55 | A registered user favorites any published site, opens its charts and permitted photos, and manages personal subscriptions; removing a favorite or subscription persists and does not alter a site's authority or ownership. |
| FR-053 | Assigned supplier system view | R2 | S1 PDF p. 55 | A verified supplier sees assigned area sources, purchases, wholesale and returns plus historical discharge comparisons; an account assigned to a different supplier cannot retrieve the system's private report or boundary workflow. |
| FR-054 | Boundary proposals and comments | R2 | S1 PDF pp. 55-56 | An assigned supplier proposes a boundary change with reason, views approval status, downloads an authorized boundary file, and comments by section; a proposal never replaces the approved boundary before the defined approval action. |
| FR-055 | Water use reporting categories and validation | R2 | S1 PDF p. 56 | Forms cover culinary use, source, purchase, wholesale and returns inventories, source peak demand and secondary use; missing required values and unreasonable values produce field-level text messages and an error summary in addition to color. |
| FR-056 | Supplier data import choices | R2 | S1 PDF p. 56 | Manual entry and documented file import populate the same validated reporting model; a preview displays mapped units and periods, identifies invalid rows, and avoids duplicate values when a file is retried. |
| FR-057 | Supplier submission and completed PDF | R2 | S1 PDF pp. 56, 71 | A valid assigned report transitions from draft to submitted, records submitter and version, and produces a PDF matching that submitted version; resubmission or review changes follow an approved state machine. |

### Public reporting and researcher access

| ID | Requirement | Release | Evidence | Acceptance criterion |
| --- | --- | --- | --- | --- |
| FR-058 | Public overview and statewide performance indicators | MVP | S1 PDF pp. 58-61 | Anonymous users start with an intelligible overview and can drill into site metadata; telemetry and reviewed-data indicators state numerator, denominator, period and update time, with output measures distinguished from outcomes. |
| FR-059 | Measured versus estimated use indicators | MVP | S1 PDF p. 60 | An indicator distinguishes measured, estimated and unknown source classifications, reports its denominator and period, and reconciles to the selected authorized source records without presenting old audit percentages as live results. |
| FR-060 | Maintained data map and dictionary | MVP | S1 PDF pp. 19, 60, 63 | Users can find definitions of fields, units, processing levels, qualifiers, lineage and dataset relationships; a vocabulary change publishes a corresponding version or effective date and links API fields to the same definitions. |
| FR-061 | Dynamic space and time summaries | MVP | S1 PDF pp. 17, 60, 65 | Charts and tables summarize the selected area, period and processing basis; repeated queries reconcile to exported data and avoid double-counting a flow measured at multiple points or mixing quantities with incompatible units. |
| FR-062 | Understandable accessible visualizations | MVP | S1 PDF pp. 61-62 | Charts provide clear labels and keyboard-accessible values, avoid color-only meanings, use a limited color-blind-aware palette and zero-based bar axes, and offer a readable table with the same selected values. |
| FR-063 | Single-site and multi-site CSV exports | MVP | S1 PDF pp. 60, 67-68 | CSV exports contain only eligible rows and include site, stream, timestamps, units, processing level, qualifiers and source identifiers; multi-site data uses documented ordering and large requests show job status rather than silently truncate. |
| FR-064 | Research credential lifecycle | MVP | S1 PDF p. 67; S1 + proposal | An authenticated researcher creates a scoped credential, copies its secret at creation, and rotates or revokes it without a new account; revoked credentials fail on the next request and secrets do not appear in logs or share URLs. |
| FR-065 | Documented and bounded programmatic queries | MVP | S1 PDF pp. 66-68 | Published examples query site, time interval, property and processing level using documented pagination, limits and error responses; contract tests validate returned schema, authorization and date-boundary behavior. |
| FR-066 | Quality, provenance and processing selection | MVP | S1 PDF pp. 59, 67-68 | Users distinguish raw, provisional, reviewed and best-available data as governed, inspect permitted issues and edit context, and filter by processing basis; unavailable historical decision-time reconstruction links to the R2 capability rather than simulating it. |
| FR-067 | Extended modeling and transaction transparency | Discovery | S1 PDF pp. 35, 50-51, 69-70 | Separate contracts define rights-to-field links, change-application effective history, OpenET comparison, depletion, apportionment and machine-readable transaction schedules; approved fixtures distinguish measured inputs from modeled results. |
| FR-068 | Onboarding, training and user feedback | MVP | S1 PDF pp. 24, 47; S2 PDF pp. 1-3 | A user can complete a short role-relevant tour and disable its automatic return; commissioners receive task-based training, and observed pilot task failures feed a prioritized backlog with named owners. |

## Filter semantics and data presentation

S1 PDF pages 13-15 enumerate **20 named dimensions** followed by an open-ended **"21. Others?"** placeholder. The initial governed set is distribution system, system group, subgroup, site type, telemetry availability, provider, observed property, control structure, structure material, structure size, water source type, measuring device type, measurement method type, observation type, available date range, site status, state, time step, aggregation statistic, and method type. "Measurement method type" and "method type" overlap in the source; the steward must define whether these are distinct concepts before the API contract is finalized.

Donna adds processing level and dataset type. Engineering adds installation dates, operating season, exact irrigation start and stop dates, last inspection, and WCAT use. Each controlled value needs an identifier, label, definition and lifecycle status. Unknown, absent, and not applicable must remain distinguishable. Date filters must state whether they select sites with any data in a period, complete coverage, or availability since a date; these meanings must not be inferred from an ambiguous label.

Charts show observation time separately from ingestion or revision time. The stored time basis is UTC; the interface defaults to the site's agreed local zone and labels it. The product must state how daily averages, daylight-saving transitions, intermittent observations, flow integration, storage changes, cumulative meters and estimated gaps affect volume. Unit conversion cannot change the underlying physical quantity. Each derived summary carries its formula or method version and coverage.

Natural-language filtering is a translation into an allowlisted schema, followed by user inspection and normal server validation. The questions about rapidly declining flow and a current reservoir release on S1 PDF page 16 require computed or latest-value tools beyond metadata filtering. They enter Discovery scope until input freshness, aggregation, query cost, and failure behavior are defined. AI cannot produce arbitrary SQL, change grants, finalize data, or execute engineering corrections.

## Data lifecycle decisions

**Raw measurements** preserve ingestion provenance and are not edited. S1 permits automation engineers to delete erroneous raw readings. The proposed safer behavior is an authorized withdrawal or tombstone retaining the original under an approved retention policy; this is a product policy decision requiring DWRi confirmation, not an existing source mandate.

**Best available measurements** are versioned and remain correctable indefinitely. A review level records the governed assessment of a value; it does not erase preceding values. **Finalized accounting transactions and submitted report versions** are separate records and are immutable. Correcting a measurement can produce a new accounting or report version through a defined workflow; it cannot silently alter the evidence behind a prior decision.

A provisional processing level alone is insufficient to recreate what was known at a past time. The model must retain revision time, observation time, relevant calculation versions and decision references for FR-028 and FR-044. MVP preserves the required lineage even when the full historical query UI is deferred.

For credentials, S1 prefers a token viewable in the account. The proposed security behavior displays the secret once at creation and thereafter displays its label, scope, creation date, last use and revoke or rotate controls. Repeated raw-secret retrieval is excluded pending an explicit security decision. Public and browser application flows must not embed a broad NeoServer or database credential.

## Nonfunctional requirements and proposed release targets

These targets are proposed engineering acceptance values, not measured platform capabilities. The staging load profile must be set after the real site count, observation volume, geographic extent and user concurrency are known.

| ID | Requirement and proposed acceptance |
| --- | --- |
| NFR-001 | Accessibility: meet the DWRi-approved current accessibility standard, with WCAG 2.2 AA as the proposed implementation target; keyboard and screen-reader review covers map alternatives, forms, error messages, dialogs, charts and reports. Automated scans alone are insufficient acceptance. |
| NFR-002 | Browser and device coverage: core journeys pass in supported Chrome, Edge, Firefox and Safari, on desktop and representative mobile layouts; the support matrix and versions are recorded for each release. |
| NFR-003 | Interactive performance: under an agreed staging profile, p95 structured filter and site-detail API response is at most 2 seconds and core UI becomes usable within 3 seconds on the agreed field-network profile; complex exports run asynchronously with visible status. |
| NFR-004 | Reliability: proposed monthly service objective is 99.5% for public read journeys, with separately monitored ingestion and notification health; stale readings remain visible with their timestamps rather than implying a live connection. |
| NFR-005 | Recovery: DWRi approves retention, recovery point and recovery time objectives; staging restore proves recovery of database revisions, attachments, grants and NeoServer configuration before pilot acceptance. Proposed initial design objectives are RPO 1 hour and RTO 4 hours, subject to infrastructure validation. |
| NFR-006 | Security: least-privilege service identities, encrypted transport, managed secrets, validated tokens and session expiry, audit protection, tested object access and rate limits; private cache keys include effective authorization scope and data visibility version. |
| NFR-007 | Data correctness: imports are repeatable; validation distinguishes zero from missing, handles time zones and units, rejects incompatible property conversions, and preserves provider, method and revision provenance. |
| NFR-008 | Maintainability: versioned contracts, automated builds, environment separation, traceable migrations and rollback procedures; GeoLibre and NeoServer revisions are pinned and compatibility-tested before upgrades. |
| NFR-009 | Observability: correlate user-visible failures to request or job IDs; monitor API latency, denied access, tile and export failures, sync conflicts, ingestion lag and notification delivery without logging secrets or sensitive content. |
| NFR-010 | Responsible AI: approved provider and state-policy review precede external processing of internal text, audio or data; structured output validation, audit metadata and deterministic manual fallback remain available. |

## Exclusions and dependencies

MVP does not replace WCAT's accounting engine, decide legal water rights, enforce curtailment automatically, rebuild the entire Water Use Program, migrate all legacy SQL Server systems, or implement the separate adjudication and PD/LUR processing needs identified outside these personas on S1 PDF page 70. It does not require an OGC SensorThings client merely to obtain GeoJSON. Existing HydroServer interfaces remain a compatibility and migration assessment dependency until DWRi identifies authoritative ownership and existing consumers.

The stack decision in U1 replaces the S2 request to evaluate ArcGIS Maps SDK as the primary implementation approach for this product. A separate MapServer modernization assessment may still compare other options. Existing Google Cloud connectivity, database version and extension support, identity integration with UtahID, authoritative controlled vocabulary, source licensing, safe public fields, and migration scope are prerequisites for production contracts. The product must not assume that a managed Google Cloud PostgreSQL service supports TimescaleDB without verification.

## Open product decisions

| Decision | Owner to confirm | Consequence |
| --- | --- | --- |
| Role grants, deputy delegation, engineer regional scope, public provisional visibility and diagnostic visibility | DWRi governance and section leads | Freezes the permission matrix and denial test cases before real records are connected. |
| Raw withdrawal and retention policy; vocabulary overlap; official processing-level definitions | Data steward and records owner | Defines audit behavior, deletion semantics and supported historical reconstruction. |
| Steward versus engineer ingestion setup responsibility | Data Services and Automation leads | Separates request, validation and production promotion permissions. |
| Supplier reporting ownership, boundary approval and reviewer state machine | Water Use Program owner | Confirms R2 interface and prevents a report workflow being inferred from the commissioner role. |
| Existing PostgreSQL host, TimescaleDB feasibility, observation schema, API ownership and HydroServer migration boundary | DWRi and DTS platform teams | Determines the time-series deployment and adapter work without changing the agreed map experience. |
| Identity and UtahID integration, external researcher registration and token policy | DWRi and DTS security owners | Resolves single sign-on and the proposed one-time secret-display deviation. |
| Persona prototype validation and water-user link target | Product and design owners | Review all six supplied Figma flows against the source journeys. The water-user and commissioner links share node 1193-1908 with different page parameters, so verify the intended water-user frame before accepting visual fidelity. |
| Pilot cohort, data-volume profile, operational objectives and final release scope | Product owner with operational teams | Converts proposed performance and usability targets into approved release acceptance. |

## Acceptance and release evidence

An MVP release requires a requirement-to-test report, the scoped permission matrix, API and import contract results, unit and time-boundary reconciliation, representative browser and accessibility results, and persona task observations. Production readiness additionally requires staging identity integration, migration reconciliation, backup restore evidence, monitoring ownership and a rollback exercise. A prototype demonstration cannot satisfy these production gates.

The accepted backlog must preserve every deferred requirement with its owner and dependency. Changes to release allocation update this PRD, the traceability CSV, technical contracts and the development backlog together so a deferred workflow is not represented as shipped functionality.

## Source files

- [Updated 2026 requirements PDF](../../Updated%202026%20User-Centric_Design_Requirements_for_the_Water_Measurement_Data_Dashboard.pdf)
- [Staff augmentation scope of work PDF](../../Tech%20Services%20Staff%20Augmentation%20Scope%20of%20Work.pdf)
- [2024 technology modernization roadmap PDF](../../Utah_DWRi_Technology_Modernization_Roadmap_9-26-2024.pdf)

The roadmap supports the sequencing of metadata governance, measurement services, entry tools, quality control, accounting integration and training. Detailed roadmap migration and enterprise assessment deliverables belong to the broader S2 engagement.

### Persona design references

These six prototype links identify the intended design references; acceptance of screen fidelity requires inspecting the corresponding frames and interactions.

| Persona | Design reference |
| --- | --- |
| Data steward or manager | [Diego prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=173%3A600&node-id=173-1356&p=f&viewport=-89%2C335%2C0.16&t=vbOrBVXwhoKXrcpY-1&scaling=scale-down&content-scaling=fixed&starting-point-node-id=173%3A1356) |
| Commissioner and deputies | [Cody prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=396%3A2979&node-id=1193-1908&p=f&viewport=-445%2C-2461%2C1.26&t=HnKM653jBc2uzdJZ-1&scaling=contain&content-scaling=fixed&starting-point-node-id=1193%3A1908) |
| Field, automation or regional engineer and modeler | [Fatima prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=545%3A7949&node-id=545-8730&p=f&viewport=415%2C121%2C0.19&t=AYPruqWzaJJ8AFYv-1&scaling=scale-down&content-scaling=fixed&starting-point-node-id=545%3A8730) |
| Water user | [Wiley prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=0%3A1&node-id=1193-1908&p=f&viewport=1210%2C572%2C0.23&t=qN9qOK9T0Y9WkQgB-1&scaling=scale-down&content-scaling=fixed&starting-point-node-id=1193%3A1908) |
| Scientist, researcher or consultant | [Sarah prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=1601%3A12578&node-id=1601-13148&p=f&viewport=-210%2C1151%2C0.73&t=rYNTGlp4apVkGmYt-1&scaling=scale-down&content-scaling=fixed&starting-point-node-id=1601%3A13148) |
| Director, policy maker and public | [Donna prototype](https://www.figma.com/proto/cnopKfQ6QAJEmXf9JVX9Gc/Data-System-Template?page-id=81%3A364&node-id=81-365&p=f&viewport=845%2C398%2C0.13&t=eHboTn53rQGwLV4c-1&scaling=scale-down&content-scaling=fixed&starting-point-node-id=81%3A365) |
