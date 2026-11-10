// Builds detail vector tiles from the GeoParquet rows of a baked file, so the full geometry
// is stored once. For a tile: pick the row groups whose bbox statistics overlap it, decode
// them once (cached), reproject to lon/lat, clip and simplify to the tile, encode MVT.
import { parquetMetadataAsync, parquetReadObjects, readColumnIndex, readOffsetIndex } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { geoJSONToTile } from "@maplibre/geojson-vt";
import { fromGeojsonVt } from "@maplibre/vt-pbf";
import proj4 from "proj4";

let md, toLonLat, groups, layer, props;
const cache = new Map(); // first row of a range -> Promise<features>
const CACHE_MAX = 400;
let leaf; // schema elements of bbox.xmin, ymin, xmax, ymax
let geomCol = "geometry";
let rowsEnd = Infinity; // primary geometry column, from the geo metadata
const bytes = { footer: [0, 0], detail: [0, 0], pick: [0, 0] };
let fileDetail, filePick, toNative;

function rangeBuffer(url, byteLength, kind) {
  return {
    byteLength,
    async slice(start, end) {
      const r = await fetch(url, { cache: "no-store", headers: { Range: `bytes=${start}-${(end ?? byteLength) - 1}` } });
      const b = await r.arrayBuffer();
      bytes[kind][0]++; bytes[kind][1] += b.byteLength;
      postMessage({ type: "bytes", bytes });
      return b;
    },
  };
}

const stat = (rg, name) => rg.columns.find((c) => c.meta_data.path_in_schema.join(".") === name).meta_data.statistics;

function lonLatBox(xmin, ymin, xmax, ymax) {
  const pts = [[xmin, ymin], [xmin, ymax], [xmax, ymin], [xmax, ymax], [(xmin + xmax) / 2, ymin], [(xmin + xmax) / 2, ymax]].map((p) => toLonLat(p));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

async function init(msg) {
  md = await parquetMetadataAsync(rangeBuffer(msg.url, msg.size, "footer"), { initialFetchSize: msg.footerLen + 8 });
  fileDetail = rangeBuffer(msg.url, msg.size, "detail");
  filePick = rangeBuffer(msg.url, msg.size, "pick");
  const geo = JSON.parse(md.key_value_metadata.find((k) => k.key === "geo").value);
  geomCol = geo.primary_column;
  const col = geo.columns[geomCol];
  const code = col.crs?.id ? `${col.crs.id.authority}:${col.crs.id.code}` : "EPSG:4326";
  if (msg.proj4) proj4.defs(code, msg.proj4);
  const p = proj4(code, "EPSG:4326");
  toLonLat = (c) => p.forward(c);
  toNative = (c) => p.inverse(c);
  const bi = md.schema.findIndex((e) => e.name === "bbox");
  leaf = ["xmin", "ymin", "xmax", "ymax"].map((n) => md.schema.slice(bi + 1, bi + 5).find((e) => e.name === n));
  layer = msg.layer;
  rowsEnd = msg.rows ? msg.rows[1] : Infinity; // rows after this are drawn from the baked tiles
  props = msg.properties;
  let start = 0;
  groups = md.row_groups.map((rg) => {
    const n = Number(rg.num_rows);
    const native = [stat(rg, "bbox.xmin").min_value, stat(rg, "bbox.ymin").min_value, stat(rg, "bbox.xmax").max_value, stat(rg, "bbox.ymax").max_value];
    const g = { start, end: start + n, native, box: lonLatBox(...native) };
    start += n;
    return g;
  });
  return { rowGroups: groups.length };
}

const reproject = (coords, box) => {
  if (typeof coords[0] !== "number") return coords.map((c) => reproject(c, box));
  const p = toLonLat(coords);
  if (p[0] < box[0]) box[0] = p[0]; if (p[1] < box[1]) box[1] = p[1];
  if (p[0] > box[2]) box[2] = p[0]; if (p[1] > box[3]) box[3] = p[1];
  return p;
};

// Pages of a row group with their bbox, from the page index. Two reads per row group: the
// column index of the four bbox columns, and the offset index of every column (one span), which
// is handed to hyparquet so page reads need no further index requests. Null without a page index.
const pageCache = new Map();
const pageLocationsByGroup = [];
function pagesOf(i) {
  if (!pageCache.has(i)) pageCache.set(i, (async () => {
    const rg = md.row_groups[i];
    const cols = ["xmin", "ymin", "xmax", "ymax"].map((n) => rg.columns.find((c) => c.meta_data.path_in_schema.join(".") === "bbox." + n));
    if (rg.columns.some((c) => !c.offset_index_length) || cols.some((c) => !c.column_index_length)) return null;
    const ciStart = Math.min(...cols.map((c) => Number(c.column_index_offset)));
    const ciEnd = Math.max(...cols.map((c) => Number(c.column_index_offset) + c.column_index_length));
    const oiStart = Math.min(...rg.columns.map((c) => Number(c.offset_index_offset)));
    const oiEnd = Math.max(...rg.columns.map((c) => Number(c.offset_index_offset) + c.offset_index_length));
    const [ci, oi] = await Promise.all([fileDetail.slice(ciStart, ciEnd), fileDetail.slice(oiStart, oiEnd)]);
    const idx = cols.map((c, k) => readColumnIndex({ view: new DataView(ci), offset: Number(c.column_index_offset) - ciStart }, leaf[k]));
    const locs = {};
    for (const c of rg.columns) locs[c.meta_data.path_in_schema.join(".")] = readOffsetIndex({ view: new DataView(oi), offset: Number(c.offset_index_offset) - oiStart }).page_locations;
    pageLocationsByGroup[i] = locs;
    const firsts = locs["bbox.xmin"].map((p) => Number(p.first_row_index));
    const g = groups[i];
    return firsts.map((first, p) => {
      const native = [idx[0].min_values[p], idx[1].min_values[p], idx[2].max_values[p], idx[3].max_values[p]];
      return { start: g.start + first, end: g.start + (firsts[p + 1] ?? g.end - g.start), box: lonLatBox(...native), native };
    });
  })());
  return pageCache.get(i);
}

// Consecutive row ranges merged into runs: one request per column per run
function runsOf(ranges) {
  const runs = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = runs[runs.length - 1];
    if (last && last.end === r[0]) { last.end = r[1]; last.parts.push(r); } else runs.push({ start: r[0], end: r[1], parts: [r] });
  }
  return runs;
}

