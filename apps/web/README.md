# Web application

This package currently runs a synthetic demonstration shell. Its six persona
options change fixture projections; they are demonstration controls, not login
or authorization. Keep the synthetic-data banner visible.

## Run and validate

From the repository root, using Node 22 or newer and the pinned package manager:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @utah-water/web dev
corepack pnpm --filter @utah-water/web test
corepack pnpm --filter @utah-water/web typecheck
corepack pnpm --filter @utah-water/web build
```

The development server listens at `http://127.0.0.1:5173`. No database or API
credentials are required for this fixture shell. Tests load extensionless
TypeScript imports through `tests/ts-resolve-hook.mjs`; production builds use
Vite and TypeScript.

## What the running shell exposes

`src/main.tsx` mounts `src/shell/App.tsx`: overview counts, station search and
filters, the map/table, station observations and revision history, fixture
persona selection, and the basic stewardship view. `src/features/` contains
additional independently tested panels and models, with their mounting and
API-port requirements documented in each feature README. Their existence does
not mean they are reachable from the current shell. Production HTTP bindings,
session identity and the remaining feature navigation still need integration
and end-to-end acceptance.

## Map and shared-view behavior

The shell's versioned URL codec is `src/shell/data/viewState.ts`. It restores
state before the first map render, excludes persona/credentials, and removes a
station the opening session cannot see. The richer discovery codec in
`src/features/discovery/shareUrl.ts` is separate and is not mounted in the shell.

`StationMap` preserves the restored camera during initial style loading and
basemap changes. `viewportFit.ts` triggers automatic fitting only when the
visible station IDs or locations change. Reading updates, table ordering,
selection and equivalent projection arrays must not reset a user's pan or
create a camera-update render loop. The Fit stations button always provides an
explicit way to frame the visible catalog.

MapLibre 6 requires an explicit worker URL under Vite. `StationMap` imports
`maplibre-gl-worker.mjs?worker&url` and calls `setWorkerUrl` before constructing
a map, following the [MapLibre Vite setup](https://maplibre.org/maplibre-gl-js/docs/).
Keep the worker query: a plain asset URL does not bundle the worker's sibling
imports for production, and automatic worker discovery points at the wrong
location after Vite optimization. Verify both development and built preview
maps after changes to this integration.

For a browser smoke check, open a `v=1` URL with a distinctive `center` and
`zoom`, let the map finish loading, pan it, and toggle the basemap. The camera
should survive each step and remain stable after movement ends. Change the
station filters and confirm the visible catalog fits once. Select a station
and use both the chart's keyboard controls and the table; gaps remain breaks
with no filled area implying observations across an outage. A flagged fresh
station belongs to the map's attention category.

The targeted regression suite is:

```sh
cd apps/web
node --test --experimental-strip-types tests/adapters.test.ts tests/viewState.test.ts src/map/shell/viewportFit.test.ts
```

These model/adapter tests and type checks do not replace real browser,
assistive-technology, production API or persona acceptance testing.

## Browser review evidence (2026-10-21)

Checked the fixture shell in the in-app Chromium browser against Vite
development on port 5174 and the production build preview on port 5180:

- The restored center `-112.1234,41.4321` and zoom `9.25` survived initial
  loading. In the production preview, a keyboard pan changed longitude to
  `-112.0079`; the camera remained there through street and terrain swaps.
- Both basemap swaps completed loading. Fit stations rendered the station
  layers, and filtering to `flume` framed the remaining station at
  `-111.8524,41.6295`, zoom `10.00` in development.
- The production worker loaded and no production-page console warnings or
  errors were captured. The build emitted a bundled worker asset. The build
  still reports a large JavaScript chunk warning; performance targets require
  separate representative-device measurement.
- The chart exposed point buttons in the accessibility tree. Pressing Enter
  on the flagged `9500.0 cfs` point selected it and displayed its value/flag;
  switching to the table preserved that selection and the same raw/best values.
  The declared outage remained a visible line break without a filled area.

This is a focused desktop smoke check, not cross-browser/mobile qualification
or screen-reader certification. The temporary review servers and tab were
closed afterward; the preexisting development server was left alone.
