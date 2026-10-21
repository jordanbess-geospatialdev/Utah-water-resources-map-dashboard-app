import { test } from 'node:test';
import assert from 'node:assert/strict';

const trackerPath = './viewportFit.ts';
const { createViewportFitTracker }: typeof import('./viewportFit') = await import(trackerPath);

const stations = [
  { id: 'a', longitude: -112.1, latitude: 41.6 },
  { id: 'b', longitude: -111.9, latitude: 41.8 },
];

test('restored camera survives initial style load and repeated camera-driven projections', () => {
  const tracker = createViewportFitTracker(stations);
  assert.equal(tracker.changed(stations), false, 'initial load keeps the supplied camera');
  for (let render = 0; render < 10; render++) {
    const reprojection = stations.map((station) => ({ ...station, latestValue: render }));
    assert.equal(tracker.changed(reprojection), false, 'moveend and reading updates cannot start another fit');
  }
  assert.equal(tracker.changed([...stations].reverse()), false, 'table sorting does not change the viewport');
});

test('filter, persona and station-location changes fit once after the map is ready', () => {
  const tracker = createViewportFitTracker(stations);
  const filtered = stations.slice(0, 1);
  assert.equal(tracker.changed(filtered), true);
  assert.equal(tracker.changed(filtered.map((station) => ({ ...station }))), false);
  assert.equal(tracker.changed([]), true);
  assert.equal(tracker.changed(stations), true, 'clearing an empty filter frames the returned stations');
  const moved = stations.map((station) => ({ ...station, longitude: station.longitude + 0.1 }));
  assert.equal(tracker.changed(moved), true);
  assert.equal(tracker.changed(moved), false);
});
