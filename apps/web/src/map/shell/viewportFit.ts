/** Only changes to the visible station locations should trigger automatic fit.
 * New projection objects, reading updates, camera changes and style reloads do
 * not change those locations. Fitting for those events would reset user pans
 * and can create a fit -> moveend -> render -> fit feedback loop.
 */
interface LocatedStation {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
}

function locationKey(stations: readonly LocatedStation[]): string {
  return JSON.stringify(stations.map(({ id, longitude, latitude }) => [id, longitude, latitude]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function createViewportFitTracker(initialStations: readonly LocatedStation[]) {
  let previous = locationKey(initialStations);
  return {
    /** Consume a ready map's catalog; the initial viewport stays intact. */
    changed(stations: readonly LocatedStation[]): boolean {
      const next = locationKey(stations);
      const changed = next !== previous;
      previous = next;
      return changed;
    },
  };
}
