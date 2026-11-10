// Reader for a GeoParquet file with an embedded PMTiles archive (see bake.py).
// The map side needs one 64 KB read of the file's end to find the archive; the full
// Parquet footer is only fetched when attributes are asked for.
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const TAIL = 65536;
const enc = new TextEncoder();
const NEEDLE = enc.encode("\x07pmtiles"); // thrift binary: varint length 7 + key

const varint = (b, i) => {
  let out = 0, shift = 0;
  for (;;) { const x = b[i++]; out += (x & 0x7f) * 2 ** shift; if (!(x & 0x80)) return [out, i]; shift += 7; }
};

function findPmtilesEntry(tail) {
  // The pmtiles KeyValue is the last entry of key_value_metadata, near the end of the footer.
  for (let i = tail.length - NEEDLE.length; i >= 0; i--) {
    let hit = true;
    for (let j = 0; j < NEEDLE.length; j++) if (tail[i + j] !== NEEDLE[j]) { hit = false; break; }
    if (!hit) continue;
    let p = i + NEEDLE.length;
    if ((tail[p] & 0x0f) !== 8) continue; // next field must be a binary (the value)
    p++;
    const [len, start] = varint(tail, p);
    try { return JSON.parse(new TextDecoder().decode(tail.subarray(start, start + len))); } catch { /* not ours */ }
  }
  return null;
}

export async function openBaked(url) {
  const r = await fetch(url, { headers: { Range: `bytes=-${TAIL}` } });
  if (r.status !== 206) throw new Error(`range request refused (${r.status})`);
  const size = Number(r.headers.get("Content-Range").split("/")[1]);
  const tail = new Uint8Array(await r.arrayBuffer());
  const footerLen = new DataView(tail.buffer).getUint32(tail.length - 8, true);
  if (new TextDecoder().decode(tail.subarray(tail.length - 4)) !== "PAR1") throw new Error("not a Parquet file");
  let tiles = findPmtilesEntry(tail);
  let metadata = null;
  if (!tiles) { // entry not in the last 64 KB: parse the whole footer
    metadata = await parquetMetadataAsync(rangeBuffer(url, size), { initialFetchSize: footerLen + 8 });
    const kv = (metadata.key_value_metadata || []).find((k) => k.key === "pmtiles");
    tiles = kv ? JSON.parse(kv.value) : null;
  }
  return { url, size, footerLen, tiles, metadata };
}

// pmtiles.js Source reading the archive at its offset inside the Parquet file
export class EmbeddedSource {
  constructor(url, offset) { this.url = url; this.offset = offset; this.inner = new pmtiles.FetchSource(url); }
  getKey() { return this.url; }
  getBytes(offset, length, signal, etag) { return this.inner.getBytes(this.offset + offset, length, signal, etag); }
}

export function rangeBuffer(url, byteLength) {
  return {
    byteLength,
    async slice(start, end) {
      const r = await fetch(url, { cache: "no-store", headers: { Range: `bytes=${start}-${(end ?? byteLength) - 1}` } });
      return r.arrayBuffer();
    },
  };
}

// Rows whose bbox contains point (x, y in the file's CRS), reading only the row groups
// whose bbox statistics can contain it, and only the columns asked for.
export async function rowsAtPoint(file, x, y, columns) {
  if (!file.metadata) file.metadata = await parquetMetadataAsync(rangeBuffer(file.url, file.size), { initialFetchSize: file.footerLen + 8 });
  const md = file.metadata;
  const buf = rangeBuffer(file.url, file.size);
  const stat = (rg, name) => rg.columns.find((c) => c.meta_data.path_in_schema.join(".") === name).meta_data.statistics;
  const out = [];
  let rowStart = 0, scanned = 0;
  for (const rg of md.row_groups) {
    const n = Number(rg.num_rows);
    const xmin = stat(rg, "bbox.xmin").min_value, xmax = stat(rg, "bbox.xmax").max_value;
    const ymin = stat(rg, "bbox.ymin").min_value, ymax = stat(rg, "bbox.ymax").max_value;
    if (xmin <= x && x <= xmax && ymin <= y && y <= ymax) {
      scanned++;
      const rows = await parquetReadObjects({ file: buf, metadata: md, columns: [...columns, "bbox"], rowStart, rowEnd: rowStart + n, compressors });
      for (const r of rows) if (r.bbox.xmin <= x && x <= r.bbox.xmax && r.bbox.ymin <= y && y <= r.bbox.ymax) out.push(r);
    }
    rowStart += n;
  }
  return { rows: out, rowGroups: scanned, totalRowGroups: md.row_groups.length };
}
