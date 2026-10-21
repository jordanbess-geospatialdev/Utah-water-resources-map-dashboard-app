/**
 * Share-URL codec tests (FR-008, T-10): versioned round trips, hostile
 * inputs, the no-persona/no-credential guarantee, restricted-site
 * omitted-with-notice behavior, unknown-vocabulary inspectability, extent
 * validation and the length cap.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/discovery/shareUrl.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { DiscoveryFilterSet } from './filters';
import type { DiscoveryShareState } from './shareUrl';
void ({} as DiscoveryShareState | DiscoveryFilterSet);

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const sharePath = './shareUrl.ts';
const s: typeof import('./shareUrl') = await import(sharePath);
const filtersPath = './filters.ts';
const f: typeof import('./filters') = await import(filtersPath);

const PUBLIC_SITES = ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];

const representative: Readonly<Partial<DiscoveryShareState>> = {
  filters: {
    distributionSystemIds: ['sys-bear-river'],
    siteTypeIds: ['flume', 'weir'],
    telemetry: ['manual', 'unknown'],
    processingLevels: ['raw'],
  },
  extent: { west: -112.345678, south: 41.234567, east: -111.654321, north: 42.012345 },
  selectedSiteId: 'sta-hyrum-diversion-public',
};

test('round trip preserves filters, extent and selected public site byte-stably', () => {
  const built = s.buildShareUrl(representative, { publicSiteIds: PUBLIC_SITES });
  assert.deepEqual(built.notices, []);
  const parsed = s.parseShareUrl(`?${built.url}`)!;
  assert.ok(parsed);
  assert.deepEqual(parsed.filters, built.state.filters);
  assert.deepEqual(parsed.extent, built.state.extent);
  assert.equal(parsed.selectedSiteId, 'sta-hyrum-diversion-public');
  // Deterministic rounding: 4-decimal extents survive exactly.
  assert.deepEqual(parsed.extent, { west: -112.3457, south: 41.2346, east: -111.6543, north: 42.0123 });
  // Idempotent: serializing the parsed state reproduces the identical link.
  assert.equal(
    s.buildShareUrl({ filters: parsed.filters, extent: parsed.extent ?? s.defaultShareExtent(), selectedSiteId: parsed.selectedSiteId }, { publicSiteIds: PUBLIC_SITES }).url,
    built.url,
  );
  assert.equal(s.roundTripShareUrl(representative, { publicSiteIds: PUBLIC_SITES })!.selectedSiteId, 'sta-hyrum-diversion-public');
});

test('a bare link carries version and default extent only', () => {
  const built = s.buildShareUrl({});
  assert.deepEqual(built.state.filters, {});
  assert.equal(built.state.selectedSiteId, null);
  const parsed = s.parseShareUrl(`?${built.url}`)!;
  assert.equal(parsed.version, s.SHARE_URL_VERSION);
  assert.deepEqual(parsed.filters, {});
  assert.deepEqual(parsed.extent, built.state.extent);
  assert.ok(!built.url.includes('f='), 'no filter param when nothing is set');
  assert.ok(!built.url.includes('s='), 'no site param when nothing is selected');
});

test('missing or unknown versions parse to null, not to guesses', () => {
  assert.equal(s.parseShareUrl(''), null);
  assert.equal(s.parseShareUrl('?f=telemetry%3Dmanual'), null, 'missing version');
  assert.equal(s.parseShareUrl('?v=2&f=telemetry%3Dmanual'), null, 'future version');
  assert.equal(s.parseShareUrl('?v=99&e=-113,41,-111,43'), null);
});

test('persona, credential and other unknown keys are ignored on parse and never emitted', () => {
  const built = s.buildShareUrl(representative, { publicSiteIds: PUBLIC_SITES });
  const hostile = `${built.url}&persona=fatima&role=steward&principalId=principal-diego-steward&token=sekrit&api_key=sekrit&access_token=sekrit&gateCode=4471-CDX&view=stewardship&station=sta-bear-corinne`;
  const parsed = s.parseShareUrl(`?${hostile}`)!;
  assert.deepEqual(parsed.filters, f.canonicalizeFilters(representative.filters).filters);
  assert.equal(parsed.selectedSiteId, 'sta-hyrum-diversion-public');
  assert.ok(parsed.ignoredKeys.includes('persona'));
  assert.ok(parsed.ignoredKeys.includes('token'));
  assert.ok(parsed.ignoredKeys.includes('view'), 'viewState keys are ignored too');
  // Emission side: no sensitive substring in any built link.
  for (const link of [built.url, s.buildShareUrl({ filters: { providerIds: ['prov-dwri-telemetry'] } }).url]) {
    for (const forbidden of ['persona', 'role', 'token', 'key', 'principal', 'gateCode', '4471', 'wiring', 'credential']) {
      assert.ok(!link.includes(forbidden), `link must not carry "${forbidden}": ${link}`);
    }
  }
});

test('free text and restricted identifiers in filters are redacted before they reach the link', () => {
  const built = s.buildShareUrl({
    filters: { providerIds: ['FlumeLog 200', 'sta-hyrum-diversion-owner', 'prov-coop-manual'], waterSourceTypeIds: ['4471-CDX'] },
  });
  assert.ok(!built.url.includes('FlumeLog'));
  assert.ok(!built.url.includes('sta-hyrum-diversion-owner'));
  assert.ok(!built.url.includes('4471'));
  assert.ok(built.url.includes('prov-coop-manual'));
  assert.ok(built.notices.some((notice) => notice.kind === 'filter-value-redacted'));
});

test('a shared link for a restricted station resolves to omitted-with-notice, never a leak', () => {
  // Build side: a restricted station id is rejected outright — it must never be encoded.
  const built = s.buildShareUrl({ ...representative, selectedSiteId: 'sta-hyrum-diversion-owner' }, { publicSiteIds: PUBLIC_SITES });
  assert.equal(built.state.selectedSiteId, null);
  assert.ok(!built.url.includes('sta-hyrum-diversion-owner'));
  assert.ok(built.notices.some((notice) => notice.kind === 'site-rejected'));

  // Parse side: a forged link that carries the restricted id anyway.
  const forged = s.parseShareUrl('?v=1&s=sta-hyrum-diversion-owner&f=telemetry%3Dmanual')!;
  assert.equal(forged.selectedSiteId, null, 'never surfaced as a selection');
  assert.ok(forged.rejectedSiteId !== null);
  const resolved = s.resolveShareUrl(forged, PUBLIC_SITES);
  assert.equal(resolved.state.selectedSiteId, null);
  assert.ok(resolved.notices.some((notice) => notice.kind === 'site-rejected'));
  assert.ok(!JSON.stringify(resolved.state).includes('sta-hyrum-diversion-owner'));
  assert.deepEqual(resolved.state.filters, { telemetry: ['manual'] }, 'permitted filters still apply');

  // Well-formed id that is simply not in this session's public catalog: omitted with notice.
  const outsider = s.parseShareUrl('?v=1&s=sta-future-site')!;
  const resolvedOutsider = s.resolveShareUrl(outsider, PUBLIC_SITES);
  assert.equal(resolvedOutsider.state.selectedSiteId, null);
  assert.ok(resolvedOutsider.notices.some((notice) => notice.kind === 'site-omitted'));
});

test('unknown vocabulary in a link stays inspectable and distinguishable', () => {
  const built = s.buildShareUrl({ filters: { siteTypeIds: ['flume', 'future-site-type'] } });
  assert.ok(built.url.includes('future-site-type'), 'well-formed unknown values survive the link');
  const parsed = s.parseShareUrl(`?${built.url}`)!;
  assert.deepEqual(parsed.unknownValues, { siteTypeIds: ['future-site-type'] });
  const resolved = s.resolveShareUrl(parsed, PUBLIC_SITES);
  assert.deepEqual(resolved.state.filters, { siteTypeIds: ['flume', 'future-site-type'] });
  assert.ok(resolved.notices.some((notice) => notice.kind === 'unknown-filter-value' && /data dictionary/.test(notice.message)));
});

test('overlong and malformed values cannot inflate or break the link', () => {
  const overlong = `${'x'.repeat(60)}`;
  const parsed = s.parseShareUrl(`?v=1&f=siteTypeIds%3D${overlong}%2Cflume%3BproviderIds%3D${'y'.repeat(5000)}`)!;
  assert.deepEqual(parsed.filters, { siteTypeIds: ['flume', overlong] }, 'the 5000-char value is rejected, the link still parses');
  assert.ok(parsed.redactions.some((redaction) => redaction.reason === 'free-text' && redaction.value.endsWith('…')));
});

test('the length cap sheds whole dimensions with a notice instead of an unusable link', () => {
  const bulk = Array.from({ length: 40 }, (_, index) => `unknown-vocabulary-value-${String(index).padStart(2, '0')}-${'z'.repeat(30)}`);
  const built = s.buildShareUrl({ filters: { siteTypeIds: bulk, providerIds: ['prov-dwri-telemetry'] } });
  assert.ok(built.url.length <= s.MAX_SHARE_URL_LENGTH, `url must be capped (${built.url.length} > ${s.MAX_SHARE_URL_LENGTH})`);
  assert.ok(built.notices.some((notice) => notice.kind === 'filters-dropped-for-length'));
});

test('invalid extents fall back to the default extent with notices on both sides', () => {
  const swapped = s.buildShareUrl({ extent: { west: -111, south: 42, east: -112, north: 41 } });
  assert.ok(swapped.notices.some((notice) => notice.kind === 'extent-invalid'));
  assert.deepEqual(swapped.state.extent, s.defaultShareExtent());
  assert.equal(s.isValidExtent({ west: 999, south: 41, east: -111, north: 43 }), false);
  assert.equal(s.isValidExtent({ west: -112.3, south: 41.2, east: -111.6, north: 42.1 }), true);
  assert.equal(s.canonicalizeExtent({ west: Number.NaN, south: 41, east: -111, north: 43 }), null);

  const parsed = s.parseShareUrl('?v=1&e=not,numeric,at,all')!;
  assert.equal(parsed.extent, null);
  const parsedRange = s.parseShareUrl('?v=1&e=999,1,2,3')!;
  assert.equal(parsedRange.extent, null);
  const resolved = s.resolveShareUrl(parsedRange, PUBLIC_SITES);
  assert.deepEqual(resolved.state.extent, s.defaultShareExtent());
  assert.ok(resolved.notices.some((notice) => notice.kind === 'extent-invalid'));
});

test('the default extent frames the public catalog', () => {
  const extent = s.defaultShareExtent();
  for (const station of f.publicDiscoveryStations) {
    assert.ok(station.longitude >= extent.west && station.longitude <= extent.east, `${station.id} lon inside extent`);
    assert.ok(station.latitude >= extent.south && station.latitude <= extent.north, `${station.id} lat inside extent`);
  }
});

test('property: build→parse→build is a stable round trip across the dimension inventory', () => {
  const inventory: { filters: DiscoveryFilterSet }[] = [];
  const samples: readonly string[][] = [
    [], // absent dimension
    ['flume'],
    ['flume', 'weir'], // OR within
    ['unknown'], // sentinel: unset, never "no constraint"
    ['future-site-type'], // unknown vocabulary
  ];
  const dimensions: (keyof DiscoveryFilterSet)[] = ['siteTypeIds', 'telemetry', 'subgroupIds', 'processingLevels', 'observedPropertyIds'];
  // Cartesian product of the first three sample sets across five dimensions (243 states) keeps the suite fast.
  const indexes = [0, 1, 2, 3, 4];
  for (const a of indexes) {
    for (const b of indexes) {
      for (const c of indexes) {
        for (const d of indexes) {
          for (const e of indexes) {
            const filters: Record<string, unknown> = {};
            const chosen = [a, b, c, d, e];
            dimensions.forEach((dimension, index) => {
              const values = samples[chosen[index]!]!;
              if (values.length > 0) filters[dimension] = values;
            });
            inventory.push({ filters: filters as DiscoveryFilterSet });
          }
        }
      }
    }
  }
  const sites = [null, 'sta-bear-corinne', 'sta-future-site'] as const;
  let checked = 0;
  for (let index = 0; index < inventory.length; index += 7) {
    const filtersState = inventory[index]!;
    const selectedSiteId = sites[index % sites.length]!;
    const built = s.buildShareUrl({ ...filtersState, extent: { west: -112.5 + index * 0.001, south: 41.1, east: -111.5 + index * 0.001, north: 42.2 }, selectedSiteId }, { publicSiteIds: PUBLIC_SITES });
    assert.ok(built.url.length <= s.MAX_SHARE_URL_LENGTH);
    const parsed = s.parseShareUrl(`?${built.url}`)!;
    assert.ok(parsed, `round trip failed for state ${index}`);
    assert.deepEqual(parsed.filters, built.state.filters, `filters diverged for state ${index}`);
    assert.deepEqual(parsed.extent, built.state.extent, `extent diverged for state ${index}`);
    assert.equal(parsed.selectedSiteId, built.state.selectedSiteId, `site diverged for state ${index}`);
    assert.equal(
      s.buildShareUrl({ filters: parsed.filters, extent: parsed.extent ?? s.defaultShareExtent(), selectedSiteId: parsed.selectedSiteId }, { publicSiteIds: PUBLIC_SITES }).url,
      built.url,
      `serialization not idempotent for state ${index}`,
    );
    checked++;
  }
  assert.ok(checked > 30, `property loop covered a meaningful sample (${checked})`);
});
