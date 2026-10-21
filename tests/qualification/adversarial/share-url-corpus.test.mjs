/**
 * WD-021 adversarial sweep (d): share-URL / hostile-input corpus replay
 * against the discovery codec (apps/web/src/features/discovery).
 *
 * A 60+ case corpus of hostile queries — prototype-pollution keys,
 * credential/role parameters, URL-encoded canaries, restricted identifiers,
 * script injection, oversized inputs, malformed extents, version confusion,
 * comma/semicolon injection — replayed through parseShareUrl and
 * resolveShareUrl, then re-serialized through buildShareUrl. Invariants:
 * the codec never throws; restricted ids never survive into state or URLs;
 * canary bytes never appear in any output surface; unknown versions parse
 * to null (never a guess); every surviving state re-serializes cleanly.
 *
 * Run (from repo root):
 *   node --test tests/qualification/adversarial/share-url-corpus.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWebResolveHook, findCanaryHits, mulberry32, pick, RESTRICTED_OBJECT_IDS, CANARY_BYTES } from './canaries.mjs';

registerWebResolveHook();

const { buildShareUrl, parseShareUrl, resolveShareUrl, MAX_SHARE_URL_LENGTH } = await import(
  '../../../apps/web/src/features/discovery/shareUrl.ts'
);
const { canonicalizeFilters, serializeFilters, DISCOVERY_DIMENSION_KEYS } = await import(
  '../../../apps/web/src/features/discovery/filters.ts'
);

const PUBLIC_IDS = ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const hostileQueries = [
  // Version confusion
  '?v=0&f=telemetry=manual',
  '?v=2&f=telemetry=manual',
  '?v=999&s=sta-bear-corinne',
  '?v=-1&s=sta-bear-corinne',
  '?v=1e3&s=sta-bear-corinne',
  '?v=0x1&s=sta-bear-corinne',
  'f=telemetry=manual', // no version at all
  '?f=telemetry=manual', // no version
  '',
  '?',
  '?v=1',
  // Restricted identifiers as the selected site
  ...RESTRICTED_OBJECT_IDS.map((id) => `?v=1&s=${id}`),
  ...RESTRICTED_OBJECT_IDS.map((id) => `?v=1&s=${encodeURIComponent(id)}`),
  '?v=1&s=sta-hyrum-diversion-owner&s=sta-bear-corinne', // duplicate params
  // Credential / persona / role smuggling (codec keys only: v f e s)
  '?v=1&persona=admin&roles=steward&token=uwdat_stolen&s=sta-bear-corinne',
  '?v=1&actorId=principal-diego-steward&role=steward',
  '?v=1&Authorization=Bearer%20abc&X-API-Key=secret',
  '?v=1&__proto__[polluted]=yes&constructor[prototype]=yes',
  '?v=1&__proto__=yes',
  // Canary bytes URL-encoded and raw
  `?v=1&s=${encodeURIComponent('4471-CDX')}`,
  `?v=1&f=siteTypeIds=${encodeURIComponent('9917-KWW')}`,
  `?v=1&f=siteTypeIds=${encodeURIComponent('SYNTHETIC-NEVER-PUBLISH')}`,
  '?v=1&f=siteTypeIds=flume;DROP%20TABLE%20stations',
  // Filter injection: comma, semicolon, equals, traversal, script
  '?v=1&f=siteTypeIds=flume,<script>alert(1)</script>',
  '?v=1&f=siteTypeIds=../../etc/passwd',
  '?v=1&f=distributionSystemIds=sys-bear-river,sys-weber-river,sys-unknown-xyz',
  '?v=1&f=telemetry=telemetered,manual,supertele', // non-enum member mixed in
  '?v=1&f==broken&f2=&f=', // separators without keys
  '?v=1&f=;;;;;;;;',
  '?v=1&f=siteTypeIds=' + 'a'.repeat(5000),
  '?v=1&f=' + 'telemetry=manual;'.repeat(300),
  // Extent attacks
  '?v=1&e=NaN,41.5,-111.5,42.0',
  '?v=1&e=-112.5,41.5,-111.5', // too few
  '?v=1&e=-112.5,41.5,-111.5,42.0,9.9', // too many
  '?v=1&e=999,999,999,999',
  '?v=1&e=-180,-90,180,90', // whole world is valid but degenerate
  '?v=1&e=-111.5,41.5,-112.5,42.0', // west > east
  '?v=1&e=42.0,-112.5,41.5,-111.5', // axis-swapped
  '?v=1&e=' + encodeURIComponent('1e309,1e309,1e309,1e309'), // Infinity
  // Site attacks
  '?v=1&s=<script>alert(1)</script>',
  '?v=1&s=' + 'x'.repeat(5000),
  '?v=1&s=%00%01%02',
  '?v=1&s=sta-bear-corinne%00',
  // Mixed/odd encodings
  '?v=1&s=%E2%80%AE-sta-bear-corinne', // RTL override
  '?v=1&f=siteTypeIds=%C3%28', // invalid UTF-8 percent escape
  '?v=1&f=siteTypeIds=flume&e=1,2,3,4&s=x',
  // Structural oddities
  '?v=1&f&f=&f==&e=&s=',
  '?v=1&s=&f=telemetry=',
  '?v=01&s=sta-bear-corinne', // leading-zero version still parses to 1
  '?v=1.9&s=sta-bear-corinne', // fractional version
  '?V=1&S=sta-bear-corinne', // case-sensitive keys: uppercase keys are ignored
  '?v=1&s=sta-bear-corinne&f=telemetry=unknown',
  '?v=1&f=processingLevels=raw,provisional,reviewed,best-available,supplier-reporting',
  '?v=1&f=telemetry=UNKNOWN',
];

assert.ok(hostileQueries.length >= 60, `corpus covers at least 60 hostile inputs (got ${hostileQueries.length})`);

// ---------------------------------------------------------------------------
// Replay invariants
// ---------------------------------------------------------------------------

test('parse never throws and unknown/malformed versions return null', () => {
  for (const [index, query] of hostileQueries.entries()) {
    let parsed;
    assert.doesNotThrow(() => {
      parsed = parseShareUrl(query);
    }, `parse threw for corpus[${index}]: ${query.slice(0, 80)}`);
    const versionOk = parsed === null || parsed.version === 1;
    assert.ok(versionOk, `corpus[${index}]: parsed version must be 1 or null`);
  }
  assert.equal(parseShareUrl('?v=0&f=telemetry=manual'), null);
  assert.equal(parseShareUrl('?v=2&f=telemetry=manual'), null);
  assert.equal(parseShareUrl(''), null);
});

test('no restricted id or canary survives parsing into state', () => {
  for (const [index, query] of hostileQueries.entries()) {
    const parsed = parseShareUrl(query);
    if (parsed === null) continue;
    const stateText = JSON.stringify({ filters: parsed.filters, extent: parsed.extent, selectedSiteId: parsed.selectedSiteId });
    assert.deepEqual(
      findCanaryHits(stateText),
      [],
      `corpus[${index}] leaked canary bytes into parsed state`,
    );
    for (const restrictedId of RESTRICTED_OBJECT_IDS) {
      assert.ok(
        parsed.selectedSiteId !== restrictedId && !stateText.includes(`"${restrictedId}"`),
        `corpus[${index}] selected restricted site ${restrictedId}`,
      );
    }
    for (const key of Object.keys(parsed.filters)) {
      assert.ok(DISCOVERY_DIMENSION_KEYS.includes(key), `corpus[${index}] smuggled filter dimension "${key}"`);
    }
  }
});

test('resolveShareUrl never grants an inaccessible selection and emits no leaks', () => {
  for (const [index, query] of hostileQueries.entries()) {
    const parsed = parseShareUrl(query);
    if (parsed === null) continue;
    const resolved = resolveShareUrl(parsed, PUBLIC_IDS);
    assert.ok(
      resolved.state.selectedSiteId === null || PUBLIC_IDS.includes(resolved.state.selectedSiteId),
      `corpus[${index}] resolved to an inaccessible site`,
    );
    const text = JSON.stringify(resolved);
    assert.deepEqual(findCanaryHits(text), [], `corpus[${index}] canary bytes in resolved notices`);
    for (const restrictedId of RESTRICTED_OBJECT_IDS) {
      assert.ok(!text.includes(`"${restrictedId}"`), `corpus[${index}] restricted id in resolved output`);
    }
    // Every resolved state must re-serialize into a bounded, clean URL.
    const rebuilt = buildShareUrl(resolved.state, { publicSiteIds: PUBLIC_IDS });
    assert.ok(rebuilt.url.length <= MAX_SHARE_URL_LENGTH, `corpus[${index}] rebuilt URL exceeded the cap`);
    assert.deepEqual(findCanaryHits(rebuilt.url), [], `corpus[${index}] canary bytes in rebuilt URL`);
    for (const restrictedId of RESTRICTED_OBJECT_IDS) {
      assert.ok(!rebuilt.url.includes(restrictedId), `corpus[${index}] restricted id in rebuilt URL`);
    }
    assert.ok(!rebuilt.url.toLowerCase().includes('%3cscript'), 'script fragment in rebuilt URL');
  }
});

test('parse(resolve(build(x))) round trip is byte-stable across the corpus', () => {
  const random = mulberry32(0x5e5d_1111);
  const dimensions = DISCOVERY_DIMENSION_KEYS;
  for (let i = 0; i < 40; i += 1) {
    const filters = { [pick(random, dimensions)]: [pick(random, ['manual', 'telemetered', 'unknown', 'flume', 'weir', 'sys-bear-river', 'hourly'])] };
    const state = {
      filters,
      extent: { west: -112.5 + random(), south: 41.4 + random(), east: -111.4 + random(), north: 41.9 + random() },
      selectedSiteId: pick(random, [...PUBLIC_IDS, null, 'sta-hyrum-diversion-owner']),
    };
    const built = buildShareUrl(state, { publicSiteIds: PUBLIC_IDS });
    const serialized = serializeFilters(built.state.filters);
    const reparsed = parseShareUrl(`?${built.url}`);
    assert.notEqual(reparsed, null);
    assert.equal(serializeFilters(reparsed.filters), serialized, `round trip ${i}: serialization not byte-stable`);
  }
});

test('canonicalizeFilters is idempotent and bounded under hostile input', () => {
  const random = mulberry32(0xcafe_0001);
  for (let i = 0; i < 60; i += 1) {
    const dimension = pick(random, DISCOVERY_DIMENSION_KEYS);
    const values = Array.from({ length: 1 + Math.floor(random() * 60) }, () =>
      pick(random, ['manual', 'unknown', 'flume', 'does-not-exist', 'FREE TEXT HERE', '4471-CDX', 'x'.repeat(200), '', 'UPPER-case', 'sta-hyrum-diversion-owner', '../../etc/passwd']),
    );
    const first = canonicalizeFilters({ [dimension]: values });
    const second = canonicalizeFilters(first.filters);
    assert.deepEqual(second.filters, first.filters, `iteration ${i}: canonicalization not idempotent for ${dimension}`);
    const kept = first.filters[dimension] ?? [];
    assert.ok(kept.length <= 48, `iteration ${i}: cardinality cap exceeded`);
    for (const value of kept) {
      assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(value), `iteration ${i}: non-governed shape "${value}" kept`);
      assert.ok(!RESTRICTED_OBJECT_IDS.includes(value), `iteration ${i}: restricted id kept as a filter value`);
    }
  }
});

test('canary values supplied as filter inputs are redacted with a reason, never kept', () => {
  for (const canary of CANARY_BYTES) {
    for (const dimension of ['siteTypeIds', 'providerIds', 'telemetry']) {
      const result = canonicalizeFilters({ [dimension]: [canary, 'flume'] });
      const kept = result.filters[dimension] ?? [];
      assert.ok(!kept.includes(canary), `canary "${canary.slice(0, 16)}" kept in ${dimension}`);
      assert.ok(result.redactions.length > 0, `canary "${canary.slice(0, 16)}" redacted silently in ${dimension}`);
    }
  }
});
