#!/usr/bin/env node
// =============================================================================
// WD-005 NeoServer QUALIFICATION CAPTURE SCRIPT (zero dependencies).
//
// Fetches and records the protocol evidence whose checklist lives in
// qualification/recorded/EXPECTATIONS.md:
//   - OGC API - Features: landing, conformance, OpenAPI, collections,
//     collection, items page 1 + followed `next` links (paging)
//   - OGC API - Tiles: TileJSON + one MVT tile for the Utah control station
//     (decoded HEADER check only: gzip magic + protobuf layer name)
//   - WFS 2.0: GetCapabilities + GetFeature with EXPLICIT GeoJSON output
//   - WMS 1.3.0: GetCapabilities + one GetMap in EPSG:3857
//   - negative controls: cohort workspace without its credential must NOT
//     reveal private content; the management API must not answer anonymously
//
// Everything lands in infra/neoserver/qualification/recorded/ with a
// manifest of URLs, timestamps and sha256s. Exits non-zero if any required
// capture or check fails. NEVER prints or records credential VALUES (header
// names only).
//
// Usage:
//   node infra/neoserver/qualification/capture.mjs \
//     [--base-url http://localhost:9000] \
//     [--workspace water-public] [--layer stations] \
//     [--cohort-workspace water-bear-cohort] [--cohort-layer stations-restricted] \
//     [--credential-env NEOSERVER_QUALIFICATION_API_KEY] \
//     [--out infra/neoserver/qualification/recorded] [--max-pages 3]
//
// STATUS: AUTHORED, EXECUTION PENDING - this environment has no Docker
// daemon and no live NeoServer. Do not fabricate output: run it against the
// compose stack when one exists.
// =============================================================================
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- arguments ---------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE_URL = arg('base-url', process.env.NEOSERVER_BASE_URL ?? 'http://localhost:9000').replace(/\/+$/, '');
const WORKSPACE = arg('workspace', 'water-public');
const LAYER = arg('layer', 'stations');
const COHORT_WORKSPACE = arg('cohort-workspace', 'water-bear-cohort');
const COHORT_LAYER = arg('cohort-layer', 'stations-restricted');
const CREDENTIAL_ENV = arg('credential-env', 'NEOSERVER_QUALIFICATION_API_KEY');
const OUT_DIR = arg('out', join(HERE, 'recorded'));
const MAX_PAGES = Number(arg('max-pages', '3'));

// The service credential comes ONLY from this environment reference.
const CREDENTIAL = process.env[CREDENTIAL_ENV];
if (!CREDENTIAL) {
  console.error(`[capture] environment variable ${CREDENTIAL_ENV} (viewer-role stored API key) is not set; refusing to run half-qualified`);
  process.exit(2);
}
const authHeaders = { 'X-API-Key': CREDENTIAL };

// --- Utah control points (same constants as services/geo-gateway tests) ------
// fixtures/contracts/stations.json: sta-bear-corinne.
const CONTROL = { lat: 41.6337, lon: -112.1965 };
const UTAH_LON = [-114.1, -108.9];
const UTAH_LAT = [37.0, 42.1];
const inUtah = (lat, lon) => lat >= UTAH_LAT[0] && lat <= UTAH_LAT[1] && lon >= UTAH_LON[0] && lon <= UTAH_LON[1];

// WebMercatorQuad slippy math, duplicated here ON PURPOSE so the capture
// does not validate the gateway's own implementation against itself.
const tileForLonLat = (lon, lat, z) => {
  const n = 2 ** z;
  return {
    z,
    y: Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n),
    x: Math.floor(((lon + 180) / 360) * n),
  };
};
const northWestOfTile = (z, y, x) => {
  const n = 2 ** z;
  return {
    lon: (x / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
  };
};
const to3857 = (lon, lat) => ({
  x: (6378137 * lon * Math.PI) / 180,
  y: 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
});

// --- minimal protobuf (MVT header decode only) -------------------------------
function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[pos];
    pos += 1;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(value), pos];
    shift += 7n;
  }
}
/** Decode ONLY the header facts we qualify on: first layer's version + name. */
function decodeMvtHeader(bytes) {
  let pos = 0;
  for (;;) {
    if (pos >= bytes.length) throw new Error('no Tile.layers field found');
    const [key, p1] = readVarint(bytes, pos);
    const field = key >> 3;
    const wireType = key & 7;
    pos = p1;
    if (field === 3 && wireType === 2) {
      // first Tile.layers entry
      const [len, p2] = readVarint(bytes, pos);
      const layer = bytes.subarray(p2, p2 + len);
      let lp = 0;
      let version = -1;
      let name = null;
      while (lp < layer.length) {
        const [lkey, l1] = readVarint(layer, lp);
        const lfield = lkey >> 3;
        const lwire = lkey & 7;
        lp = l1;
        if (lfield === 15 && lwire === 0) {
          const [v, lp2] = readVarint(layer, lp);
          version = v;
          lp = lp2;
        } else if (lfield === 1 && lwire === 2) {
          const [nlen, lp2] = readVarint(layer, lp);
          name = new TextDecoder().decode(layer.subarray(lp2, lp2 + nlen));
          lp = lp2 + nlen;
        } else if (lwire === 0) {
          const [, lp2] = readVarint(layer, lp);
          lp = lp2;
        } else if (lwire === 2) {
          const [nlen, lp2] = readVarint(layer, lp);
          lp = lp2 + nlen;
        } else {
          throw new Error(`unsupported layer wire type ${lwire}`);
        }
      }
      return { version, name };
    }
    if (wireType === 0) {
      const [, p2] = readVarint(bytes, pos);
      pos = p2;
    } else if (wireType === 2) {
      const [len, p2] = readVarint(bytes, pos);
      pos = p2 + len;
    } else {
      throw new Error(`unsupported tile wire type ${wireType}`);
    }
  }
}

