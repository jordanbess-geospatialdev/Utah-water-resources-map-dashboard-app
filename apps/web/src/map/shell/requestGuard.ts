/**
 * Stale-response rejection for the map shell (technical specification,
 * GeoLibre integration rules). Every asynchronous continuation around the map
 * (style reloads, camera events, any future network fetch) is issued a token;
 * a completion whose token is no longer current is dropped instead of applied.
 * Pure module: unit-testable under node without a DOM.
 *
 * The GeoLibre rule being honored: reject stale network responses after a
 * filter or persona change. Persona/filter changes rebuild the layer list
 * synchronously here, and the async style-reload path below is where a late
 * completion would otherwise clobber newer state.
 */
export interface RequestGuard {
  /** Issue (or reissue) the token before starting an async operation. */
  begin(): number;
  /** True when `token` is still the newest issued token. */
  isCurrent(token: number): boolean;
}

export function createRequestGuard(): RequestGuard {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (token: number) => token === latest,
  };
}

/** Convenience: run `action`, and apply its eventual value only when the guard is still current. */
export function onlyLatest<T>(guard: RequestGuard, action: (token: number) => Promise<T>): Promise<T | null> {
  const token = guard.begin();
  return action(token).then(
    (value) => (guard.isCurrent(token) ? value : null),
    (error: unknown) => {
      if (guard.isCurrent(token)) throw error;
      return null;
    },
  );
}
