// Static server with HTTP Range support (single ranges, including suffix ranges "bytes=-N"),
// like R2 or S3 would answer. /data/* is served from DATA, the rest from this folder.
//   DATA=./data node server.mjs   -> http://localhost:8790/web/
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const DATA = resolve(process.env.DATA || "data");
const PORT = Number(process.env.PORT || 8790);
// public names (as on geoparquet-demo.geomermaids.com) -> local files
const ALIAS = { "massgis-parcels.parquet": "parcels.parquet", "clc-2018.parquet": "clcwork/demo.parquet" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".parquet": "application/vnd.apache.parquet", ".pmtiles": "application/vnd.pmtiles" };

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const base = path.startsWith("/data/") ? DATA : ROOT;
  const rel = path.startsWith("/data/") ? path.slice(6) : path;
  const file = normalize(join(base, path.startsWith("/data/") ? (ALIAS[rel] || rel) : rel));
  if (!file.startsWith(base)) return res.writeHead(403).end();
  let st;
  try { st = statSync(file); if (!st.isFile()) throw 0; } catch { return res.writeHead(404).end("not found"); }
  const head = { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, ETag", "ETag": `"${st.size}-${st.mtimeMs}"`, "Cache-Control": "no-cache" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (!m) {
    res.writeHead(200, { ...head, "Content-Length": st.size });
    return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
  }
  let start, end;
  if (m[1] === "") { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? st.size - 1 : Math.min(Number(m[2]), st.size - 1); }
  if (start > end || start >= st.size) return res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
  res.writeHead(206, { ...head, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}` });
  if (process.env.LOG) console.log(path, start, end - start + 1);
  req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/web/  (data: ${DATA})`));
