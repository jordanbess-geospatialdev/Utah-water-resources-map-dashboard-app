# discovery (WD-007, FR-001/002/004/008/060)

Account-free public discovery for the Utah Water Measurement Data
Dashboard: the typed FilterSet with canonical serialization, the versioned
share-URL codec, the accessible filters panel, the FR-004 site popup and the
FR-060 data dictionary panel. Bounded map retrieval lives beside this in
`apps/web/src/map/discovery/`.

## Files

| File | Role |
| --- | --- |
| `filters.ts` | The typed `DiscoveryFilterSet` over the governed dimensions present in the fixture world (distribution system, subgroup, site type, telemetry tri-state, provider, observed property, structure dims, water source, device, measurement method, site status, time step, processing level). AND across dimensions, OR within; the `"unknown"` sentinel selects unset values and is never collapsed with an absent key; canonicalization dedupes/sorts/omits empties and redacts free text, restricted identifiers, non-enum members and over-cardinality lists with explicit reasons. Well-formed unknown vocabulary stays inspectable. |
| `filters.test.ts` | `node:test` suite (17 tests): AND/OR fixture queries with expected site ids, telemetry unknown-vs-none, subgroup sentinel, ungoverned dimensions, public-stream-only facets, derived processing levels, canonicalization/redaction, serialization stability, chips. |
| `shareUrl.ts` | Versioned (`v=1`) codec for filters (`f`), CRS84 extent (`e`, 4-decimal) and selected public site (`s`); unknown params ignored, persona/credential keys never read or emitted; restricted selections omitted-with-notice at build AND resolve time; length-capped. |
| `shareUrl.test.ts` | `node:test` suite (12 tests) incl. a 243-state build→parse→build property loop and hostile inputs (overlong values, markup, persona/token keys, forged restricted-site links). |
| `DiscoveryFiltersPanel.tsx` | Accessible filter UI: fieldset/legend groups, native checkboxes (keyboard operable), sentinel option distinct from "no value", applied chips with remove + clear-all, unknown-value inspect affordance, loading/zero-result states. |
| `SitePopup.tsx` | FR-004 quick site card: station + external site ids, latest value with unit (missing renders unavailable, never zero), observation time + freshness (stale keeps its timestamp, NFR-004), injected profile navigation. |
| `DataDictionaryPanel.tsx` | FR-060 bounded vocabulary listing: filter fields with governance, observed properties → canonical units, units, processing levels, qualifiers, plus the unknown-values-from-this-link section; loading/empty/error states. |
| `index.ts` | Public exports plus the `discoveryMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/discovery/filters.test.ts src/features/discovery/shareUrl.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks up
`src/features/**/*.test.ts`, so these two suites are included there too.)

## Data source

Fixture world only, read-only reuse of the WD-006 shell loaders
(`../../shell/data/fixtures`, `../../shell/data/projection`): stations,
observations, revisions, systems/subgroups/providers and the governed
vocabulary. Discovery always projects through the PUBLIC viewer — restricted
and internal stations, their restricted streams, gate codes and wiring notes
are not representable anywhere in this feature (tested in
`map/discovery/discoverySource.test.ts`).

## Pending shell wiring (persona_ui's next slice)

WD-007 may not edit `apps/web/src/shell/App.tsx`. The pending integration is
one import plus mounting the descriptor's components; conceptually:

```tsx
import { discoveryMount, buildShareUrl, parseShareUrl, resolveShareUrl } from './features/discovery';
import { createDiscoverySource, buildDiscoveryLayers } from './map/discovery';

// in the discovery view:
//   const resolved = resolveShareUrl(parseShareUrl(location.search), publicSiteIds);
//   <discoveryMount.components.filtersPanel filters={resolved.state.filters} … />
//   <discoveryMount.components.sitePopup station={selectedProjection} onOpenProfile={id => selectSite(id)} />
//   <discoveryMount.components.dataDictionary unknownValues={…} />
```

The site profile mount path the popup's `onOpenProfile` expects is the
shell's existing 'sites' view with the station selected (viewState
vocabulary: `view=sites&station=<id>`); `SitePopup` also accepts
`profileHref` when the shell prefers a route.

## Requirement traceability

- **FR-001** — public map discovery data path (`filters.ts`, `map/discovery/discoverySource.ts`).
- **FR-002** — controlled metadata filters: typed set, AND/OR documented and tested, unknown-vs-no-telemetry distinction.
- **FR-004** — quick site card: identifiers, latest value + unit, observation time, freshness, profile link, unavailable-never-zero.
- **FR-008** — shareable state: versioned URL, permitted filters/extent/selection only, omitted-with-notice for inaccessible objects, no credentials or internal text.
- **FR-035** — groundwork only: installation/seasonality remain persona dimensions; the registry is append-only for them.
- **FR-060** — data dictionary: bounded vocabulary listing plus unknown-value inspection.
