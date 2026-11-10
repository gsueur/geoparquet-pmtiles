// Timeline of the range requests hyparquet makes to read one run of pages, 11 columns, from production
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
const url = process.argv[2] || "https://geoparquet-demo.geomermaids.com/data/massgis-parcels.parquet";
const size = Number((await fetch(url, { method: "HEAD" })).headers.get("content-length"));
const t0 = performance.now(); const log = [];
const file = { byteLength: size, async slice(s, e) { const a = performance.now() - t0; const r = await fetch(url, { headers: { Range: `bytes=${s}-${(e ?? size) - 1}` } }); const b = await r.arrayBuffer(); log.push([Math.round(a), Math.round(performance.now() - t0), b.byteLength]); return b; } };
const md = await parquetMetadataAsync(file, { initialFetchSize: 1 << 20 });
const t1 = performance.now() - t0; log.length = 0;
const cols = ["LOC_ID", "MAP_PAR_ID", "POLY_TYPE", "TOWN_ID", "MAP_NO", "SOURCE", "PLAN_ID", "LAST_EDIT", "BND_CHK", "NO_MATCH", "SHAPE_Area", "bbox"];
const s = performance.now() - t0;
await parquetReadObjects({ file, metadata: md, columns: cols, rowStart: 60 * 16384 + 1024, rowEnd: 60 * 16384 + 2560, useOffsetIndex: true, compressors });
console.log("footer ms", Math.round(t1), "| read ms", Math.round(performance.now() - t0 - s), "requests", log.length);
console.log(log.map(([a, b, n]) => `${a - Math.round(s)}-${b - Math.round(s)}ms ${n}B`).join("  "));