const readRows = (file, columns, start, end) =>
  parquetReadObjects({ file, metadata: md, columns, rowStart: start, rowEnd: end, pageLocationsByGroup, useOffsetIndex: true, compressors });

const toFeature = (r) => {
  const properties = {};
  for (const k of props) if (r[k] != null) properties[k] = typeof r[k] === "bigint" ? Number(r[k]) : r[k];
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const g = r[geomCol];
  const coordinates = reproject(g.coordinates, box);
  return { type: "Feature", properties, geometry: { type: g.type, coordinates }, box };
};

// Decoded features per page (cache key: first row), fetched in runs of neighbouring pages
function loadRanges(ranges) {
  const missing = ranges.filter(([a]) => !cache.has(a));
  for (const run of runsOf(missing)) {
    const rows = readRows(fileDetail, [geomCol, ...props], run.start, run.end);
    for (const [a, b] of run.parts)
      cache.set(a, rows.then((rs) => rs.slice(a - run.start, b - run.start).filter((r) => r[geomCol]).map(toFeature)));
  }
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return Promise.all(ranges.map(([a]) => { const p = cache.get(a); cache.delete(a); cache.set(a, p); return p; }));
}

// Row ranges overlapping a lon/lat box: pages when the file has a page index, else row groups
async function rangesIn(box) {
  const hit = groups.map((g, i) => (g.start < rowsEnd && overlaps(g.box, box) ? i : -1)).filter((i) => i >= 0);
  const out = [];
  for (const [k, pages] of (await Promise.all(hit.map(pagesOf))).entries()) {
    if (!pages) { out.push([groups[hit[k]].start, Math.min(groups[hit[k]].end, rowsEnd)]); continue; }
    for (const p of pages) if (p.start < rowsEnd && overlaps(p.box, box)) out.push([p.start, Math.min(p.end, rowsEnd)]);
  }
  return { ranges: out, rowGroups: hit.length };
}

function tileBox(z, x, y, pad) {
  const n = 2 ** z;
  const lon = (x) => (x / n) * 360 - 180;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon(x - pad), lat(y + 1 + pad), lon(x + 1 + pad), lat(y - pad)];
}

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function tile({ z, x, y }) {
  const t0 = performance.now();
  const box = tileBox(z, x, y, 64 / 4096);
  const { ranges, rowGroups } = await rangesIn(box);
  const features = [];
  for (const fs of await loadRanges(ranges)) for (const f of fs) if (overlaps(f.box, box)) features.push(f);
  const t = geoJSONToTile({ type: "FeatureCollection", features }, z, x, y, { clip: true, maxZoom: z, extent: 4096, buffer: 64, tolerance: 3 });
  const pbf = fromGeojsonVt({ [layer]: t }, { version: 2, extent: 4096 });
  const data = pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength);
  const rowsRead = ranges.reduce((n, [a, b]) => n + b - a, 0);
  return { data, rowGroups, pages: ranges.length, rowsRead, features: features.length, ms: Math.round(performance.now() - t0) };
}

// Attribute rows at a point, read from the row groups whose bbox statistics contain it
async function pick({ lng, lat, columns }) {
  const t0 = performance.now();
  const [x, y] = toNative([lng, lat]);
  const inside = (b) => b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];
  const hit = groups.map((g, i) => (inside(g.native) ? i : -1)).filter((i) => i >= 0);
  const ranges = [];
  for (const [k, pages] of (await Promise.all(hit.map(pagesOf))).entries()) {
    if (!pages) ranges.push([groups[hit[k]].start, groups[hit[k]].end]);
    else for (const p of pages) if (inside(p.native)) ranges.push([p.start, p.end]);
  }
  const rows = [];
  const read = await Promise.all(runsOf(ranges).map((run) => readRows(filePick, [...columns, "bbox"], run.start, run.end)));
  for (const rs of read) for (const r of rs) if (inside([r.bbox.xmin, r.bbox.ymin, r.bbox.xmax, r.bbox.ymax])) { delete r.bbox; rows.push(r); }
  return { rows, rowGroups: hit.length, pages: ranges.length, totalRowGroups: groups.length, ms: Math.round(performance.now() - t0) };
}

onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const out = type === "init" ? await init(e.data) : type === "pick" ? await pick(e.data) : await tile(e.data);
    postMessage({ id, ok: true, ...out }, out.data ? [out.data] : []);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err?.stack || err) });
  }
};