// --- capture machinery -------------------------------------------------------
const manifest = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  workspace: WORKSPACE,
  layer: LAYER,
  credential: { scheme: 'X-API-Key', source: `env:${CREDENTIAL_ENV}`, valueRecorded: false },
  note: 'Live capture from the WD-005 qualification compose stack (see infra/neoserver/docker-compose.yml). EXPECTATIONS.md in this directory is the human checklist; entries here are the machine evidence.',
  captures: [],
};
let failures = 0;

async function capture(name, path, { headers = authHeaders, expectStatus = 200, checks = [], extension } = {}) {
  const url = `${BASE_URL}${path}`;
  const requestedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    failures += 1;
    manifest.captures.push({ name, url, requestedAt, error: String(err) });
    console.error(`FAIL ${name}: ${err}`);
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';

  const record = {
    name,
    url,
    requestedAt,
    respondedAt: new Date().toISOString(),
    status: response.status,
    contentType,
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    checks: [],
  };

  const check = (label, ok, detail = '') => {
    record.checks.push({ label, ok, detail });
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${label}${detail ? ` (${detail})` : ''}`);
  };

  if (expectStatus >= 0 && response.status !== expectStatus) {
    check(`status ${expectStatus}`, false, `got ${response.status}`);
  }
  for (const [label, ok, detail] of checks) check(label, ok, detail);

  if (buffer.byteLength > 0) {
    const ext = extension ?? (contentType.includes('json') ? 'json' : contentType.includes('xml') ? 'xml' : contentType.startsWith('image/') ? contentType.split('/')[1].split(';')[0] : 'bin');
    writeFileSync(join(OUT_DIR, `${name}.${ext}`), buffer);
    // Canary: private content must never appear in any captured artifact.
    const text = contentType.includes('json') || contentType.includes('xml') ? buffer.toString('utf8') : '';
    if (text) {
      check(
        'no private canary (SYNTHETIC-NEVER-PUBLISH / internal note / gate_code absent)',
        !text.includes('SYNTHETIC-NEVER-PUBLISH') && !text.toLowerCase().includes('internal note') && !text.toLowerCase().includes('gate_code'),
      );
    }
  }
  manifest.captures.push(record);
  return { buffer, contentType, status: response.status, record };
}

// --- run ----------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });

console.log(`[capture] base=${BASE_URL} workspace=${WORKSPACE} out=${OUT_DIR}`);

// 1-5. OGC API - Features discovery documents
const landing = await capture('ogc-landing', `/workspaces/${WORKSPACE}/ogc`, { extension: 'json' });
if (landing) {
  const okJson = landing.contentType.includes('json');
  landing.record.checks.push({ label: 'landing document is JSON', ok: okJson, detail: landing.contentType });
  if (!okJson) failures += 1;
}
await capture('ogc-conformance', `/workspaces/${WORKSPACE}/ogc/conformance`, { extension: 'json' });
await capture('ogc-openapi', `/workspaces/${WORKSPACE}/ogc/api`, { extension: 'json' });
const collections = await capture('ogc-collections', `/workspaces/${WORKSPACE}/ogc/collections`, { extension: 'json' });
if (collections) {
  const body = JSON.parse(collections.buffer.toString('utf8'));
  const listed = (body.collections ?? []).some((c) => (c.id === LAYER));
  console.log(`  ${listed ? 'ok  ' : 'WARN'} collections lists layer "${LAYER}"`);
}
await capture('ogc-collection', `/workspaces/${WORKSPACE}/ogc/collections/${LAYER}`, { extension: 'json' });

// 6. items page 1 + FOLLOWED PAGING
const page1 = await capture('ogc-items-page1', `/workspaces/${WORKSPACE}/ogc/collections/${LAYER}/items?limit=100`, { extension: 'json' });
if (page1 && page1.status === 200) {
  const body = JSON.parse(page1.buffer.toString('utf8'));
  const feats = body.features ?? [];
  if (feats.length > 0) {
    const [lon, lat] = feats[0].geometry?.coordinates ?? [];
    page1.record.checks.push({
      label: 'first feature coordinate inside the Utah envelope (GeoJSON lon,lat axis control)',
      ok: inUtah(lat, lon),
      detail: `coordinates [${lon}, ${lat}]`,
    });
    if (!inUtah(lat, lon)) failures += 1;
  }
  let next = (body.links ?? []).find((l) => l.rel === 'next')?.href ?? null;
  let page = 2;
  while (next && page <= MAX_PAGES) {
    const url = new URL(next, BASE_URL);
    const followed = await capture(`ogc-items-page${page}`, `${url.pathname}${url.search}`, { extension: 'json' });
    if (!followed || followed.status !== 200) break;
    const nb = JSON.parse(followed.buffer.toString('utf8'));
    next = (nb.links ?? []).find((l) => l.rel === 'next')?.href ?? null;
    page += 1;
  }
  console.log(`  ok   items paging followed to page ${page - 1}`);
}

// 7-8. Tiles: TileJSON then the control-station tile (header check only)
const CONTROL_TILE = tileForLonLat(CONTROL.lon, CONTROL.lat, 10);
const nw = northWestOfTile(CONTROL_TILE.z, CONTROL_TILE.y, CONTROL_TILE.x);
console.log(`[capture] control tile for ${CONTROL.lat},${CONTROL.lon} @z10 -> matrix z/y/x = ${CONTROL_TILE.z}/${CONTROL_TILE.y}/${CONTROL_TILE.x} (NW corner ${nw.lat.toFixed(3)},${nw.lon.toFixed(3)})`);
if (!inUtah(nw.lat, nw.lon)) {
  failures += 1;
  console.error(`FAIL control tile NW corner ${nw.lat},${nw.lon} is outside Utah - the computed matrix/row/column order is wrong`);
}

const tilejson = await capture(
  'tilejson',
  `/workspaces/${WORKSPACE}/ogc-tiles/collections/${LAYER}/tilejson.json`,
  { extension: 'json' },
);
let advertisedSourceLayer = null;
if (tilejson && tilejson.status === 200) {
  const body = JSON.parse(tilejson.buffer.toString('utf8'));
  advertisedSourceLayer = body.vector_layers?.[0]?.id ?? null;
  tilejson.record.checks.push({ label: 'advertises tiles[] template', ok: Array.isArray(body.tiles) && body.tiles.length > 0, detail: String(body.tiles?.[0]) });
  tilejson.record.checks.push({ label: 'advertises vector_layers[0].id (actual source-layer)', ok: advertisedSourceLayer !== null, detail: String(advertisedSourceLayer) });
  for (const c of tilejson.record.checks) if (!c.ok) failures += 1;
  // NOTE for EXPECTATIONS item 3: record whether the advertised template is
  // relative (to be resolved against the service base) or absolute.
  const template = String(body.tiles?.[0] ?? '');
  tilejson.record.checks.push({
    label: 'tile template shape recorded (relative vs absolute)',
    ok: true,
    detail: template.startsWith('http') ? 'absolute' : 'relative',
  });
}

const tile = await capture(
  'mvt-tile-control-z10',
  `/workspaces/${WORKSPACE}/ogc-tiles/collections/${LAYER}/tiles/WebMercatorQuad/${CONTROL_TILE.z}/${CONTROL_TILE.y}/${CONTROL_TILE.x}`,
  { extension: 'pbf' },
);
if (tile && tile.status === 200) {
  const bytes = tile.buffer;
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  tile.record.checks.push({ label: 'transport encoding identified (gzip magic or raw protobuf)', ok: true, detail: gzipped ? 'gzip' : 'raw' });
  try {
    const { gunzipSync } = await import('node:zlib');
    const raw = gzipped ? gunzipSync(bytes) : bytes;
    const header = decodeMvtHeader(raw);
    tile.record.checks.push({ label: 'MVT layer version 2', ok: header.version === 2, detail: `version=${header.version}` });
    tile.record.checks.push({
      label: 'decoded MVT source-layer equals TileJSON vector_layers[0].id',
      ok: advertisedSourceLayer !== null && header.name === advertisedSourceLayer,
      detail: `tile="${header.name}" tilejson="${advertisedSourceLayer}"`,
    });
    if (header.version !== 2 || header.name !== advertisedSourceLayer) failures += 1;
  } catch (err) {
    failures += 1;
    tile.record.checks.push({ label: 'MVT header decoded', ok: false, detail: String(err) });
  }
}

// 9-10. WFS
await capture('wfs-getcapabilities', `/workspaces/${WORKSPACE}/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`, { extension: 'xml' });
const wfsFeature = await capture(
  'wfs-getfeature-geojson',
  `/workspaces/${WORKSPACE}/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${LAYER}&COUNT=100&OUTPUTFORMAT=application/json`,
  { extension: 'json' },
);
if (wfsFeature && wfsFeature.status === 200) {
  const okType = wfsFeature.contentType.includes('json');
  wfsFeature.record.checks.push({ label: 'explicit OUTPUTFORMAT=application/json honored', ok: okType, detail: wfsFeature.contentType });
  if (!okType) failures += 1;
  const body = JSON.parse(wfsFeature.buffer.toString('utf8'));
  const feats = body.features ?? [];
  if (feats.length > 0) {
    const [lon, lat] = feats[0].geometry?.coordinates ?? [];
    const okAxis = inUtah(lat, lon);
    wfsFeature.record.checks.push({ label: 'WFS GeoJSON coordinate axis control (lon,lat within Utah)', ok: okAxis, detail: `coordinates [${lon}, ${lat}]` });
    if (!okAxis) failures += 1;
  }
}

// 11-12. WMS
await capture('wms-getcapabilities', `/workspaces/${WORKSPACE}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`, { extension: 'xml' });
// T-05 DEFECT FIX: the original BBOX applied a 0.5-degree inward margin to the
// Utah envelope, capping north latitude at 42.1-0.5=41.6 - but every seeded
// station sits NORTH of 41.62, so the rendered PNG was fully transparent
// (0 non-transparent pixels; see recorded/manual-probes/probes-tiles.log).
// Use the FULL envelope so the control stations are actually inside the map.
const sw = to3857(UTAH_LON[0], UTAH_LAT[0]);
const ne = to3857(UTAH_LON[1], UTAH_LAT[1]);
await capture(
  'wms-getmap-epsg3857',
  `/workspaces/${WORKSPACE}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${LAYER}&STYLES=&CRS=EPSG:3857&BBOX=${sw.x},${sw.y},${ne.x},${ne.y}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`,
  { extension: 'png', checks: [] },
).then((r) => {
  if (r && r.status === 200) {
    const ok = r.contentType.startsWith('image/');
    r.record.checks.push({ label: 'GetMap returned an image', ok, detail: r.contentType });
    if (!ok) failures += 1;
  }
});

// 13. Negative controls
await capture(
  'negative-cohort-without-credential',
  `/workspaces/${COHORT_WORKSPACE}/ogc/collections/${COHORT_LAYER}/items?limit=10`,
  { headers: {}, expectStatus: -1, extension: 'json' },
).then((r) => {
  if (!r) return;
  // expectStatus -1 = "any non-200": the cohort layer must refuse us.
  const denied = r.status === 401 || r.status === 403;
  r.record.checks.push({ label: `cohort layer denied without its credential (${COHORT_WORKSPACE}/${COHORT_LAYER})`, ok: denied, detail: `status=${r.status}` });
  // If a body came back anyway, the canary check inside capture() must have
  // found no private content.
  if (!denied) failures += 1;
});
await capture(
  'negative-management-anonymous',
  `/api/v1/workspaces`,
  { headers: {}, expectStatus: -1, extension: 'json' },
).then((r) => {
  if (!r) return;
  const denied = r.status === 401 || r.status === 403 || r.status === 404;
  r.record.checks.push({ label: 'management API does not answer anonymously', ok: denied, detail: `status=${r.status}` });
  if (!denied) failures += 1;
});

// --- manifest + exit ----------------------------------------------------------
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('');
console.log(`[capture] ${manifest.captures.length} captures written to ${OUT_DIR} (manifest.json)`);
if (failures > 0) {
  console.error(`[capture] FAILED: ${failures} check(s) failed - qualification NOT met`);
  process.exit(1);
}
console.log('[capture] all captures and checks passed - evidence recorded; complete the human checklist in EXPECTATIONS.md');
