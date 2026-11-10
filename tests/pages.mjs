// Which pages a Boston z14 view (3x3 tiles) selects, and their geometry bytes: regular vs large-parcel rows
import { parquetMetadataAsync, asyncBufferFromFile, readColumnIndex, readOffsetIndex } from "hyparquet";
import proj4 from "proj4";
proj4.defs("EPSG:26986", "+proj=lcc +lat_0=41 +lon_0=-71.5 +lat_1=42.6833333333333 +lat_2=41.7166666666667 +x_0=200000 +y_0=750000 +ellps=GRS80 +units=m +no_defs");
const toLL = proj4("EPSG:26986", "EPSG:4326").forward;
const f = await asyncBufferFromFile(process.argv[2] || "data/parcels.parquet");
const md = await parquetMetadataAsync(f, { initialFetchSize: 2 << 20 });
const bigStart = 2197531 - 46793;
const n = 2 ** 14, lon = (x) => (x / n) * 360 - 180, lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
const view = [lon(4956), lat(6062), lon(4959), lat(6059)];
const ov = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const box = (x0, y0, x1, y1) => { const p = [[x0, y0], [x1, y1], [x0, y1], [x1, y0]].map(toLL); return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]; };
const bi = md.schema.findIndex((e) => e.name === "bbox"); const leaf = ["xmin", "ymin", "xmax", "ymax"].map((k) => md.schema.slice(bi + 1, bi + 5).find((e) => e.name === k));
let start = 0; const acc = { regular: [0, 0], large: [0, 0] };
for (const rg of md.row_groups) {
  const cols = ["xmin", "ymin", "xmax", "ymax"].map((k) => rg.columns.find((c) => c.meta_data.path_in_schema.join(".") === "bbox." + k));
  const g = rg.columns.find((c) => c.meta_data.path_in_schema[0] === "geometry");
  const ci = await Promise.all(cols.map(async (c, k) => readColumnIndex({ view: new DataView(await f.slice(Number(c.column_index_offset), Number(c.column_index_offset) + c.column_index_length)), offset: 0 }, leaf[k])));
  const pl = readOffsetIndex({ view: new DataView(await f.slice(Number(g.offset_index_offset), Number(g.offset_index_offset) + g.offset_index_length)), offset: 0 }).page_locations;
  pl.forEach((p, i) => {
    if (!ov(box(ci[0].min_values[i], ci[1].min_values[i], ci[2].max_values[i], ci[3].max_values[i]), view)) return;
    const k = start + Number(p.first_row_index) >= bigStart ? "large" : "regular";
    acc[k][0]++; acc[k][1] += p.compressed_page_size;
  });
  start += Number(rg.num_rows);
}
console.log("view", view.map((v) => v.toFixed(4)).join(","), JSON.stringify(acc));
