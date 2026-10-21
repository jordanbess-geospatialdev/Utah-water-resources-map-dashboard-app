/**
 * Shared canary/fixture loading for the WD-021 adversarial sweeps.
 *
 * Zero dependencies: Node built-ins + the repository's own fixture JSON.
 * Everything here is derived from fixtures/contracts so the sweeps fail
 * loudly if the fixture world drifts (seed assertion below).
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = new URL('../../../', import.meta.url);

/**
 * Web src modules import each other extensionless (the tsc/Vite form). This
 * hook (owned by apps/web, reused read-only) retries failed relative
 * resolutions with `.ts` appended so the src graph loads under `node --test`.
 */
export function registerWebResolveHook() {
  register(pathToFileURL(fileURLToPath(new URL('../../../apps/web/tests/ts-resolve-hook.mjs', import.meta.url))).href);
}

export function readFixtureJson(name) {
  return JSON.parse(readFileSync(new URL(`fixtures/contracts/${name}`, REPO_ROOT), 'utf8'));
}

export const stationsFixture = readFixtureJson('stations.json');
export const principalsFixture = readFixtureJson('principals.json');

if (stationsFixture.seed !== 'utah-water-fixture-v1' || principalsFixture.seed !== 'utah-water-fixture-v1') {
  throw new Error('fixture seed mismatch: expected utah-water-fixture-v1');
}

/**
 * The restricted bytes under test. Everything here exists ONLY in
 * `internal` blocks of the station fixtures (never in a public projection),
 * plus the synthetic publication canary used by the T-05 live capture and
 * the database forbidden-column vocabulary.
 */
export const GATE_CODES = stationsFixture.stations
  .filter((station) => station.internal?.gateCode)
  .map((station) => station.internal.gateCode);

export const WIRING_NOTE_FRAGMENTS = stationsFixture.stations
  .filter((station) => station.internal?.wiringNotes)
  .flatMap((station) => {
    const notes = station.internal.wiringNotes;
    // Two distinctive substrings per note: the head and a mid-sentence phrase.
    return [notes.split(';')[0].trim(), notes.split(';').slice(1).join(';').trim().split(',')[0].trim()];
  })
  .filter((fragment) => fragment.length >= 12);

/** Restricted/internal column and field-name vocabulary (database check + FR-049). */
export const RESTRICTED_FIELD_NAMES = ['gate_code', 'gateCode', 'wiring_notes', 'wiringNotes', 'internal_note', 'owner_contact'];

/** T-05 synthetic publication canary (exists only in the base table qualification.station_all). */
export const PUBLICATION_CANARIES = ['SYNTHETIC-NEVER-PUBLISH'];

/**
 * VALUE canaries: byte substrings that must appear in NO public surface.
 * (Field NAMES are checked structurally below: a projection that carries a
 * `gateCode`/`wiringNotes` KEY leaks the restricted block's shape even when
 * the value is nulled, but the bare names legitimately occur in schema docs
 * and fixture notes, so they are not byte-canaries.)
 */
export const CANARY_BYTES = [...GATE_CODES, ...WIRING_NOTE_FRAGMENTS, ...PUBLICATION_CANARIES];

/** Identifiers of restricted/internal stations and streams (never public-projectable). */
export const RESTRICTED_OBJECT_IDS = stationsFixture.stations
  .filter((station) => station.visibility !== 'public')
  .flatMap((station) => [
    station.id,
    ...station.datastreams.filter((stream) => stream.visibility !== 'public').map((stream) => stream.id),
  ]);

/**
 * Assert `serialized` (string, Uint8Array or JSON-stringified object graph)
 * contains none of the canary bytes. Returns the list of surfaces scanned
 * so callers can assert coverage was non-trivial.
 */
export function findCanaryHits(serialized) {
  const text =
    typeof serialized === 'string'
      ? serialized
      : serialized instanceof Uint8Array
        ? Buffer.from(serialized).toString('latin1')
        : JSON.stringify(serialized);
  const hits = [];
  for (const canary of CANARY_BYTES) {
    if (text.includes(canary)) hits.push(canary);
  }
  return hits;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * STRUCTURAL check: walk a parsed JSON object graph and flag any object KEY
 * from the restricted field-name vocabulary. A public projection that carries
 * a `gateCode`/`wiringNotes`/`internal_note` key leaks the restricted block's
 * shape (FR-049) even when the value is null or redacted.
 */
export function findRestrictedKeys(node, seen = new Set()) {
  const hits = [];
  if (node === null || typeof node !== 'object') return hits;
  if (seen.has(node)) return hits;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) hits.push(...findRestrictedKeys(item, seen));
    return hits;
  }
  for (const key of Object.keys(node)) {
    if (RESTRICTED_FIELD_NAMES.includes(key)) hits.push(key);
    hits.push(...findRestrictedKeys(node[key], seen));
  }
  return hits;
}

/** Deterministic PRNG (mulberry32) so generated corpora are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];
